//! Merchant allowlist policy for OpenZeppelin stellar-accounts 0.8.0.
//!
//! OpenZeppelin has no recipient-allowlist policy (see
//! `docs/oz-recipient-allowlist.md`). This contract implements the public
//! `Policy` trait from `stellar-accounts` 0.8.0.

#![no_std]

mod logic;

#[cfg(test)]
mod test;

pub use logic::{
    event_topic_is_balance_moving, get_remaining, published_event_names, resolve_merchant_key,
    MerchantAllowlistParams, MerchantError, MerchantLimit, MerchantResolution, MAX_HISTORY_ENTRIES,
};

use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

use logic::{enforce as enforce_policy, install as install_policy, uninstall as uninstall_policy};

#[contract]
pub struct MerchantAllowlistPolicy;

#[contractimpl]
impl Policy for MerchantAllowlistPolicy {
    type AccountParams = MerchantAllowlistParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        enforce_policy(
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
        install_policy(e, &install_params, &context_rule, &smart_account);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        uninstall_policy(e, &context_rule, &smart_account);
    }
}

#[contractimpl]
impl MerchantAllowlistPolicy {
    pub fn get_remaining(e: Env, smart_account: Address, rule_id: u32, merchant: Address) -> i128 {
        logic::get_remaining(&e, &smart_account, rule_id, &merchant)
    }

    pub fn set_merchant(
        e: Env,
        smart_account: Address,
        context_rule: ContextRule,
        merchant: Address,
        limit: MerchantLimit,
    ) {
        logic::set_merchant(&e, &smart_account, &context_rule, &merchant, &limit);
    }

    pub fn remove_merchant(
        e: Env,
        smart_account: Address,
        context_rule: ContextRule,
        merchant: Address,
    ) {
        logic::remove_merchant(&e, &smart_account, &context_rule, &merchant);
    }
}
