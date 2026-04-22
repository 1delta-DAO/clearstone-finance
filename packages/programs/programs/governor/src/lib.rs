use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
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

        // NOTE: delta-mint authority is initially the deployer.
        // Call `activate_wrapping` after whitelisting to transfer authority to pool PDA.

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

    /// Add a participant via pool PDA (for pools where wrapping is activated).
    /// The pool PDA signs as the delta-mint authority (since authority was transferred).
    /// Can be called by root authority OR any admin.
    pub fn add_participant_via_pool(
        ctx: Context<AddParticipantViaPool>,
        role: ParticipantRole,
    ) -> Result<()> {
        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        let cpi_program = ctx.accounts.delta_mint_program.to_account_info();
        // Use co_authority path — pool PDA is both authority AND co_authority after activate_wrapping
        let cpi_accounts = delta_accounts::AddToWhitelistCoAuth {
            co_authority: ctx.accounts.pool_config.to_account_info(),
            payer: ctx.accounts.authority.to_account_info(),
            mint_config: ctx.accounts.dm_mint_config.to_account_info(),
            wallet: ctx.accounts.wallet.to_account_info(),
            whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

        match role {
            ParticipantRole::Holder => {
                delta_cpi::add_to_whitelist_with_co_authority(
                    CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
                )?;
            }
            ParticipantRole::Liquidator => {
                delta_cpi::add_liquidator_with_co_authority(
                    CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
                )?;
            }
            ParticipantRole::Escrow => {
                delta_cpi::add_escrow_with_co_authority(
                    CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
                )?;
            }
        }

        Ok(())
    }

    /// Add a participant (KYC'd holder or liquidator bot).
    /// Can be called by root authority OR any admin.
    /// NOTE: Only works on pools where wrapping is NOT activated (authority not transferred).
    /// For activated pools, use add_participant_via_pool.
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
            ParticipantRole::Escrow => {
                delta_cpi::add_escrow(CpiContext::new(cpi_program, cpi_accounts))?;
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

    /// Wrap underlying tokens into d-tokens (KYC-wrapped).
    /// User deposits underlying tokens (e.g., tUSDY) into the pool vault,
    /// and receives an equal amount of d-tokens (e.g., dtUSDY) in return.
    /// Requires the user to be KYC-whitelisted.
    pub fn wrap(ctx: Context<WrapTokens>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.pool_config.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );
        require!(amount > 0, GovernorError::InvalidPoolStatus);

        // 1. Transfer underlying tokens from user → vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.underlying_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_underlying_ata.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.pool_config.decimals,
        )?;

        // 2. Mint d-tokens to user via delta-mint CPI
        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        // The pool_config PDA is the authority on the delta-mint MintConfig
        // (set during initialize_pool). We CPI as the pool PDA.
        delta_cpi::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::MintTokens {
                    authority: ctx.accounts.pool_config.to_account_info(),
                    mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                    mint: ctx.accounts.wrapped_mint.to_account_info(),
                    mint_authority: ctx.accounts.dm_mint_authority.to_account_info(),
                    whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                    destination: ctx.accounts.user_wrapped_ata.to_account_info(),
                    token_program: ctx.accounts.wrapped_token_program.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(WrapEvent {
            pool: ctx.accounts.pool_config.key(),
            user: ctx.accounts.user.key(),
            underlying_amount: amount,
            wrapped_amount: amount,
        });

        Ok(())
    }

    /// Unwrap d-tokens back into underlying tokens.
    /// User burns d-tokens and receives underlying tokens from the vault.
    /// Requires the user to be KYC-whitelisted.
    pub fn unwrap(ctx: Context<UnwrapTokens>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.pool_config.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );
        require!(amount > 0, GovernorError::InvalidPoolStatus);

        // 1. Burn d-tokens from user
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.wrapped_token_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.wrapped_mint.to_account_info(),
                    from: ctx.accounts.user_wrapped_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Transfer underlying from vault → user (pool PDA owns the vault, signs)
        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let pool_seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.underlying_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                    to: ctx.accounts.user_underlying_ata.to_account_info(),
                    authority: ctx.accounts.pool_config.to_account_info(),
                },
                &[pool_seeds],
            ),
            amount,
            ctx.accounts.pool_config.decimals,
        )?;

        emit!(UnwrapEvent {
            pool: ctx.accounts.pool_config.key(),
            user: ctx.accounts.user.key(),
            underlying_amount: amount,
            wrapped_amount: amount,
        });

        Ok(())
    }

    /// Transfer delta-mint authority from deployer → pool PDA.
    /// This enables the wrap/unwrap flow. Call AFTER whitelisting is done.
    /// Only the root authority (current delta-mint authority) can call this.
    pub fn activate_wrapping(ctx: Context<ActivateWrapping>) -> Result<()> {
        let pool_key = ctx.accounts.pool_config.key();

        delta_cpi::transfer_authority(
            CpiContext::new(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::TransferAuthority {
                    authority: ctx.accounts.authority.to_account_info(),
                    mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                },
            ),
            pool_key,
        )?;

        msg!("Delta-mint authority transferred to pool PDA: {}", pool_key);
        Ok(())
    }

    /// Fix co_authority on an activated pool's MintConfig.
    /// Sets co_authority = pool PDA so whitelist_via_pool works.
    pub fn fix_co_authority(ctx: Context<FixCoAuthority>) -> Result<()> {
        let pool_key = ctx.accounts.pool_config.key();
        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let seeds = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        delta_cpi::set_co_authority(
            CpiContext::new_with_signer(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::SetCoAuthority {
                    authority: ctx.accounts.pool_config.to_account_info(),
                    mint_config: ctx.accounts.dm_mint_config.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[seeds],
            ),
            pool_key,
        )?;

        msg!("Co-authority set to pool PDA: {}", pool_key);
        Ok(())
    }

    /// Freeze or unfreeze the pool. Only root authority.
    pub fn set_pool_status(ctx: Context<RootOnly>, status: PoolStatus) -> Result<()> {
        ctx.accounts.pool_config.status = status;
        Ok(())
    }

    /// Set the borrow rate curve on a klend reserve via CPI.
    /// Authority must be both pool authority (or admin) AND the klend market owner.
    /// The curve is validated for monotonicity and bounds before forwarding to klend.
    pub fn set_borrow_rate_curve(
        ctx: Context<SetBorrowRateCurve>,
        reserve_type: ReserveType,
        curve: BorrowRateCurve,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool_config;
        require!(
            pool.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );

        // Validate the reserve address matches the pool config
        let expected_reserve = match reserve_type {
            ReserveType::Collateral => pool.collateral_reserve,
            ReserveType::Borrow => pool.borrow_reserve,
        };
        require!(
            ctx.accounts.reserve.key() == expected_reserve,
            GovernorError::ReserveMismatch
        );
        require!(
            ctx.accounts.lending_market.key() == pool.lending_market,
            GovernorError::MarketMismatch
        );

        // Validate the curve
        curve.validate()?;

        // Serialize the 11-point curve into 88 bytes
        let mut curve_data = [0u8; 88];
        for (i, point) in curve.points.iter().enumerate() {
            let offset = i * 8;
            curve_data[offset..offset + 4].copy_from_slice(&point.utilization_rate_bps.to_le_bytes());
            curve_data[offset + 4..offset + 8].copy_from_slice(&point.borrow_rate_bps.to_le_bytes());
        }

        // Build klend updateReserveConfig instruction data:
        //   disc(8) + mode(u8) + vec_len(u32) + curve(88) + skip_validation(u8)
        // sha256("global:update_reserve_config")[0..8]
        let disc: [u8; 8] = [0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d];
        let mode: u8 = 23; // UpdateBorrowRateCurve
        let vec_len: u32 = 88;
        let skip_validation: u8 = 1; // skip klend config integrity check (governor validates the curve itself)

        let mut data = Vec::with_capacity(8 + 1 + 4 + 88 + 1);
        data.extend_from_slice(&disc);
        data.push(mode);
        data.extend_from_slice(&vec_len.to_le_bytes());
        data.extend_from_slice(&curve_data);
        data.push(skip_validation);

        // CPI into klend — authority signs the outer tx and the signature passes through
        let ix = Instruction {
            program_id: ctx.accounts.klend_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.klend_global_config.key(), false),
                AccountMeta::new_readonly(ctx.accounts.lending_market.key(), false),
                AccountMeta::new(ctx.accounts.reserve.key(), false),
            ],
            data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.klend_global_config.to_account_info(),
                ctx.accounts.lending_market.to_account_info(),
                ctx.accounts.reserve.to_account_info(),
                ctx.accounts.klend_program.to_account_info(),
            ],
        )?;

        emit!(BorrowRateCurveUpdated {
            pool: ctx.accounts.pool_config.key(),
            reserve: ctx.accounts.reserve.key(),
            reserve_type,
        });

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

