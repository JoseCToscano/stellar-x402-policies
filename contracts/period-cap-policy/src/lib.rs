//! Calendar period-cap policy for OpenZeppelin stellar-accounts 0.8.0.
//!
//! Per-asset rolling caps stay on the published `spending_limit` contract.
//! This policy stores one counter and resets it at
//! `anchor_ledger + k * period_ledgers`.

#![no_std]

mod logic;

#[cfg(test)]
mod test;

pub use logic::{
    event_topic_is_balance_moving, get_remaining, published_event_names, window_start,
    PeriodCapError, PeriodCapParams,
};

use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct PeriodCapPolicy;

#[contractimpl]
impl Policy for PeriodCapPolicy {
    type AccountParams = PeriodCapParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        logic::enforce(
            e,
            &context,
            &authenticated_signers,
            &context_rule,
            &smart_account,
        );
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        logic::install(e, &install_params, &context_rule, &smart_account);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        logic::uninstall(e, &context_rule, &smart_account);
    }
}

#[contractimpl]
impl PeriodCapPolicy {
    pub fn get_remaining(e: Env, smart_account: Address, rule_id: u32) -> i128 {
        logic::get_remaining(&e, &smart_account, rule_id)
    }
}
