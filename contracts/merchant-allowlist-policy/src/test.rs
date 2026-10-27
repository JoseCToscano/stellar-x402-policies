extern crate std;

use std::string::ToString;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Events, Ledger},
    xdr::{ContractEventBody, ScVal},
    Address, Env, IntoVal, Map, String, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::logic::{
    enforce, event_topic_is_balance_moving, get_remaining, install, published_event_names,
    remove_merchant, resolve_merchant_key, set_merchant, MerchantAllowlistParams, MerchantError,
    MerchantLimit, MerchantResolution, MAX_HISTORY_ENTRIES,
};

#[contract]
struct MockContract;

fn rule(e: &Env, token: &Address) -> ContextRule {
    let mut signers = Vec::new(e);
    signers.push_back(Signer::Delegated(Address::generate(e)));
    ContextRule {
        id: 7,
        context_type: ContextRuleType::CallContract(token.clone()),
        name: String::from_str(e, "agent"),
        signers,
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: Some(5_000_000),
    }
}

fn transfer(e: &Env, token: &Address, to: &Address, amount: i128) -> Context {
    let mut args = Vec::new(e);
    args.push_back(Address::generate(e).into_val(e));
    args.push_back(to.into_val(e));
    args.push_back(amount.into_val(e));
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: soroban_sdk::symbol_short!("transfer"),
        args,
    })
}

fn params(
    e: &Env,
    merchant: &Address,
    cap: i128,
    period: u32,
    per_tx: Option<i128>,
) -> MerchantAllowlistParams {
    let mut merchants = Map::new(e);
    merchants.set(
        merchant.clone(),
        MerchantLimit {
            cap,
            period_ledgers: period,
        },
    );
    MerchantAllowlistParams {
        merchants,
        per_tx_max: per_tx,
    }
}

fn setup(e: &Env) -> (Address, Address, Address, Address) {
    let contract = e.register(MockContract, ());
    let account = Address::generate(e);
    let token = Address::generate(e);
    let merchant = Address::generate(e);
    (contract, account, token, merchant)
}

/// Each `require_auth` needs its own `as_contract` frame under `mock_all_auths`.
fn authed(e: &Env, contract: &Address, body: impl FnOnce()) {
    e.as_contract(contract, body);
}

#[test]
fn allowlisted_merchant_under_cap_passes() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    let context_rule = rule(&e, &token);

    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, Some(80)),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 40),
            &context_rule.signers,
            &context_rule,
            &account,
        );
        assert_eq!(get_remaining(&e, &account, context_rule.id, &merchant), 60);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3401)")]
fn non_allowlisted_merchant_panics() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    let other = Address::generate(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &other, 1),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
}

#[test]
fn cap_reached_panics_then_passes_after_the_window_rolls() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);

    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 100, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 100),
            &context_rule.signers,
            &context_rule,
            &account,
        );
        assert_eq!(get_remaining(&e, &account, context_rule.id, &merchant), 0);
    });

    e.ledger().with_mut(|li| li.sequence_number = 1_050);
    let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        authed(&e, &contract, || {
            enforce(
                &e,
                &transfer(&e, &token, &merchant, 1),
                &context_rule.signers,
                &context_rule,
                &account,
            );
        });
    }));
    assert!(
        over.is_err(),
        "a transfer inside the spent window must panic"
    );

    // cutoff = 1100 - 100 = 1000, so the ledger-1000 entry is evicted.
    e.ledger().with_mut(|li| li.sequence_number = 1_100);
    authed(&e, &contract, || {
        assert_eq!(get_remaining(&e, &account, context_rule.id, &merchant), 100);
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 100),
            &context_rule.signers,
            &context_rule,
            &account,
        );
        assert_eq!(get_remaining(&e, &account, context_rule.id, &merchant), 0);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3403)")]