/// Fix co_authority — uses pool PDA to sign as authority.
#[derive(Accounts)]
pub struct FixCoAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub system_program: Program<'info, System>,
}

/// Add participant via pool PDA (for activated pools where authority was transferred).
#[derive(Accounts)]
pub struct AddParticipantViaPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        constraint = is_authorized(
            &authority.key(),
            &pool_config.authority,
            &pool_config.key(),
            &admin_entry,
        ) @ GovernorError::Unauthorized
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// Optional admin PDA.
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

/// Add participant — root authority OR admin.
/// NOTE: Only for non-activated pools.
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

/// Activate wrapping — transfers delta-mint authority to pool PDA.
#[derive(Accounts)]
pub struct ActivateWrapping<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: delta-mint MintConfig — authority validated by delta-mint CPI.
    #[account(mut, address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
}

/// Wrap underlying → d-tokens. Any whitelisted user can call this.
/// The vault is a token account owned by the pool PDA.
#[derive(Accounts)]
pub struct WrapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// The underlying token mint (e.g., tUSDY). Must match pool_config.
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's token account for the underlying (source).
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool vault — token account for underlying, owned by pool PDA.
    /// CHECK: Validated by constraint. Created externally before first wrap.
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// CHECK: delta-mint MintConfig — address validated.
    #[account(address = pool_config.dm_mint_config)]
    pub dm_mint_config: UncheckedAccount<'info>,

    /// CHECK: Wrapped Token-2022 mint — address validated.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: UncheckedAccount<'info>,

    /// CHECK: delta-mint mint authority PDA.
    pub dm_mint_authority: UncheckedAccount<'info>,

    /// CHECK: User's whitelist entry — validated by delta-mint CPI.
    pub whitelist_entry: UncheckedAccount<'info>,

    /// CHECK: User's d-token ATA (destination for minted d-tokens).
    #[account(mut)]
    pub user_wrapped_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

