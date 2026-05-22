//! Budgent Policy Vault
//!
//! A non-custodial budget primitive for autonomous AI agents on Solana.
//!
//! The OWNER (master authority) funds a Vault PDA and writes a budget: per-tx cap,
//! daily limit (fixed 24h window), recipient allow/block lists, an instant delegate
//! kill-switch, and a co-sign threshold. The AGENT holds a delegate key that can ONLY
//! move funds inside that budget — every rule is checked here, in consensus, on every
//! transfer. A transfer that breaks a rule fails (the network reverts it); the backend
//! cannot spend more than this program permits.
//!
//! BUDGET SEMANTICS (matching the product spec exactly):
//!   * co-sign threshold is a PER-PAYMENT magnitude gate: any single payment whose amount
//!     is >= the threshold requires the owner to also sign. Aggregate unilateral spend is
//!     bounded by the daily limit (the two controls are complementary, not redundant).
//!     `cosign_threshold == 0` therefore means "co-sign every payment"; set it very high
//!     (e.g. u64::MAX) to disable co-sign entirely.
//!   * the daily limit uses a FIXED (tumbling) 24h window: when the window elapses it
//!     resets to zero on the next payment. A boundary crossing can allow up to ~2x the
//!     daily limit across a few seconds; this is inherent to fixed windows and bounded by
//!     vault balance / per-tx / co-sign. The owner can also reset the window on demand.
//!
//! TWO HARD INVARIANTS:
//!   1. FUNDS ARE ALWAYS FULLY WITHDRAWABLE BY THE OWNER. `withdraw_*` has no policy
//!      limits, `close_vault_*` drains everything (tokens + lamports + rent) back to the
//!      owner, and `sweep_token` recovers ANY token (even mis-routed assets of a foreign
//!      mint) held under the vault's authority. No code path can strand funds.
//!   2. The program is built deterministically and verified against on-chain bytecode.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM");

pub const MAX_LIST_LEN: usize = 16;
pub const WINDOW_SECONDS: i64 = 86_400; // fixed 24h daily window (tumbling: resets once elapsed)
/// Sentinel mint meaning "native SOL" (Pubkey::default == all zeroes).
pub const NATIVE_MINT_SENTINEL: Pubkey = Pubkey::new_from_array([0u8; 32]);

#[program]
pub mod budgent_vault {
    use super::*;

    /// Create a vault. `mint == Pubkey::default()` => native SOL vault; otherwise an
    /// SPL vault bound to that mint. Sets the initial budget and (optionally) a delegate.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_id: u64,
        mint: Pubkey,
        per_tx_limit: u64,
        daily_limit: u64,
        cosign_threshold: u64,
        delegate: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.vault_id = vault_id;
        v.mint = mint;
        v.delegate = delegate;
        v.bump = ctx.bumps.vault;
        v.delegate_active = delegate != Pubkey::default();
        v.per_tx_limit = per_tx_limit;
        v.daily_limit = daily_limit;
        v.cosign_threshold = cosign_threshold;
        v.window_start = now;
        v.spent_in_window = 0;
        v.allowlist = Vec::new();
        v.blocklist = Vec::new();
        v.total_paid = 0;
        v.payment_count = 0;