fn per_tx_max_enforced() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 1_000, 100, Some(40)),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 41),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3404)")]
fn non_transfer_call_panics() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        let mut args = Vec::new(&e);
        args.push_back(merchant.into_val(&e));
        let context = Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&e, "approve"),
            args,
        });
        enforce(&e, &context, &context_rule.signers, &context_rule, &account);
    });
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn only_the_owner_can_edit_merchants() {
    let e = Env::default();
    let (contract, account, _token, merchant) = setup(&e);
    let context_rule = rule(&e, &Address::generate(&e));
    e.as_contract(&contract, || {
        set_merchant(
            &e,
            &account,
            &context_rule,
            &merchant,
            &MerchantLimit {
                cap: 10,
                period_ledgers: 10,
            },
        );
    });
}

#[test]
fn owner_edit_keeps_history() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 25),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        set_merchant(
            &e,
            &account,
            &context_rule,
            &merchant,
            &MerchantLimit {
                cap: 80,
                period_ledgers: 50,
            },
        );
    });
    authed(&e, &contract, || {
        assert_eq!(get_remaining(&e, &account, context_rule.id, &merchant), 55);
    });
    authed(&e, &contract, || {
        remove_merchant(&e, &account, &context_rule, &merchant);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3401)")]
fn removed_merchant_is_rejected() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        remove_merchant(&e, &account, &context_rule, &merchant);
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 1),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
}

fn topic_name(event: &soroban_sdk::xdr::ContractEvent) -> std::string::String {
    let ContractEventBody::V0(body) = &event.body;
    let ScVal::Symbol(symbol) = &body.topics[0] else {
        panic!("event topic is not a symbol");
    };
    symbol.0.to_utf8_string().expect("symbol")
}

#[test]
fn no_event_uses_a_balance_moving_topic() {
    for name in published_event_names() {
        assert!(!event_topic_is_balance_moving(name), "{name}");
    }
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 100, 50, None),
            &context_rule,
            &account,
        );
    });
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 10),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
    let names: std::vec::Vec<_> = e.events().all().events().iter().map(topic_name).collect();
    assert!(
        names.contains(&"merchant_cap_enforced".to_string()),
        "{names:?}"
    );
    for name in &names {
        assert!(!event_topic_is_balance_moving(name), "{name}");
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #3407)")]
fn history_full_panics() {
    let e = Env::default();
    let (contract, account, token, merchant) = setup(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 10);
    let context_rule = rule(&e, &token);
    authed(&e, &contract, || {
        install(
            &e,
            &params(&e, &merchant, 10_000, 1_000_000, None),
            &context_rule,
            &account,
        );
    });
    for _ in 0..MAX_HISTORY_ENTRIES {
        authed(&e, &contract, || {
            enforce(
                &e,
                &transfer(&e, &token, &merchant, 1),
                &context_rule.signers,
                &context_rule,
                &account,
            );
        });
    }
    authed(&e, &contract, || {
        enforce(
            &e,
            &transfer(&e, &token, &merchant, 1),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
}

#[test]
fn error_code_matches_the_documented_number() {
    assert_eq!(MerchantError::NotAllowlisted as u32, 3401);
    assert_eq!(MerchantError::CapExceeded as u32, 3402);
    assert_eq!(MerchantError::HistoryFull as u32, 3407);
}

#[test]
fn mux_id_without_a_per_id_entry_uses_the_base_contract() {
    assert_eq!(
        resolve_merchant_key(Some(42), false),
        MerchantResolution::Base
    );
    assert_eq!(resolve_merchant_key(None, true), MerchantResolution::Base);
}

#[cfg(feature = "p30")]
#[test]
fn w_destination_matches_base_contract() {
    assert_eq!(
        resolve_merchant_key(Some(42), false),
        MerchantResolution::Base
    );
    assert_eq!(resolve_merchant_key(None, false), MerchantResolution::Base);
    assert_eq!(
        resolve_merchant_key(Some(42), true),
        MerchantResolution::PerId(42)
    );
}
