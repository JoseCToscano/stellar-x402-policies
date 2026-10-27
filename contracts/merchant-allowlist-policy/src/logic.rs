//! Merchant allowlist policy.
//!
//! Each `(smart account, context rule, merchant)` has a rolling window, the
//! same eviction rule as OpenZeppelin `spending_limit`: an entry is dropped
//! when `ledger_sequence <= current_ledger - period_ledgers`. The token comes
//! from the rule's `CallContract` address. This contract does not reimplement
//! per-asset rolling caps; those stay on `spending_limit`.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contracterror, contractevent, contracttype, panic_with_error, symbol_short, Address, Env, Map,
    TryFromVal, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

/// Largest history that still fits a ledger entry, matching stellar-accounts
/// 0.8.0 `spending_limit::MAX_HISTORY_ENTRIES`.
pub const MAX_HISTORY_ENTRIES: u32 = 815;

const DAY_IN_LEDGERS: u32 = 17_280;
const EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = EXTEND_AMOUNT - DAY_IN_LEDGERS;

/// Topics this contract must never emit. The verifier rejects them even from
/// an allowlisted policy because they move or authorize a balance.
pub const BALANCE_MOVING_TOPICS: [&str; 6] = [
    "transfer",
    "mint",
    "burn",
    "clawback",
    "approve",
    "set_authorized",
];

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MerchantError {
    NotInstalled = 3400,
    NotAllowlisted = 3401,
    CapExceeded = 3402,
    PerTxExceeded = 3403,
    NotAllowed = 3404,
    OnlyCallContract = 3405,
    InvalidParams = 3406,
    HistoryFull = 3407,
    NegativeAmount = 3408,
    AlreadyInstalled = 3409,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MerchantLimit {
    pub cap: i128,
    pub period_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MerchantAllowlistParams {
    pub merchants: Map<Address, MerchantLimit>,
    pub per_tx_max: Option<i128>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PolicyConfig {
    pub token: Address,
    pub per_tx_max: Option<i128>,
    pub merchants: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendEntry {
    pub amount: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MerchantWindow {
    pub cap: i128,
    pub period_ledgers: u32,
    pub history: Vec<SpendEntry>,
    pub spent: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
enum DataKey {
    Config(Address, u32),
    Window(Address, u32, Address),
}

#[contractevent]
#[derive(Clone)]
pub struct MerchantAllowlistInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct MerchantCapEnforced {
    #[topic]
    pub smart_account: Address,
    pub merchant: Address,
    pub amount: i128,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct MerchantUpdated {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub merchant: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct MerchantAllowlistUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

/// Where a destination resolves once a mux id is known.
///
/// Protocol 30 (CAP-84) adds W muxed contract addresses. `soroban-sdk` 28.0.0
/// has no `MuxedAddress` type, so `enforce` still receives `to` as an
/// `Address` (the base contract). Per-id entries exist only with the `p30`
/// feature. A mux id with no per-id entry resolves to [`MerchantResolution::Base`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MerchantResolution {
    Base,
    #[cfg(feature = "p30")]
    PerId(u64),
}

/// Match a W destination against the allowlist.
///
/// With feature `p30`, a mux id that has its own entry resolves to that id.
/// Every other destination, including a W address whose id is not listed,
/// resolves to the base contract.
pub fn resolve_merchant_key(mux_id: Option<u64>, has_per_id_entry: bool) -> MerchantResolution {
    #[cfg(feature = "p30")]
    if let Some(id) = mux_id {
        if has_per_id_entry {
            return MerchantResolution::PerId(id);
        }
    }
    #[cfg(not(feature = "p30"))]
    let _ = (mux_id, has_per_id_entry);
    MerchantResolution::Base
}

pub fn install(
    e: &Env,
    params: &MerchantAllowlistParams,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();
    let token = call_contract_token(e, context_rule);
    validate_per_tx(e, params.per_tx_max);

    let key = DataKey::Config(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, MerchantError::AlreadyInstalled);
    }

    let mut merchants = Vec::new(e);
    for merchant in params.merchants.keys() {
        let limit = params.merchants.get(merchant.clone()).unwrap();
        validate_limit(e, &limit);
        write_window(
            e,
            smart_account,
            context_rule.id,
            &merchant,
            &limit,
            Vec::new(e),
            0,
        );
        merchants.push_back(merchant);
    }

    let config = PolicyConfig {
        token,
        per_tx_max: params.per_tx_max,
        merchants,
    };
    e.storage().persistent().set(&key, &config);
    extend(e, &key);

    MerchantAllowlistInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
    }
    .publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let config = read_config(e, smart_account, context_rule.id);
    for merchant in config.merchants.iter() {
        let key = DataKey::Window(smart_account.clone(), context_rule.id, merchant);
        e.storage().persistent().remove(&key);
    }
    let key = DataKey::Config(smart_account.clone(), context_rule.id);
    e.storage().persistent().remove(&key);
    MerchantAllowlistUninstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
    }
    .publish(e);
}

/// Require `transfer(from, to, amount)` on the rule's token.
///
/// `to` must be allowlisted. `amount` must be within `per_tx_max` and the
/// merchant's rolling cap. A zero amount is ignored after the allowlist check.
pub fn enforce(
    e: &Env,
    context: &Context,
    authenticated_signers: &Vec<Signer>,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();
    if authenticated_signers.is_empty() {
        panic_with_error!(e, MerchantError::NotAllowed);
    }

    let config_key = DataKey::Config(smart_account.clone(), context_rule.id);
    let config = read_config(e, smart_account, context_rule.id);
    extend(e, &config_key);

    let Context::Contract(ContractContext {
        contract,
        fn_name,
        args,
    }) = context
    else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    let ContextRuleType::CallContract(rule_token) = &context_rule.context_type else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    if contract != rule_token || rule_token != &config.token {
        panic_with_error!(e, MerchantError::NotAllowed);
    }
    if fn_name != &symbol_short!("transfer") {
        panic_with_error!(e, MerchantError::NotAllowed);
    }

    let Some(to_val) = args.get(1) else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    let Some(amount_val) = args.get(2) else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    let Ok(merchant) = Address::try_from_val(e, &to_val) else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    let Ok(amount) = i128::try_from_val(e, &amount_val) else {
        panic_with_error!(e, MerchantError::NotAllowed);
    };
    if amount < 0 {
        panic_with_error!(e, MerchantError::NegativeAmount);
    }

    // W destinations match the base contract until a per-id entry exists.
    // sdk 28 cannot decode a muxed `to`, so the id is absent here.
    if !matches!(resolve_merchant_key(None, false), MerchantResolution::Base) {
        panic_with_error!(e, MerchantError::NotAllowlisted);
    }

    let mut window = read_window(e, smart_account, context_rule.id, &merchant);
    if amount == 0 {
        return;
    }
    if let Some(max) = config.per_tx_max {
        if amount > max {
            panic_with_error!(e, MerchantError::PerTxExceeded);
        }
    }

    let current = e.ledger().sequence();
    let removed = evict(&mut window.history, current, window.period_ledgers);
    window.spent -= removed;
    let Some(next_spent) = window.spent.checked_add(amount) else {
        panic_with_error!(e, MerchantError::InvalidParams);
    };
    if next_spent > window.cap {
        panic_with_error!(e, MerchantError::CapExceeded);
    }
    if window.history.len() >= MAX_HISTORY_ENTRIES {
        panic_with_error!(e, MerchantError::HistoryFull);
    }
    window.history.push_back(SpendEntry {
        amount,
        ledger: current,
    });
    window.spent = next_spent;

    let window_key = DataKey::Window(smart_account.clone(), context_rule.id, merchant.clone());
    e.storage().persistent().set(&window_key, &window);
    extend(e, &window_key);

    let remaining = window.cap - window.spent;
    MerchantCapEnforced {
        smart_account: smart_account.clone(),
        merchant,
        amount,
        remaining,
    }
    .publish(e);
}

pub fn set_merchant(
    e: &Env,
    smart_account: &Address,
    context_rule: &ContextRule,
    merchant: &Address,
    limit: &MerchantLimit,
) {
    smart_account.require_auth();
    validate_limit(e, limit);
    let mut config = read_config(e, smart_account, context_rule.id);
    let key = DataKey::Window(smart_account.clone(), context_rule.id, merchant.clone());
    if e.storage().persistent().has(&key) {
        let existing: MerchantWindow = e.storage().persistent().get(&key).unwrap();
        write_window(
            e,
            smart_account,
            context_rule.id,
            merchant,
            limit,
            existing.history,
            existing.spent,
        );
    } else {
        write_window(
            e,
            smart_account,
            context_rule.id,
            merchant,
            limit,
            Vec::new(e),
            0,
        );
        config.merchants.push_back(merchant.clone());
        let config_key = DataKey::Config(smart_account.clone(), context_rule.id);
        e.storage().persistent().set(&config_key, &config);
        extend(e, &config_key);
    }
    MerchantUpdated {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        merchant: merchant.clone(),
    }
    .publish(e);
}

pub fn remove_merchant(
    e: &Env,
    smart_account: &Address,
    context_rule: &ContextRule,
    merchant: &Address,
) {
    smart_account.require_auth();
    let mut config = read_config(e, smart_account, context_rule.id);
    let key = DataKey::Window(smart_account.clone(), context_rule.id, merchant.clone());
    if !e.storage().persistent().has(&key) {
        panic_with_error!(e, MerchantError::NotAllowlisted);
    }
    e.storage().persistent().remove(&key);
    let mut kept = Vec::new(e);
    for listed in config.merchants.iter() {
        if &listed != merchant {
            kept.push_back(listed);
        }
    }
    config.merchants = kept;
    let config_key = DataKey::Config(smart_account.clone(), context_rule.id);
    e.storage().persistent().set(&config_key, &config);
    MerchantUpdated {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
        merchant: merchant.clone(),
    }
    .publish(e);
}

/// Read-only remaining allowance. Does not extend TTL or rewrite history.
pub fn get_remaining(e: &Env, smart_account: &Address, rule_id: u32, merchant: &Address) -> i128 {
    let window = read_window(e, smart_account, rule_id, merchant);
    live_spent(&window, e.ledger().sequence())
        .map(|spent| {
            if spent >= window.cap {
                0
            } else {
                window.cap - spent
            }
        })
        .unwrap_or(0)
}

pub fn event_topic_is_balance_moving(topic: &str) -> bool {
    BALANCE_MOVING_TOPICS
        .iter()
        .any(|denied| topic.eq_ignore_ascii_case(denied))
}

pub fn published_event_names() -> &'static [&'static str] {
    &[
        "merchant_allowlist_installed",
        "merchant_cap_enforced",
        "merchant_updated",
        "merchant_allowlist_uninstalled",
    ]
}

fn call_contract_token(e: &Env, context_rule: &ContextRule) -> Address {
    match &context_rule.context_type {
        ContextRuleType::CallContract(token) => token.clone(),
        _ => panic_with_error!(e, MerchantError::OnlyCallContract),
    }
}

fn validate_per_tx(e: &Env, per_tx_max: Option<i128>) {
    if let Some(max) = per_tx_max {
        if max <= 0 {
            panic_with_error!(e, MerchantError::InvalidParams);
        }
    }
}

fn validate_limit(e: &Env, limit: &MerchantLimit) {
    if limit.cap <= 0 || limit.period_ledgers == 0 {
        panic_with_error!(e, MerchantError::InvalidParams);
    }
}

fn write_window(
    e: &Env,
    smart_account: &Address,
    rule_id: u32,
    merchant: &Address,
    limit: &MerchantLimit,
    history: Vec<SpendEntry>,
    spent: i128,
) {
    let key = DataKey::Window(smart_account.clone(), rule_id, merchant.clone());
    let window = MerchantWindow {
        cap: limit.cap,
        period_ledgers: limit.period_ledgers,
        history,
        spent,
    };
    e.storage().persistent().set(&key, &window);
    extend(e, &key);
}

fn read_config(e: &Env, smart_account: &Address, rule_id: u32) -> PolicyConfig {
    let key = DataKey::Config(smart_account.clone(), rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, MerchantError::NotInstalled))
}

fn read_window(
    e: &Env,
    smart_account: &Address,
    rule_id: u32,
    merchant: &Address,
) -> MerchantWindow {
    let key = DataKey::Window(smart_account.clone(), rule_id, merchant.clone());
    e.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, MerchantError::NotAllowlisted))
}

fn extend(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, EXTEND_AMOUNT);
}

fn evict(history: &mut Vec<SpendEntry>, current: u32, period: u32) -> i128 {
    let cutoff = current.saturating_sub(period);
    let mut removed = 0i128;
    while let Some(entry) = history.get(0) {
        if entry.ledger <= cutoff {
            removed += entry.amount;
            history.pop_front();
        } else {
            break;
        }
    }
    removed
}

fn live_spent(window: &MerchantWindow, current: u32) -> Option<i128> {
    let cutoff = current.saturating_sub(window.period_ledgers);
    let mut spent = 0i128;
    for entry in window.history.iter() {
        if entry.ledger > cutoff {
            spent = spent.checked_add(entry.amount)?;
        }
    }
    Some(spent)
}