        emit!(VaultInitialized {
            vault: v.key(),
            owner: v.owner,
            mint: v.mint,
            vault_id,
        });
        Ok(())
    }

    /// Update limits. Does NOT reset the daily window — edits apply to future intents,
    /// already-settled spend stays counted (matches the product semantics).
    pub fn set_policy(
        ctx: Context<OwnerOnly>,
        per_tx_limit: u64,
        daily_limit: u64,
        cosign_threshold: u64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.per_tx_limit = per_tx_limit;
        v.daily_limit = daily_limit;
        v.cosign_threshold = cosign_threshold;
        emit!(PolicyUpdated {
            vault: v.key(),
            per_tx_limit,
            daily_limit,
            cosign_threshold,
        });
        Ok(())
    }

    /// Rotate the delegate key. Setting the default pubkey clears + deactivates it.
    pub fn set_delegate(ctx: Context<OwnerOnly>, delegate: Pubkey) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.delegate = delegate;
        v.delegate_active = delegate != Pubkey::default();
        emit!(DelegateChanged {
            vault: v.key(),
            delegate,
            active: v.delegate_active,
        });
        Ok(())
    }

    /// The instant kill-switch. `false` blocks every transfer immediately.
    pub fn set_delegate_active(ctx: Context<OwnerOnly>, active: bool) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.delegate_active = active;
        emit!(DelegateChanged {
            vault: v.key(),
            delegate: v.delegate,
            active,
        });
        Ok(())
    }

    /// Add/remove a recipient from the allowlist (kind=0) or blocklist (kind=1).
    pub fn manage_list(
        ctx: Context<OwnerOnly>,
        kind: u8,
        addr: Pubkey,
        add: bool,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        let list = match kind {
            0 => &mut v.allowlist,
            1 => &mut v.blocklist,
            _ => return err!(BudgetError::BadListKind),
        };
        if add {
            if !list.contains(&addr) {
                require!(list.len() < MAX_LIST_LEN, BudgetError::ListFull);
                list.push(addr);
            }
        } else {
            list.retain(|x| x != &addr);
        }
        Ok(())
    }

    /// Deposit native SOL into the vault PDA (anyone may fund; usually the owner).
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        require!(amount > 0, BudgetError::ZeroAmount);
        require_keys_eq!(ctx.accounts.vault.mint, NATIVE_MINT_SENTINEL, BudgetError::WrongAsset);
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.depositor.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// Deposit SPL tokens into the vault's associated token account.
    pub fn deposit_spl(ctx: Context<DepositSpl>, amount: u64) -> Result<()> {
        require!(amount > 0, BudgetError::ZeroAmount);
        require_keys_eq!(ctx.accounts.vault.mint, ctx.accounts.mint.key(), BudgetError::WrongAsset);
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    /// AGENT PATH (native SOL). Delegate-signed transfer, enforced against the full
    /// budget. `context_hash` is the 32-byte hash binding this payment to its off-chain
    /// context; it is surfaced in the PaymentSettled event for the indexer.
    pub fn pay_sol(ctx: Context<PaySol>, amount: u64, context_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault_ai = ctx.accounts.vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let available = vault_ai.lamports().saturating_sub(rent_min);

        let v = &mut ctx.accounts.vault;
        require_keys_eq!(ctx.accounts.owner.key(), v.owner, BudgetError::Unauthorized);
        require_keys_eq!(v.mint, NATIVE_MINT_SENTINEL, BudgetError::WrongAsset);

        authorize_and_commit(
            v,
            &ctx.accounts.delegate.key(),
            &ctx.accounts.recipient.key(),
            amount,
            available,
            ctx.accounts.owner.is_signer,
            now,
        )?;

        // Move lamports out of the program-owned vault account directly.
        **vault_ai.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(PaymentSettled {
            vault: v.key(),
            delegate: v.delegate,
            recipient: ctx.accounts.recipient.key(),
            mint: NATIVE_MINT_SENTINEL,
            amount,
            context_hash,
            payment_count: v.payment_count,
            ts: now,
        });
        Ok(())
    }

    /// AGENT PATH (SPL). Same enforcement; transfers from the vault ATA to the
    /// recipient's ATA (created if missing, paid by the delegate).
    pub fn pay_spl(ctx: Context<PaySpl>, amount: u64, context_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let available = ctx.accounts.vault_ata.amount;

        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.vault.owner, BudgetError::Unauthorized);
        require_keys_eq!(ctx.accounts.vault.mint, ctx.accounts.mint.key(), BudgetError::WrongAsset);

        let delegate_key = ctx.accounts.delegate.key();
        let recipient_key = ctx.accounts.recipient.key();
        let owner_is_signer = ctx.accounts.owner.is_signer;
        authorize_and_commit(
            &mut ctx.accounts.vault,
            &delegate_key,
            &recipient_key,
            amount,
            available,
            owner_is_signer,
            now,
        )?;

        let owner_key = ctx.accounts.vault.owner;
        let bump = ctx.accounts.vault.bump;
        let vid = ctx.accounts.vault.vault_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), vid.as_ref(), &[bump]];
        let signer = &[seeds];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let v = &ctx.accounts.vault;
        emit!(PaymentSettled {
            vault: v.key(),
            delegate: v.delegate,
            recipient: ctx.accounts.recipient.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            context_hash,
            payment_count: v.payment_count,
            ts: now,
        });
        Ok(())
    }

    /// OWNER WITHDRAW (native). No policy limits — owner can always pull funds.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        require!(amount > 0, BudgetError::ZeroAmount);
        let vault_ai = ctx.accounts.vault.to_account_info();
        require_keys_eq!(ctx.accounts.vault.mint, NATIVE_MINT_SENTINEL, BudgetError::WrongAsset);
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let available = vault_ai.lamports().saturating_sub(rent_min);
        require!(amount <= available, BudgetError::InsufficientFunds);
        **vault_ai.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;
        emit!(Withdrawn {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            mint: NATIVE_MINT_SENTINEL,
            amount,
        });
        Ok(())
    }

    /// OWNER WITHDRAW (SPL). No policy limits.
    pub fn withdraw_spl(ctx: Context<WithdrawSpl>, amount: u64) -> Result<()> {
        require!(amount > 0, BudgetError::ZeroAmount);
        require_keys_eq!(ctx.accounts.vault.mint, ctx.accounts.mint.key(), BudgetError::WrongAsset);
        require!(amount <= ctx.accounts.vault_ata.amount, BudgetError::InsufficientFunds);
        let v = &ctx.accounts.vault;
        let owner_key = v.owner;
        let vid = v.vault_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), vid.as_ref(), &[v.bump]];
        let signer = &[seeds];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(Withdrawn {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }

    /// FULL EXIT (native). `close = owner` returns 100% of lamports (spendable + rent).
    pub fn close_vault_sol(ctx: Context<CloseVaultSol>) -> Result<()> {
        require_keys_eq!(ctx.accounts.vault.mint, NATIVE_MINT_SENTINEL, BudgetError::WrongAsset);
        emit!(VaultClosed { vault: ctx.accounts.vault.key(), owner: ctx.accounts.owner.key() });
        Ok(())
    }

    /// FULL EXIT (SPL). Drains every token to the owner, closes the vault ATA (rent →
    /// owner), then closes the config account (lamports → owner). Nothing is stranded.
    pub fn close_vault_spl(ctx: Context<CloseVaultSpl>) -> Result<()> {
        require_keys_eq!(ctx.accounts.vault.mint, ctx.accounts.mint.key(), BudgetError::WrongAsset);
        let v = &ctx.accounts.vault;
        let owner_key = v.owner;
        let vid = v.vault_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), vid.as_ref(), &[v.bump]];
        let signer = &[seeds];

        let remaining = ctx.accounts.vault_ata.amount;
        if remaining > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_ata.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.owner_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                remaining,
                ctx.accounts.mint.decimals,
            )?;
        }
        // close the vault ATA, returning its rent to the owner
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_ata.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ))?;
        emit!(VaultClosed { vault: ctx.accounts.vault.key(), owner: ctx.accounts.owner.key() });
        Ok(())
    }

    /// Owner re-arms the daily window on demand (the product's "New day"). Re-arming
    /// only re-grants the agent its daily allowance — a privilege the owner already holds
    /// implicitly (they can withdraw/close at will), so this adds no new power.
    pub fn reset_window(ctx: Context<OwnerOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let v = &mut ctx.accounts.vault;
        v.window_start = now;
        v.spent_in_window = 0;
        Ok(())
    }

    /// OWNER RECOVERY for ANY token held under the vault authority — including assets of a
    /// foreign mint mis-routed to a vault-owned token account. No policy limits, no
    /// `vault.mint` constraint. Guarantees invariant #1 even for out-of-band assets.
    pub fn sweep_token(ctx: Context<SweepToken>) -> Result<()> {
        let v = &ctx.accounts.vault;
        let owner_key = v.owner;
        let vid = v.vault_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), vid.as_ref(), &[v.bump]];
        let signer = &[seeds];

        let amount = ctx.accounts.vault_token_account.amount;
        if amount > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.owner_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_token_account.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer,
        ))?;
        emit!(Withdrawn {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            amount,
        });
        Ok(())
    }
}

