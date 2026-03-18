use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

declare_id!("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

#[program]
pub mod governor {
    use super::*;

    /// Step 1: Create a new KYC-gated lending pool.
    /// Stores the pool config and creates the wrapped Token-2022 mint
    /// (with confidential transfer extension) via CPI to delta-mint.
    ///
    /// After this, call `register_lending_market` once the klend market
    /// and reserves have been created off-chain.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        params: PoolParams,
    ) -> Result<()> {
        // Capture keys before mutable borrow
        let pool_key = ctx.accounts.pool_config.key();
        let authority_key = ctx.accounts.authority.key();
        let underlying_key = ctx.accounts.underlying_mint.key();
        let wrapped_key = ctx.accounts.wrapped_mint.key();
        let dm_config_key = ctx.accounts.dm_mint_config.key();

        // 1. Store pool configuration
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
        pool.status = PoolStatus::Initializing;

        // 2. CPI → delta-mint: create the wrapped Token-2022 mint
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

    /// Step 2: Register the klend market and reserve addresses after off-chain creation.
    /// Transitions the pool from Initializing → Active.
    pub fn register_lending_market(
        ctx: Context<UpdatePool>,
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

    /// Add a participant (KYC'd holder or liquidator bot) to the pool.
    /// Delegates to delta-mint's add_to_whitelist or add_liquidator via CPI.
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
    /// Only works when pool is Active and recipient has Holder role.
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

    /// Freeze or unfreeze the pool.
    pub fn set_pool_status(ctx: Context<UpdatePool>, status: PoolStatus) -> Result<()> {
        ctx.accounts.pool_config.status = status;
        Ok(())
    }
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

    /// CHECK: The underlying token mint (e.g., USDY). Stored for reference only.
    pub underlying_mint: UncheckedAccount<'info>,

    /// New Token-2022 mint keypair for the KYC-wrapped token.
    #[account(mut)]
    pub wrapped_mint: Signer<'info>,

    /// CHECK: delta-mint MintConfig PDA — created and validated by delta-mint CPI.
    #[account(mut)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA — validated by delta-mint CPI.
    pub dm_mint_authority: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,
}

#[derive(Accounts)]
pub struct AddParticipant<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig — validated by delta-mint CPI.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: The wallet to whitelist — does not need to sign.
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry PDA — created by delta-mint CPI.
    #[account(mut)]
    pub whitelist_entry: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintWrapped<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig — validated by address constraint.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapped Token-2022 mint — validated by address constraint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA — validated by delta-mint CPI.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: WhitelistEntry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: Recipient token account — validated by delta-mint CPI.
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
    /// Pool authority (can whitelist, mint, configure).
    pub authority: Pubkey,
    /// Underlying token (e.g., USDY).
    pub underlying_mint: Pubkey,
    /// Pyth oracle for the underlying token.
    pub underlying_oracle: Pubkey,
    /// Borrow asset (e.g., USDC).
    pub borrow_mint: Pubkey,
    /// Pyth oracle for the borrow asset.
    pub borrow_oracle: Pubkey,
    /// The KYC-wrapped Token-2022 mint (e.g., dUSDY).
    pub wrapped_mint: Pubkey,
    /// delta-mint MintConfig PDA for the wrapped token.
    pub dm_mint_config: Pubkey,
    /// Kamino lending market address (set after off-chain creation).
    pub lending_market: Pubkey,
    /// Kamino collateral reserve (wrapped token).
    pub collateral_reserve: Pubkey,
    /// Kamino borrow reserve (e.g., USDC).
    pub borrow_reserve: Pubkey,
    /// Token decimals.
    pub decimals: u8,
    /// Loan-to-value percentage.
    pub ltv_pct: u8,
    /// Liquidation threshold percentage.
    pub liquidation_threshold_pct: u8,
    /// Pool lifecycle status.
    pub status: PoolStatus,
    /// PDA bump.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    /// Pool created, wrapped mint ready, klend market not yet registered.
    Initializing,
    /// Fully configured — minting and lending active.
    Active,
    /// Emergency freeze — no new mints or deposits.
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum GovernorError {
    #[msg("Pool is not in the expected status for this operation")]
    InvalidPoolStatus,
    #[msg("Pool is not active — register lending market first")]
    PoolNotActive,
}
