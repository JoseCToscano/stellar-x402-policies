//! Calendar spending cap.
//!
//! The window is `anchor_ledger + k * period_ledgers`. It resets when the
//! current ledger reaches the next boundary, including exactly
//! `anchor + period`. One counter replaces the rolling history used by
//! `spending_limit`.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contracterror, contractevent, contracttype, panic_with_error, symbol_short, Address, Env,
    TryFromVal, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

const DAY_IN_LEDGERS: u32 = 17_280;
const EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = EXTEND_AMOUNT - DAY_IN_LEDGERS;

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
pub enum PeriodCapError {
    NotInstalled = 3500,
    CapExceeded = 3501,
    PerTxExceeded = 3502,
    NotAllowed = 3503,
    OnlyCallContract = 3504,
    InvalidParams = 3505,
    AlreadyInstalled = 3506,
    NegativeAmount = 3507,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PeriodCapParams {
    pub cap: i128,
    pub period_ledgers: u32,
    pub anchor_ledger: u32,
    pub per_tx_max: Option<i128>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PeriodCapData {
    pub token: Address,
    pub cap: i128,
    pub period_ledgers: u32,
    pub anchor_ledger: u32,
    pub per_tx_max: Option<i128>,
    pub window_start: u32,
    pub spent: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
enum DataKey {
    Data(Address, u32),
}

#[contractevent]
#[derive(Clone)]
pub struct PeriodCapInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PeriodCapEnforced {
    #[topic]
    pub smart_account: Address,
    pub amount: i128,
    pub remaining: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PeriodCapUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

pub fn window_start(anchor: u32, period: u32, current: u32) -> Option<u32> {
    if period == 0 || current < anchor {
        return None;
    }
    let k = (current - anchor) / period;
    anchor.checked_add(k.checked_mul(period)?)
}

pub fn install(
    e: &Env,
    params: &PeriodCapParams,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();
    let token = match &context_rule.context_type {
        ContextRuleType::CallContract(token) => token.clone(),
        _ => panic_with_error!(e, PeriodCapError::OnlyCallContract),
    };
    if params.cap <= 0 || params.period_ledgers == 0 {
        panic_with_error!(e, PeriodCapError::InvalidParams);
    }
    if let Some(max) = params.per_tx_max {
        if max <= 0 {
            panic_with_error!(e, PeriodCapError::InvalidParams);
        }
    }
    let key = DataKey::Data(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) {
        panic_with_error!(e, PeriodCapError::AlreadyInstalled);
    }
    let data = PeriodCapData {
        token,
        cap: params.cap,
        period_ledgers: params.period_ledgers,
        anchor_ledger: params.anchor_ledger,
        per_tx_max: params.per_tx_max,
        window_start: params.anchor_ledger,
        spent: 0,
    };
    e.storage().persistent().set(&key, &data);
    extend(e, &key);
    PeriodCapInstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
    }
    .publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = DataKey::Data(smart_account.clone(), context_rule.id);
    if !e.storage().persistent().has(&key) {
        panic_with_error!(e, PeriodCapError::NotInstalled);
    }
    e.storage().persistent().remove(&key);
    PeriodCapUninstalled {
        smart_account: smart_account.clone(),
        context_rule_id: context_rule.id,
    }
    .publish(e);
}

pub fn enforce(
    e: &Env,
    context: &Context,
    authenticated_signers: &Vec<Signer>,
    context_rule: &ContextRule,
    smart_account: &Address,
) {
    smart_account.require_auth();
    if authenticated_signers.is_empty() {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    }
    let key = DataKey::Data(smart_account.clone(), context_rule.id);
    let mut data = read(e, smart_account, context_rule.id);
    extend(e, &key);

    let Context::Contract(ContractContext {
        contract,
        fn_name,
        args,
    }) = context
    else {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    };
    let ContextRuleType::CallContract(rule_token) = &context_rule.context_type else {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    };
    if contract != rule_token || rule_token != &data.token {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    }
    if fn_name != &symbol_short!("transfer") {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    }
    let Some(amount_val) = args.get(2) else {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    };
    let Ok(amount) = i128::try_from_val(e, &amount_val) else {
        panic_with_error!(e, PeriodCapError::NotAllowed);
    };
    if amount < 0 {
        panic_with_error!(e, PeriodCapError::NegativeAmount);
    }
    if amount == 0 {
        return;
    }
    if let Some(max) = data.per_tx_max {
        if amount > max {
            panic_with_error!(e, PeriodCapError::PerTxExceeded);
        }
    }

    let current = e.ledger().sequence();
    let start = window_start(data.anchor_ledger, data.period_ledgers, current)
        .unwrap_or_else(|| panic_with_error!(e, PeriodCapError::NotAllowed));
    let spent = if data.window_start == start {
        data.spent
    } else {
        0
    };
    let Some(next_spent) = spent.checked_add(amount) else {
        panic_with_error!(e, PeriodCapError::InvalidParams);
    };
    if next_spent > data.cap {
        panic_with_error!(e, PeriodCapError::CapExceeded);
    }
    data.window_start = start;
    data.spent = next_spent;
    e.storage().persistent().set(&key, &data);

    let remaining = data.cap - data.spent;
    PeriodCapEnforced {
        smart_account: smart_account.clone(),
        amount,
        remaining,
    }
    .publish(e);
}

/// Read-only. A ledger in a later window reports the full cap.
pub fn get_remaining(e: &Env, smart_account: &Address, rule_id: u32) -> i128 {
    let data = read(e, smart_account, rule_id);
    let current = e.ledger().sequence();
    let Some(start) = window_start(data.anchor_ledger, data.period_ledgers, current) else {
        return data.cap;
    };
    let spent = if data.window_start == start {
        data.spent
    } else {
        0
    };
    if spent >= data.cap {
        0
    } else {
        data.cap - spent
    }
}

pub fn event_topic_is_balance_moving(topic: &str) -> bool {
    BALANCE_MOVING_TOPICS
        .iter()
        .any(|denied| topic.eq_ignore_ascii_case(denied))
}

pub fn published_event_names() -> &'static [&'static str] {
    &[
        "period_cap_installed",
        "period_cap_enforced",
        "period_cap_uninstalled",
    ]
}

fn read(e: &Env, smart_account: &Address, rule_id: u32) -> PeriodCapData {
    let key = DataKey::Data(smart_account.clone(), rule_id);
    e.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, PeriodCapError::NotInstalled))
}

fn extend(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, EXTEND_AMOUNT);
}