/// Single source of truth for the budget. Rule order mirrors the product spec exactly:
/// delegate → recipient → per-tx → daily → balance → co-sign. Mutates `spent_in_window`,
/// `total_paid`, `payment_count` only after every check passes.
///
/// Window is fixed/tumbling (resets once 24h elapses). Co-sign is a per-payment magnitude
/// gate (a single payment >= threshold needs the owner's signature); aggregate unilateral
/// spend is bounded by the daily limit. See the module docs for the full semantics.
fn authorize_and_commit(
    v: &mut Vault,
    delegate: &Pubkey,
    recipient: &Pubkey,
    amount: u64,
    available: u64,
    owner_is_signer: bool,
    now: i64,
) -> Result<()> {
    // 1 — delegate active + correct key (only the live delegate can move funds)
    require!(v.delegate_active, BudgetError::DelegateRevoked);
    require!(v.delegate != Pubkey::default(), BudgetError::DelegateRevoked);
    require_keys_eq!(*delegate, v.delegate, BudgetError::BadDelegate);

    // 2 — recipient: blocklist always wins; allowlist (if non-empty) must contain it
    require!(!v.blocklist.contains(recipient), BudgetError::RecipientBlocked);
    require!(
        v.allowlist.is_empty() || v.allowlist.contains(recipient),
        BudgetError::NotOnAllowlist
    );

    // 3 — per-transaction cap
    require!(amount > 0, BudgetError::ZeroAmount);
    require!(amount <= v.per_tx_limit, BudgetError::OverPerTx);

    // 4 — daily limit on a fixed 24h window (reset lazily once the window has elapsed)
    if now.saturating_sub(v.window_start) >= WINDOW_SECONDS {
        v.window_start = now;
        v.spent_in_window = 0;
    }
    let projected = v
        .spent_in_window
        .checked_add(amount)
        .ok_or(BudgetError::MathOverflow)?;
    require!(projected <= v.daily_limit, BudgetError::OverDaily);

    // 5 — vault must actually hold the funds
    require!(amount <= available, BudgetError::InsufficientFunds);

    // 6 — co-sign: at/above threshold the owner must also sign this transaction
    if amount >= v.cosign_threshold {
        require!(owner_is_signer, BudgetError::CosignRequired);
    }

    // commit
    v.spent_in_window = projected;
    v.total_paid = v.total_paid.checked_add(amount).ok_or(BudgetError::MathOverflow)?;
    v.payment_count = v.payment_count.checked_add(1).ok_or(BudgetError::MathOverflow)?;
    Ok(())
}

