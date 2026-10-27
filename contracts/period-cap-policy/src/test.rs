extern crate std;

use std::string::ToString;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract,
    testutils::{Address as _, Events, Ledger},
    xdr::{ContractEventBody, ScVal},
    Address, Env, IntoVal, String, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::logic::{
    enforce, event_topic_is_balance_moving, get_remaining, install, published_event_names,
    window_start, PeriodCapParams,
};

#[contract]
struct MockContract;

fn rule(e: &Env, token: &Address) -> ContextRule {
    let mut signers = Vec::new(e);
    signers.push_back(Signer::Delegated(Address::generate(e)));
    ContextRule {
        id: 3,
        context_type: ContextRuleType::CallContract(token.clone()),
        name: String::from_str(e, "agent"),
        signers,
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: Some(9_000_000),
    }
}

fn transfer(e: &Env, token: &Address, amount: i128) -> Context {
    let mut args = Vec::new(e);
    args.push_back(Address::generate(e).into_val(e));
    args.push_back(Address::generate(e).into_val(e));
    args.push_back(amount.into_val(e));
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: soroban_sdk::symbol_short!("transfer"),
        args,
    })
}

fn params(cap: i128, period: u32, anchor: u32, per_tx: Option<i128>) -> PeriodCapParams {
    PeriodCapParams {
        cap,
        period_ledgers: period,
        anchor_ledger: anchor,
        per_tx_max: per_tx,
    }
}

#[test]
fn period_cap_resets_exactly_at_the_boundary() {
    assert_eq!(window_start(1_000, 100, 1_000), Some(1_000));
    assert_eq!(window_start(1_000, 100, 1_099), Some(1_000));
    assert_eq!(window_start(1_000, 100, 1_100), Some(1_100));

    let e = Env::default();
    let contract = e.register(MockContract, ());
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    e.mock_all_auths();
    let context_rule = rule(&e, &token);

    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    e.as_contract(&contract, || {
        install(&e, &params(50, 100, 1_000, None), &context_rule, &account);
    });
    e.as_contract(&contract, || {
        enforce(
            &e,
            &transfer(&e, &token, 50),
            &context_rule.signers,
            &context_rule,
            &account,
        );
        assert_eq!(get_remaining(&e, &account, context_rule.id), 0);
    });

    e.ledger().with_mut(|li| li.sequence_number = 1_099);
    let inside = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        e.as_contract(&contract, || {
            enforce(
                &e,
                &transfer(&e, &token, 1),
                &context_rule.signers,
                &context_rule,
                &account,
            );
        });
    }));
    assert!(
        inside.is_err(),
        "ledger 1099 is still inside the spent window"
    );
    e.as_contract(&contract, || {
        assert_eq!(get_remaining(&e, &account, context_rule.id), 0);
    });

    e.ledger().with_mut(|li| li.sequence_number = 1_100);
    e.as_contract(&contract, || {
        assert_eq!(get_remaining(&e, &account, context_rule.id), 50);
    });
    e.as_contract(&contract, || {
        enforce(
            &e,
            &transfer(&e, &token, 50),
            &context_rule.signers,
            &context_rule,
            &account,
        );
        assert_eq!(get_remaining(&e, &account, context_rule.id), 0);
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3502)")]
fn per_tx_max_enforced() {
    let e = Env::default();
    let contract = e.register(MockContract, ());
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    let context_rule = rule(&e, &token);
    e.as_contract(&contract, || {
        install(
            &e,
            &params(1_000, 100, 1_000, Some(15)),
            &context_rule,
            &account,
        );
    });
    e.as_contract(&contract, || {
        enforce(
            &e,
            &transfer(&e, &token, 16),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #3503)")]
fn non_transfer_call_panics() {
    let e = Env::default();
    let contract = e.register(MockContract, ());
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    let context_rule = rule(&e, &token);
    e.as_contract(&contract, || {
        install(&e, &params(100, 100, 1_000, None), &context_rule, &account);
    });
    e.as_contract(&contract, || {
        let context = Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&e, "mint"),
            args: Vec::new(&e),
        });
        enforce(&e, &context, &context_rule.signers, &context_rule, &account);
    });
}

#[test]
fn no_event_uses_a_balance_moving_topic() {
    for name in published_event_names() {
        assert!(!event_topic_is_balance_moving(name), "{name}");
    }
    let e = Env::default();
    let contract = e.register(MockContract, ());
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    e.mock_all_auths();
    e.ledger().with_mut(|li| li.sequence_number = 1_000);
    let context_rule = rule(&e, &token);
    e.as_contract(&contract, || {
        install(&e, &params(100, 100, 1_000, None), &context_rule, &account);
    });
    e.as_contract(&contract, || {
        enforce(
            &e,
            &transfer(&e, &token, 20),
            &context_rule.signers,
            &context_rule,
            &account,
        );
    });
    let names: std::vec::Vec<std::string::String> = e
        .events()
        .all()
        .events()
        .iter()
        .map(|event| {
            let ContractEventBody::V0(body) = &event.body;
            let ScVal::Symbol(symbol) = &body.topics[0] else {
                panic!("event topic is not a symbol");
            };
            symbol.0.to_utf8_string().expect("symbol")
        })
        .collect();
    assert!(
        names.contains(&"period_cap_enforced".to_string()),
        "{names:?}"
    );
    for name in &names {
        assert!(!event_topic_is_balance_moving(name), "{name}");
    }
}