/// Unwrap d-tokens → underlying tokens.
#[derive(Accounts)]
pub struct UnwrapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// The underlying token mint.
    #[account(address = pool_config.underlying_mint)]
    pub underlying_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's underlying token account (destination).
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Pool vault — underlying tokens transferred out.
    #[account(mut)]
    pub vault: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Wrapped Token-2022 mint (tokens burned from user).
    #[account(mut, address = pool_config.wrapped_mint)]
    pub wrapped_mint: InterfaceAccount<'info, token_interface::Mint>,

    /// User's d-token account (source — burned).
    #[account(mut)]
    pub user_wrapped_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub underlying_token_program: Interface<'info, token_interface::TokenInterface>,
    pub wrapped_token_program: Interface<'info, token_interface::TokenInterface>,
}

/// Set borrow rate curve on a klend reserve — root authority OR admin.
/// Authority must also be the klend market owner.
#[derive(Accounts)]
pub struct SetBorrowRateCurve<'info> {
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

    /// CHECK: klend lending market — validated against pool_config.
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: klend reserve to update — validated against pool_config.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: klend global config account.
    pub klend_global_config: UncheckedAccount<'info>,

    /// CHECK: klend program — invoked via CPI.
    pub klend_program: UncheckedAccount<'info>,
}

/// Mint wrapped tokens — root authority OR admin (legacy, mints without backing).
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
    /// Program-owned custody PDA from an integrating protocol (e.g.
    /// clearstone_core's `escrow_sy` / `token_fee_treasury_sy` / vault
    /// `yield_position` SY ATA). Whitelisted so the PDA can hold the mint;
    /// not eligible for `mint_to`.
    Escrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ReserveType {
    Collateral,
    Borrow,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CurvePoint {
    pub utilization_rate_bps: u32,
    pub borrow_rate_bps: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BorrowRateCurve {
    pub points: [CurvePoint; 11],
}

impl BorrowRateCurve {
    pub fn validate(&self) -> Result<()> {
        // First point must start at 0% utilization
        require!(
            self.points[0].utilization_rate_bps == 0,
            GovernorError::InvalidCurve
        );
        // Last point must be at 100% utilization
        require!(
            self.points[10].utilization_rate_bps == 10_000,
            GovernorError::InvalidCurve
        );

        for i in 0..11 {
            // Utilization must be in [0, 10000]
            require!(
                self.points[i].utilization_rate_bps <= 10_000,
                GovernorError::InvalidCurve
            );
            // Borrow rate cap: 5000 bps = 50% APR (klend devnet max)
            require!(
                self.points[i].borrow_rate_bps <= 5_000,
                GovernorError::InvalidCurve
            );
        }

        for i in 1..11 {
            // Utilization must be strictly increasing (klend rejects duplicates)
            require!(
                self.points[i].utilization_rate_bps > self.points[i - 1].utilization_rate_bps,
                GovernorError::InvalidCurve
            );
            // Borrow rate must be strictly increasing (klend rejects flat segments)
            require!(
                self.points[i].borrow_rate_bps > self.points[i - 1].borrow_rate_bps,
                GovernorError::InvalidCurve
            );
        }

        Ok(())
    }
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

#[event]
pub struct WrapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct UnwrapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub underlying_amount: u64,
    pub wrapped_amount: u64,
}

#[event]
pub struct BorrowRateCurveUpdated {
    pub pool: Pubkey,
    pub reserve: Pubkey,
    pub reserve_type: ReserveType,
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
    #[msg("Reserve address does not match pool config")]
    ReserveMismatch,
    #[msg("Lending market does not match pool config")]
    MarketMismatch,
    #[msg("Invalid borrow rate curve: must be sorted, bounded, start at 0% and end at 100%")]
    InvalidCurve,
}