/* ----------------------------- Accounts ----------------------------- */

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub delegate: Pubkey,
    pub mint: Pubkey, // Pubkey::default() => native SOL
    pub bump: u8,
    pub delegate_active: bool,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub cosign_threshold: u64,
    pub window_start: i64,
    pub spent_in_window: u64,
    #[max_len(MAX_LIST_LEN)]
    pub allowlist: Vec<Pubkey>,
    #[max_len(MAX_LIST_LEN)]
    pub blocklist: Vec<Pubkey>,
    pub total_paid: u64,
    pub payment_count: u64,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSpl<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        constraint = depositor_ata.mint == mint.key() @ BudgetError::WrongAsset,
        constraint = depositor_ata.owner == depositor.key() @ BudgetError::Unauthorized,
    )]
    pub depositor_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PaySol<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub delegate: Signer<'info>,
    /// CHECK: recipient wallet, only credited with lamports; validated against the
    /// on-chain allow/block lists inside the instruction.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// The vault owner. Must be passed for reference; must SIGN only when the amount is
    /// at/above the co-sign threshold (checked in the instruction).
    /// CHECK: verified to equal vault.owner; is_signer drives the co-sign rule.
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PaySpl<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub delegate: Signer<'info>,
    /// CHECK: recipient wallet; validated against allow/block lists in the instruction.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = delegate,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_ata: Account<'info, TokenAccount>,
    /// CHECK: verified to equal vault.owner; is_signer drives the co-sign rule.
    pub owner: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawSpl<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseVaultSol<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized, close = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseVaultSpl<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized, close = owner)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepToken<'info> {
    #[account(mut, has_one = owner @ BudgetError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    /// The mint of the token being recovered (NOT constrained to vault.mint on purpose).
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/* ----------------------------- Events ----------------------------- */

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub cosign_threshold: u64,
}

#[event]
pub struct DelegateChanged {
    pub vault: Pubkey,
    pub delegate: Pubkey,
    pub active: bool,
}

#[event]
pub struct PaymentSettled {
    pub vault: Pubkey,
    pub delegate: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub context_hash: [u8; 32],
    pub payment_count: u64,
    pub ts: i64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub owner: Pubkey,
}

/* ----------------------------- Errors ----------------------------- */

#[error_code]
pub enum BudgetError {
    #[msg("delegate revoked — all transfers blocked")]
    DelegateRevoked,
    #[msg("signer is not the vault delegate")]
    BadDelegate,
    #[msg("recipient is blocklisted")]
    RecipientBlocked,
    #[msg("recipient not on allowlist")]
    NotOnAllowlist,
    #[msg("amount exceeds per-transaction limit")]
    OverPerTx,
    #[msg("amount exceeds daily limit")]
    OverDaily,
    #[msg("insufficient vault balance")]
    InsufficientFunds,
    #[msg("amount at/above co-sign threshold requires owner signature")]
    CosignRequired,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("not the vault owner")]
    Unauthorized,
    #[msg("wrong asset for this vault")]
    WrongAsset,
    #[msg("recipient list is full")]
    ListFull,
    #[msg("invalid list kind")]
    BadListKind,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
