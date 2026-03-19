use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;
use anchor_lang::AccountDeserialize;
use solana_gateway_anchor::Pass;

declare_id!("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

#[program]
pub mod governor {
    use super::*;

    /// Create a new KYC-gated lending pool.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        params: PoolParams,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool_config.key();
        let authority_key = ctx.accounts.authority.key();
        let underlying_key = ctx.accounts.underlying_mint.key();
        let wrapped_key = ctx.accounts.wrapped_mint.key();
        let dm_config_key = ctx.accounts.dm_mint_config.key();

        let pool = &mut ctx.accounts.pool_config;
        pool.authority = authority_key;
        pool.underlying_mint = underlying_key;
        pool.underlying_oracle = params.underlying_oracle;
        pool.borrow_mint = params.borrow_mint;
        pool.borrow_oracle = params.borrow_oracle;
        pool.wrapped_mint = wrapped_key;
        pool.dm_mint_config = dm_config_key;
        pool.decimals = params.decimals;
        pool.ltv_pct = params.ltv_pct;
        pool.liquidation_threshold_pct = params.liquidation_threshold_pct;
        pool.bump = ctx.bumps.pool_config;
        pool.gatekeeper_network = Pubkey::default();
        pool.status = PoolStatus::Initializing;

        delta_cpi::initialize_mint(
            CpiContext::new(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::InitializeMint {
                    authority: ctx.accounts.authority.to_account_info(),
                    mint: ctx.accounts.wrapped_mint.to_account_info(),
                    mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                    mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            params.decimals,
        )?;

        emit!(PoolCreatedEvent {
            pool: pool_key,
            underlying_mint: underlying_key,
            wrapped_mint: wrapped_key,
            authority: authority_key,
        });

        Ok(())
    }

    /// Register the klend market and reserve addresses.
    /// Transitions Initializing → Active. Only root authority.
    pub fn register_lending_market(
        ctx: Context<RootOnly>,
        lending_market: Pubkey,
        collateral_reserve: Pubkey,
        borrow_reserve: Pubkey,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_config;
        require!(
            pool.status == PoolStatus::Initializing,
            GovernorError::InvalidPoolStatus
        );
        pool.lending_market = lending_market;
        pool.collateral_reserve = collateral_reserve;
        pool.borrow_reserve = borrow_reserve;
        pool.status = PoolStatus::Active;
        Ok(())
    }

    /// Add an admin to the pool. Only the root authority can add admins.
    pub fn add_admin(ctx: Context<ManageAdmin>) -> Result<()> {
        let admin = &mut ctx.accounts.admin_entry;
        admin.pool = ctx.accounts.pool_config.key();
        admin.wallet = ctx.accounts.new_admin.key();
        admin.added_by = ctx.accounts.authority.key();
        admin.bump = ctx.bumps.admin_entry;
        Ok(())
    }

    /// Remove an admin. Only root authority.
    pub fn remove_admin(_ctx: Context<RemoveAdmin>) -> Result<()> {
        // Account is closed by the `close` attribute
        Ok(())
    }

    /// Add a participant (KYC'd holder or liquidator bot).
    /// Can be called by root authority OR any admin.
    pub fn add_participant(
        ctx: Context<AddParticipant>,
        role: ParticipantRole,
    ) -> Result<()> {
        let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
        let cpi_accounts = delta_accounts::AddToWhitelist {
            authority: ctx.accounts.authority.to_account_info(),
            mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            wallet: ctx.accounts.wallet.to_account_info(),
            whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

        match role {
            ParticipantRole::Holder => {
                delta_cpi::add_to_whitelist(CpiContext::new(cpi_program, cpi_accounts))?;
            }
            ParticipantRole::Liquidator => {
                delta_cpi::add_liquidator(CpiContext::new(cpi_program, cpi_accounts))?;
            }
        }

        Ok(())
    }

    /// Mint wrapped tokens to a whitelisted holder.
    /// Can be called by root authority OR any admin.
    pub fn mint_wrapped(ctx: Context<MintWrapped>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.pool_config.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );

        delta_cpi::mint_to(
            CpiContext::new(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::MintTokens {
                    authority: ctx.accounts.authority.to_account_info(),
                    mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                    mint: ctx.accounts.wrapped_mint.to_account_info(),
                    mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                    whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                    destination: ctx.accounts.destination.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    /// Set the Civic gatekeeper network for self-registration.
    /// Only root authority. Pass Pubkey::default() to disable self-registration.
    /// Handles migration from pre-v2 PoolConfig accounts (expands if needed).
    pub fn set_gatekeeper_network(
        ctx: Context<SetGatekeeperNetwork>,
        gatekeeper_network: Pubkey,
    ) -> Result<()> {
        let account_info = &ctx.accounts.pool_config;
        let new_size = 8 + PoolConfig::INIT_SPACE;

        require!(
            account_info.owner == &crate::ID,
            GovernorError::Unauthorized
        );

        // Verify authority (at offset 8, first 32 bytes)
        let data = account_info.try_borrow_data()?;
        require!(data.len() >= 40, GovernorError::Unauthorized);
        let stored_authority = Pubkey::try_from(&data[8..40]).unwrap();
        require!(
            stored_authority == ctx.accounts.authority.key(),
            GovernorError::Unauthorized
        );
        drop(data);

        // Realloc if needed
        if account_info.data_len() < new_size {
            let rent = Rent::get()?;
            let diff = rent.minimum_balance(new_size).saturating_sub(account_info.lamports());
            if diff > 0 {
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        ctx.accounts.authority.key,
                        account_info.key,
                        diff,
                    ),
                    &[
                        ctx.accounts.authority.to_account_info(),
                        account_info.to_account_info(),
                    ],
                )?;
            }
            account_info.realloc(new_size, false)?;
        }

        // Write gatekeeper_network at offset (last field)
        // Layout: disc(8) + 10*pubkey(320) + decimals(1) + ltv(1) + liq_thresh(1)
        //   + status(1) + bump(1) = 333 bytes, then gatekeeper_network(32)
        let gk_offset = 8 + 32 * 10 + 5; // = 333
        let mut data = account_info.try_borrow_mut_data()?;
        data[gk_offset..gk_offset + 32].copy_from_slice(&gatekeeper_network.to_bytes());

        Ok(())
    }

    /// Self-register as a KYC'd holder by proving a valid Civic gateway token.
    /// The user signs and pays for their own whitelist PDA.
    /// Requires a valid, non-expired Civic pass from the pool's gatekeeper network.
    pub fn self_register(ctx: Context<SelfRegister>) -> Result<()> {
        let pool = &ctx.accounts.pool_config;

        // Ensure self-registration is enabled
        require!(
            pool.gatekeeper_network != Pubkey::default(),
            GovernorError::SelfRegisterDisabled
        );

        // Verify Civic gateway token
        let gateway_data = ctx.accounts.gateway_token.try_borrow_data()?;
        let pass = Pass::try_deserialize_unchecked(&mut &gateway_data[..])
            .map_err(|_| GovernorError::InvalidGatewayToken)?;
        require!(
            pass.valid(ctx.accounts.user.key, &pool.gatekeeper_network),
            GovernorError::InvalidGatewayToken
        );

        // CPI to delta-mint: whitelist the user via co-authority.
        // The pool_config PDA signs as the co_authority for delta-mint.
        let underlying = pool.underlying_mint;
        let bump = pool.bump;
        let seeds = &[
            b"pool".as_ref(),
            underlying.as_ref(),
            &[bump],
        ];

        delta_cpi::add_to_whitelist_with_co_authority(CpiContext::new_with_signer(
            ctx.accounts.delta_mint_program.to_account_info(),
            delta_accounts::AddToWhitelistCoAuth {
                co_authority: ctx.accounts.pool_config.to_account_info(),
                payer: ctx.accounts.user.to_account_info(),
                mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                wallet: ctx.accounts.user.to_account_info(),
                whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[seeds],
        ))?;

        emit!(SelfRegisterEvent {
            pool: ctx.accounts.pool_config.key(),
            wallet: ctx.accounts.user.key(),
            gatekeeper_network: pool.gatekeeper_network,
        });

        Ok(())
    }

    /// Freeze or unfreeze the pool. Only root authority.
    pub fn set_pool_status(ctx: Context<RootOnly>, status: PoolStatus) -> Result<()> {
        ctx.accounts.pool_config.status = status;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helper: check if signer is root authority or has an admin PDA
// ---------------------------------------------------------------------------

fn is_authorized(signer: &Pubkey, pool_authority: &Pubkey, pool_key: &Pubkey, admin_entry: &Option<Account<AdminEntry>>) -> bool {
    if signer == pool_authority {
        return true;
    }
    if let Some(admin) = admin_entry {
        return admin.wallet == *signer && admin.pool == *pool_key;
    }
    false
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PoolConfig::INIT_SPACE,
        seeds = [b"pool", underlying_mint.key().as_ref()],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: The underlying token mint (e.g., USDY).
    pub underlying_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub wrapped_mint: Signer<'info>,

    /// CHECK: delta-mint MintConfig PDA.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Root-authority-only operations (register market, freeze, manage admins).
#[derive(Accounts)]
pub struct RootOnly<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,
}

/// Set gatekeeper network — supports pre-v2 account migration.
#[derive(Accounts)]
pub struct SetGatekeeperNetwork<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PoolConfig PDA — manually validated and reallocated if needed.
    #[account(mut)]
    pub pool_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Add a new admin — root authority only.
#[derive(Accounts)]
pub struct ManageAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: The wallet to grant admin role.
    pub new_admin: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + AdminEntry::INIT_SPACE,
        seeds = [b"admin", pool_config.key().as_ref(), new_admin.key().as_ref()],
        bump,
    )]
    pub admin_entry: Account<'info, AdminEntry>,

    pub system_program: Program<'info, System>,
}

/// Remove an admin — root authority only.
#[derive(Accounts)]
pub struct RemoveAdmin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [b"admin", pool_config.key().as_ref(), admin_entry.wallet.as_ref()],
        bump = admin_entry.bump,
    )]
    pub admin_entry: Account<'info, AdminEntry>,
}

/// Add participant — root authority OR admin.
#[derive(Accounts)]
pub struct AddParticipant<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Optional admin PDA. Pass if signer is not root authority.
    pub admin_entry: Option<Account<'info, AdminEntry>>,

    /// CHECK: delta-mint MintConfig.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: The wallet to whitelist.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Self-register via Civic gateway token — permissionless.
#[derive(Accounts)]
pub struct SelfRegister<'info> {
    /// The user who wants to self-register. They sign and pay rent.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Pool config — used to read gatekeeper_network and as PDA signer for CPI.
    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: Civic gateway token — deserialized and verified in handler via Pass.
    pub gateway_token: UncheckedAccount<'info>,

    /// CHECK: delta-mint MintConfig — validated by address constraint.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Mint wrapped tokens — root authority OR admin.
#[derive(Accounts)]
pub struct MintWrapped<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Optional admin PDA. Pass if signer is not root authority.
    pub admin_entry: Option<Account<'info, AdminEntry>>,

    /// CHECK: delta-mint MintConfig.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapped Token-2022 mint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: Recipient token account.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub underlying_oracle: Pubkey,
    pub borrow_mint: Pubkey,
    pub borrow_oracle: Pubkey,
    pub wrapped_mint: Pubkey,
    pub dm_mint_config: Pubkey,
    pub lending_market: Pubkey,
    pub collateral_reserve: Pubkey,
    pub borrow_reserve: Pubkey,
    pub decimals: u8,
    pub ltv_pct: u8,
    pub liquidation_threshold_pct: u8,
    pub status: PoolStatus,
    pub bump: u8,
    /// Civic gatekeeper network for self-registration. Pubkey::default() = disabled.
    /// Added in v2 — must be at end for backwards compatibility with existing accounts.
    pub gatekeeper_network: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct AdminEntry {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    pub added_by: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    Initializing,
    Active,
    Frozen,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolParams {
    pub underlying_oracle: Pubkey,
    pub borrow_mint: Pubkey,
    pub borrow_oracle: Pubkey,
    pub decimals: u8,
    pub ltv_pct: u8,
    pub liquidation_threshold_pct: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantRole {
    Holder,
    Liquidator,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolCreatedEvent {
    pub pool: Pubkey,
    pub underlying_mint: Pubkey,
    pub wrapped_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct SelfRegisterEvent {
    pub pool: Pubkey,
    pub wallet: Pubkey,
    pub gatekeeper_network: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum GovernorError {
    #[msg("Pool is not in the expected status for this operation")]
    InvalidPoolStatus,
    #[msg("Pool is not active — register lending market first")]
    PoolNotActive,
    #[msg("Signer is not the pool authority or an approved admin")]
    Unauthorized,
    #[msg("Self-registration is not enabled for this pool")]
    SelfRegisterDisabled,
    #[msg("Invalid or expired Civic gateway token")]
    InvalidGatewayToken,
}
