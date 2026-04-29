use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::token_interface;
use delta_mint::cpi as delta_cpi;
use delta_mint::cpi::accounts as delta_accounts;
use delta_mint::program::DeltaMint as DeltaMintProgram;

mod civic_pass;
use civic_pass::Pass;

declare_id!("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

/// Jito Vault program ID (same on devnet + mainnet).
const JITO_VAULT_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
/// MintTo ix discriminator on the Jito Vault program (kinobi u8 enum).
const JITO_VAULT_MINT_TO_DISC: u8 = 11;
/// EnqueueWithdrawal ix discriminator on the Jito Vault program.
const JITO_VAULT_ENQUEUE_WITHDRAWAL_DISC: u8 = 12;
/// BurnWithdrawalTicket ix discriminator on the Jito Vault program.
const JITO_VAULT_BURN_WITHDRAWAL_TICKET_DISC: u8 = 14;

/// Maximum number of in-flight Jito withdrawal tickets queued by the pool
/// at any time. Per-pool, not per-user (with the ephemeral-base-keypair
/// pattern, a single user can spawn arbitrarily many tickets).
///
/// Capped at 120: total account size = 69 bytes overhead + 81 bytes/ticket
/// × 120 = 9789 bytes, comfortably under Solana's 10240-byte
/// `MAX_PERMITTED_DATA_INCREASE` cap that applies to Anchor's init flow.
/// To go higher, add a chunked `grow_withdraw_queue` ix that reallocs in
/// 10240-byte increments — deferred to v2.
///
/// If hit, `enqueue_withdraw_via_pool` rejects until matured tickets are
/// reaped via `mature_withdrawal_tickets`.
pub const MAX_WITHDRAW_QUEUE_TICKETS: usize = 120;

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
        pool.elevation_group = params.elevation_group;
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

    /// Set the klend elevation group for this pool. Only root authority.
    /// Handles migration from pre-v3 PoolConfig accounts (expands if needed).
    /// Note: this only updates the off-chain pool record; the actual klend
    /// reserve config still has to be applied via `update_reserve_config`.
    pub fn set_elevation_group(
        ctx: Context<SetElevationGroup>,
        elevation_group: u8,
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

        // Layout: disc(8) + 10*pubkey(320) + 5 small fields + gatekeeper(32) = 365,
        // then elevation_group(1).
        let eg_offset = 8 + 32 * 10 + 5 + 32; // = 365
        let mut data = account_info.try_borrow_mut_data()?;
        data[eg_offset] = elevation_group;

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
        let pass = Pass::try_deserialize_unchecked(&gateway_data[..])
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

    /// Wrap underlying into d-tokens AND deposit the underlying into a
    /// Jito Vault in the same transaction. The Jito Vault holds the
    /// canonical backing (VRT minted to a pool-PDA-owned VRT vault); the
    /// d-token (csSOL) is minted to the user 1:1 with the underlying as
    /// a fungible KYC-gated claim against pool VRT. This replaces the
    /// older `wrap`'s "park wSOL in a pool ATA" backing model.
    ///
    /// Flow:
    ///   1. Validate KYC (delta-mint::mint_to checks whitelist via CPI).
    ///   2. CPI Jito Vault MintTo. The pool PDA signs as `mintBurnAdmin`,
    ///      so the Vault's gate is satisfied without rotating it. User's
    ///      underlying ATA → vault's wSOL ATA. VRT → pool VRT vault.
    ///   3. CPI delta-mint::mint_to. Mints `amount` d-tokens to the user.
    ///
    /// Requires:
    ///   - Vault's `mintBurnAdmin` set to `pool_config` PDA
    ///     (one-time SetSecondaryAdmin during deploy).
    ///   - Pool VRT vault pre-created at ATA(vrt_mint, pool_pda, off_curve).
    ///   - User KYC-whitelisted on delta-mint.
    pub fn wrap_with_jito_vault(ctx: Context<WrapWithJitoVault>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.pool_config.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );
        require!(amount > 0, GovernorError::InvalidPoolStatus);

        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let pool_pda_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        // 1. Build + invoke Jito Vault MintTo manually. The Vault SDK is
        //    @solana/kit-native; we bypass it and emit the canonical ix.
        //    Account ordering per @jito-foundation/vault-sdk MintToInput:
        //       config, vault, vrtMint, depositor (signer, W),
        //       depositorTokenAccount (W), vaultTokenAccount (W),
        //       depositorVrtTokenAccount (W), vaultFeeTokenAccount (W),
        //       tokenProgram, mintSigner (signer).
        //    Args: u8 disc | u64 amountIn | u64 minAmountOut.
        let mut data = Vec::with_capacity(1 + 8 + 8);
        data.push(JITO_VAULT_MINT_TO_DISC);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes()); // minAmountOut = 0 (no slippage check at this layer)

        // Jito Vault enforces `depositor_vrt_token_account.owner == depositor`,
        // so VRT must mint to the user's own VRT ATA in this CPI. We then
        // transfer it onward to the pool VRT vault below — net effect: VRT
        // ends up under pool custody, csSOL is the user-facing token.
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
            AccountMeta::new(ctx.accounts.jito_vault.key(), false),
            AccountMeta::new(ctx.accounts.vrt_mint.key(), false),
            AccountMeta::new(ctx.accounts.user.key(), true),
            AccountMeta::new(ctx.accounts.user_underlying_ata.key(), false),
            AccountMeta::new(ctx.accounts.vault_st_token_account.key(), false),
            AccountMeta::new(ctx.accounts.user_vrt_token_account.key(), false),
            AccountMeta::new(ctx.accounts.vault_fee_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true),
        ];

        let ix = Instruction {
            program_id: JITO_VAULT_PROGRAM_ID,
            accounts: metas,
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.jito_vault_program.to_account_info(),
                ctx.accounts.jito_vault_config.to_account_info(),
                ctx.accounts.jito_vault.to_account_info(),
                ctx.accounts.vrt_mint.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.user_underlying_ata.to_account_info(),
                ctx.accounts.vault_st_token_account.to_account_info(),
                ctx.accounts.user_vrt_token_account.to_account_info(),
                ctx.accounts.vault_fee_token_account.to_account_info(),
                ctx.accounts.spl_token_program.to_account_info(),
                ctx.accounts.pool_config.to_account_info(),
            ],
            &[pool_pda_seeds],
        )?;

        // 1b. Sweep the freshly-minted VRT from user → pool VRT vault. The
        //     user signs as the source authority (already a Signer in this
        //     ix's accounts). After this transfer the VRT is under pool
        //     custody — pool can later redeem it through Jito Vault on
        //     behalf of csSOL holders during unwrap.
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.spl_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_vrt_token_account.to_account_info(),
                    mint: ctx.accounts.vrt_mint.to_account_info(),
                    to: ctx.accounts.pool_vrt_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            // VRT mint decimals == underlying decimals (set at vault init = 9 for our wSOL vault).
            ctx.accounts.pool_config.decimals,
        )?;

        // 2. Mint d-tokens to user via delta-mint CPI. The pool PDA is
        //    delta-mint's mint authority post-`activate_wrapping`.
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
                &[pool_pda_seeds],
            ),
            amount,
        )?;

        emit!(WrapWithJitoVaultEvent {
            pool: ctx.accounts.pool_config.key(),
            user: ctx.accounts.user.key(),
            jito_vault: ctx.accounts.jito_vault.key(),
            pool_vrt_token_account: ctx.accounts.pool_vrt_token_account.key(),
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

    // -----------------------------------------------------------------
    // csSOL-WT (withdraw ticket) flow — enqueue / mature / redeem
    // -----------------------------------------------------------------

    /// Pool-authority-only: register a Jito withdrawal ticket that
    /// already exists on-chain but is missing from the queue. Used to
    /// recover tickets stranded by layout migrations or by an early
    /// failure-then-success sequence where the ticket got created but
    /// the queue write didn't (e.g. partial-success orphans across our
    /// own program upgrades).
    ///
    /// The on-chain ticket account must:
    ///   - exist and be owned by the Jito Vault program
    ///   - have its `staker` field equal to the `staker` arg passed in
    ///   - have its `vault` field equal to the pool's csSOL Jito vault
    ///
    /// Validation lives in this ix (we read the raw bytes); we do NOT
    /// require the queue to deserialize correctly so this works after
    /// arbitrary layout changes.
    pub fn import_orphan_ticket(
        ctx: Context<ImportOrphanTicket>,
        staker: Pubkey,
        cssol_wt_amount: u64,
    ) -> Result<()> {
        // Read the Jito ticket bytes directly: discriminator(8) +
        // vault(32) + staker(32) + base(32) + vrt_amount(u64=8) +
        // slot_unstaked(u64=8) + ...
        let ticket_ai = &ctx.accounts.vault_staker_withdrawal_ticket;
        require_keys_eq!(
            *ticket_ai.owner,
            JITO_VAULT_PROGRAM_ID,
            GovernorError::Unauthorized
        );
        let data = ticket_ai.try_borrow_data()?;
        require!(data.len() >= 120, GovernorError::TicketNotFound);
        let onchain_vault = Pubkey::try_from(&data[8..40]).unwrap();
        let onchain_staker = Pubkey::try_from(&data[40..72]).unwrap();
        let slot_unstaked = u64::from_le_bytes(data[112..120].try_into().unwrap());
        drop(data);

        // The Jito ticket must belong to the right vault + the staker arg.
        require_keys_eq!(
            onchain_vault,
            ctx.accounts.jito_vault.key(),
            GovernorError::ReserveMismatch
        );
        require_keys_eq!(onchain_staker, staker, GovernorError::Unauthorized);

        // Reject duplicates.
        let queue = &mut ctx.accounts.withdraw_queue;
        let already = queue.tickets.iter().any(|t| t.ticket_pda == ticket_ai.key());
        require!(!already, GovernorError::WithdrawQueueFull);

        let live_count = queue.tickets.iter().filter(|t| !t.redeemed).count();
        require!(
            live_count < MAX_WITHDRAW_QUEUE_TICKETS,
            GovernorError::WithdrawQueueFull
        );

        queue.tickets.push(WithdrawTicket {
            ticket_pda: ticket_ai.key(),
            staker,
            cssol_wt_amount,
            created_at_slot: slot_unstaked,
            redeemed: false,
        });
        queue.total_cssol_wt_minted = queue.total_cssol_wt_minted.saturating_add(cssol_wt_amount);

        msg!(
            "Imported orphan ticket {} (staker={}, amount={}, slot_unstaked={})",
            ticket_ai.key(),
            staker,
            cssol_wt_amount,
            slot_unstaked,
        );
        Ok(())
    }

    /// Pool-authority-only: closes the WithdrawQueue PDA and refunds
    /// rent to the authority. Required when the layout changes (we
    /// added `staker: Pubkey` to WithdrawTicket post-v1) — Anchor's
    /// strict `Account<WithdrawQueue>` would refuse to deserialize the
    /// old-layout account, so we use UncheckedAccount + verify the PDA
    /// derivation ourselves. Re-run `init_withdraw_queue` afterwards.
    pub fn close_withdraw_queue(ctx: Context<CloseWithdrawQueue>) -> Result<()> {
        let pool_key = ctx.accounts.pool_config.key();
        let (expected, _bump) = Pubkey::find_program_address(
            &[b"withdraw_queue", pool_key.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(
            ctx.accounts.withdraw_queue.key(),
            expected,
            GovernorError::Unauthorized
        );
        require!(
            ctx.accounts.withdraw_queue.owner == &crate::ID,
            GovernorError::Unauthorized
        );

        // Drain lamports → authority and zero out the data, then
        // re-assign to the system program so a future
        // `init_withdraw_queue` can re-create the account fresh.
        let queue_ai = ctx.accounts.withdraw_queue.to_account_info();
        let auth_ai = ctx.accounts.authority.to_account_info();

        let lamports = queue_ai.lamports();
        **queue_ai.try_borrow_mut_lamports()? = 0;
        **auth_ai.try_borrow_mut_lamports()? = auth_ai.lamports().checked_add(lamports).unwrap();

        queue_ai.assign(&anchor_lang::solana_program::system_program::ID);
        queue_ai.resize(0)?;
        Ok(())
    }

    /// One-shot init of the per-pool `WithdrawQueue` PDA. Holds a bounded
    /// list of `{ticket_pda, staker, cssol_wt_amount, created_at_slot}` records,
    /// plus a counter of pending wSOL backing already in the pool's
    /// `pending_wsol_pool` ATA but not yet redeemed.
    pub fn init_withdraw_queue(ctx: Context<InitWithdrawQueue>) -> Result<()> {
        let pool_key = ctx.accounts.pool_config.key();
        let queue = &mut ctx.accounts.withdraw_queue;
        queue.pool_config = pool_key;
        queue.pending_wsol = 0;
        queue.total_cssol_wt_minted = 0;
        queue.total_cssol_wt_redeemed = 0;
        queue.tickets = Vec::new();
        queue.bump = ctx.bumps.withdraw_queue;
        msg!("WithdrawQueue initialized for pool {}", pool_key);
        Ok(())
    }

    /// User-facing entry that converts X csSOL into X csSOL-WT and
    /// queues X VRT for unstaking via Jito Vault. Permissionless (any
    /// KYC-whitelisted holder of csSOL can call). Inside one ix:
    ///
    ///   1. Token-2022 burn — X csSOL out of user's ATA (user signs as
    ///      authority; whitelist checked at the program level via the
    ///      `whitelist_entry` PDA passed in).
    ///   2. Jito EnqueueWithdrawal CPI — pool PDA (staker) burns X VRT
    ///      from `POOL_VRT_ATA`, ticket PDA + ticket-VRT-ATA hold the
    ///      VRT until epoch unlock. Pool PDA also signs as `base` and
    ///      `burn_signer` (mintBurnAdmin role on the vault).
    ///   3. delta-mint mint_to CPI — mints X csSOL-WT to user via the
    ///      pool PDA acting as authority on the *second* delta-mint
    ///      MintConfig (one per token).
    ///   4. Append a ticket record to the WithdrawQueue PDA.
    ///
    /// Calldata: u64 amount (in csSOL/VRT base units, decimals = 9).
    pub fn enqueue_withdraw_via_pool(ctx: Context<EnqueueWithdrawViaPool>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.pool_config.status == PoolStatus::Active,
            GovernorError::PoolNotActive
        );
        require!(amount > 0, GovernorError::InvalidPoolStatus);

        // Reject before any CPI if the queue is at cap. Each redeemed
        // entry is freed eagerly on `mature_withdrawal_tickets`, so a
        // healthy queue should never hit this.
        let live_count = ctx
            .accounts
            .withdraw_queue
            .tickets
            .iter()
            .filter(|t| !t.redeemed)
            .count();
        require!(
            live_count < MAX_WITHDRAW_QUEUE_TICKETS,
            GovernorError::WithdrawQueueFull
        );

        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        // 1. Burn X csSOL from user — Token-2022 path. csSOL is the
        //    `wrapped_mint` on the pool config. The user is the
        //    authority on their own ATA, so this is a direct CPI with
        //    only the user signing (no PDA seeds).
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.cssol_token_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.cssol_mint.to_account_info(),
                    from: ctx.accounts.user_cssol_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Move X VRT from POOL_VRT_ATA → user's VRT ATA. Pool PDA
        //    signs as the source authority. This puts the VRT under the
        //    user's wallet *transiently* — long enough for the next CPI
        //    (Jito EnqueueWithdrawal) to consume it, where the user is
        //    the staker.
        //    Why we can't keep VRT in pool custody and use pool_pda as
        //    the staker: Jito's EnqueueWithdrawal funds the new ticket
        //    PDA's rent via system_program::transfer(from=staker, ...),
        //    which requires `from` to be system-owned (no data). pool_pda
        //    is an Anchor-managed PoolConfig account with data → fails.
        //    User wallets are system-owned → works.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.spl_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.pool_vrt_token_account.to_account_info(),
                    mint: ctx.accounts.vrt_mint.to_account_info(),
                    to: ctx.accounts.user_vrt_token_account.to_account_info(),
                    authority: ctx.accounts.pool_config.to_account_info(),
                },
                &[pool_seeds],
            ),
            amount,
            ctx.accounts.pool_config.decimals, // VRT mint decimals = underlying decimals (9)
        )?;

        // 3. Jito EnqueueWithdrawal — split-signer setup:
        //    - staker = base = user (system-owned, funds the ticket
        //      PDA's rent via system_program::transfer; ticket is
        //      derived from base = user, so each user gets their own
        //      ticket PDA address space).
        //    - burn_signer = pool_pda (the vault's mint_burn_admin set
        //      at init, gates VRT-burning operations; signed via PDA
        //      seeds in invoke_signed).
        //    Together: user signs the outer governor ix (giving us
        //    user-signed staker+base), invoke_signed adds the pool PDA
        //    signature for burn_signer.
        let mut data = Vec::with_capacity(1 + 8);
        data.push(JITO_VAULT_ENQUEUE_WITHDRAWAL_DISC);
        data.extend_from_slice(&amount.to_le_bytes());

        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
            AccountMeta::new(ctx.accounts.jito_vault.key(), false),
            AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket.key(), false),
            AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket_token_account.key(), false),
            AccountMeta::new(ctx.accounts.user.key(), true),                 // staker (W, signer = user)
            AccountMeta::new(ctx.accounts.user_vrt_token_account.key(), false), // staker_vrt_token_account (W)
            AccountMeta::new_readonly(ctx.accounts.base.key(), true),        // base (RO, signer = ephemeral keypair)
            AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true), // burn_signer (RO, signer = pool_pda)
        ];

        let ix = Instruction {
            program_id: JITO_VAULT_PROGRAM_ID,
            accounts: metas,
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.jito_vault_program.to_account_info(),
                ctx.accounts.jito_vault_config.to_account_info(),
                ctx.accounts.jito_vault.to_account_info(),
                ctx.accounts.vault_staker_withdrawal_ticket.to_account_info(),
                ctx.accounts.vault_staker_withdrawal_ticket_token_account.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.user_vrt_token_account.to_account_info(),
                ctx.accounts.base.to_account_info(),
                ctx.accounts.spl_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.pool_config.to_account_info(),
            ],
            &[pool_seeds], // signs as burn_signer = pool_pda
        )?;

        // 3. Mint X csSOL-WT to user via delta-mint CPI. The pool PDA
        //    is the authority on the csSOL-WT mint config (set up by
        //    a separate one-time `activate_wt_wrapping`-equivalent
        //    deploy step). Whitelist is enforced inside delta-mint::mint_to.
        delta_cpi::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.delta_mint_program.to_account_info(),
                delta_accounts::MintTokens {
                    authority: ctx.accounts.pool_config.to_account_info(),
                    mint_config: ctx.accounts.cssol_wt_mint_config.to_account_info(),
                    mint: ctx.accounts.cssol_wt_mint.to_account_info(),
                    mint_authority: ctx.accounts.cssol_wt_mint_authority.to_account_info(),
                    whitelist_entry: ctx.accounts.whitelist_entry.to_account_info(),
                    destination: ctx.accounts.user_cssol_wt_ata.to_account_info(),
                    token_program: ctx.accounts.cssol_wt_token_program.to_account_info(),
                },
                &[pool_seeds],
            ),
            amount,
        )?;

        // 4. Append a ticket record to the queue. We always push a fresh
        //    entry; matured/redeemed slots are not reused (they're
        //    cleaned up on `mature_withdrawal_tickets` by truncating the
        //    leading run of redeemed entries).
        let ticket_pda = ctx.accounts.vault_staker_withdrawal_ticket.key();
        let staker = ctx.accounts.user.key();
        let now_slot = Clock::get()?.slot;
        let queue = &mut ctx.accounts.withdraw_queue;
        queue.tickets.push(WithdrawTicket {
            ticket_pda,
            staker,
            cssol_wt_amount: amount,
            created_at_slot: now_slot,
            redeemed: false,
        });
        queue.total_cssol_wt_minted = queue.total_cssol_wt_minted.saturating_add(amount);

        emit!(EnqueueWithdrawEvent {
            pool: ctx.accounts.pool_config.key(),
            user: ctx.accounts.user.key(),
            ticket: ticket_pda,
            cssol_burned: amount,
            cssol_wt_minted: amount,
            slot: now_slot,
        });

        Ok(())
    }

    /// Permissionless: once a Jito withdrawal ticket has cleared its
    /// epoch-lock window, anyone can call this to:
    ///   1. CPI BurnWithdrawalTicket on the Jito Vault — pool PDA signs as
    ///      `staker` + `burn_signer`. Underlying wSOL flows from the Jito
    ///      vault's `vault_token_account` into the pool's
    ///      `pending_wsol_pool` ATA.
    ///   2. Mark the matching queue entry `redeemed = true` and bump
    ///      `pending_wsol`.
    ///
    /// Multiple tickets per call are not supported in v1 — caller fires
    /// one ix per matured ticket. Cheap enough at devnet/mainnet rates,
    /// and keeps account-list sizing bounded.
    pub fn mature_withdrawal_tickets(ctx: Context<MatureWithdrawalTicket>) -> Result<()> {
        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        // Verify the ticket is in the queue, not yet redeemed, AND owned
        // by the calling user (matches Jito's own ticket.staker check —
        // error 1042 — but enforced earlier here so users get a clear
        // governor-side error if they try to crank someone else's ticket).
        let ticket_key = ctx.accounts.vault_staker_withdrawal_ticket.key();
        let user_key = ctx.accounts.user.key();
        let queue = &mut ctx.accounts.withdraw_queue;
        let entry_idx = queue
            .tickets
            .iter()
            .position(|t| t.ticket_pda == ticket_key && !t.redeemed)
            .ok_or(GovernorError::TicketNotFound)?;
        require!(
            queue.tickets[entry_idx].staker == user_key,
            GovernorError::Unauthorized
        );
        let cssol_wt_amount = queue.tickets[entry_idx].cssol_wt_amount;

        // 1. CPI BurnWithdrawalTicket — user is staker (matches the
        //    on-chain ticket.staker), pool PDA is burn_signer (matches
        //    vault.mint_burn_admin). wSOL flows from Jito vault to the
        //    user's wSOL ATA.
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.jito_vault_config.key(), false),
            AccountMeta::new(ctx.accounts.jito_vault.key(), false),
            AccountMeta::new(ctx.accounts.vault_st_token_account.key(), false), // vault_token_account
            AccountMeta::new(ctx.accounts.vrt_mint.key(), false),
            AccountMeta::new(ctx.accounts.user.key(), false),                   // staker (NOT signer per IDL — but address must match ticket.staker)
            AccountMeta::new(ctx.accounts.user_wsol_ata.key(), false),          // staker_token_account = where wSOL lands
            AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket.key(), false),
            AccountMeta::new(ctx.accounts.vault_staker_withdrawal_ticket_token_account.key(), false),
            AccountMeta::new(ctx.accounts.vault_fee_token_account.key(), false),
            AccountMeta::new(ctx.accounts.program_fee_token_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.spl_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool_config.key(), true),    // burn_signer (signer = pool PDA)
        ];

        let ix = Instruction {
            program_id: JITO_VAULT_PROGRAM_ID,
            accounts: metas,
            data: vec![JITO_VAULT_BURN_WITHDRAWAL_TICKET_DISC],
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.jito_vault_program.to_account_info(),
                ctx.accounts.jito_vault_config.to_account_info(),
                ctx.accounts.jito_vault.to_account_info(),
                ctx.accounts.vault_st_token_account.to_account_info(),
                ctx.accounts.vrt_mint.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.user_wsol_ata.to_account_info(),
                ctx.accounts.vault_staker_withdrawal_ticket.to_account_info(),
                ctx.accounts.vault_staker_withdrawal_ticket_token_account.to_account_info(),
                ctx.accounts.vault_fee_token_account.to_account_info(),
                ctx.accounts.program_fee_token_account.to_account_info(),
                ctx.accounts.spl_token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.pool_config.to_account_info(),
            ],
            &[pool_seeds],
        )?;

        // 2. Sweep the freshly-received wSOL from user's wSOL ATA into
        //    the pool's pending pool. User signs as authority (covered
        //    by the outer ix's user signature). Net effect: from the
        //    user's wallet view, the wSOL just transits — they get the
        //    1:1 redemption later via `redeem_cssol_wt` against the same
        //    pool.
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.spl_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_wsol_ata.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    to: ctx.accounts.pool_pending_wsol_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            cssol_wt_amount,
            ctx.accounts.pool_config.decimals,
        )?;

        // 3. Mark the entry redeemed + bump pending_wsol.
        queue.tickets[entry_idx].redeemed = true;
        queue.pending_wsol = queue.pending_wsol.saturating_add(cssol_wt_amount);

        // Compact the head: drop leading runs of redeemed entries to
        // keep the live-count probe in `enqueue_withdraw_via_pool` cheap.
        let drop = queue.tickets.iter().take_while(|t| t.redeemed).count();
        if drop > 0 {
            queue.tickets.drain(0..drop);
        }

        emit!(MatureTicketEvent {
            pool: ctx.accounts.pool_config.key(),
            ticket: ticket_key,
            wsol_payout: cssol_wt_amount,
        });

        Ok(())
    }

    /// User burns X csSOL-WT and receives X wSOL from the pool's
    /// `pending_wsol_pool`. Permissionless (any holder of csSOL-WT). The
    /// burn does not go through delta-mint — Token-2022 burn is a
    /// permissionless authority-of-holder action — but the user must
    /// have wSOL ATA receiving capability (whitelist not strictly
    /// required to receive wSOL, since wSOL is not delta-mint-gated).
    ///
    /// Reverts with `RedeemExceedsPending` if the queue's matured
    /// pool is short. Caller should fire `mature_withdrawal_tickets`
    /// against any unlocked ticket first.
    pub fn redeem_cssol_wt(ctx: Context<RedeemCsSolWt>, amount: u64) -> Result<()> {
        require!(amount > 0, GovernorError::InvalidPoolStatus);
        require!(
            ctx.accounts.withdraw_queue.pending_wsol >= amount,
            GovernorError::RedeemExceedsPending
        );

        let underlying = ctx.accounts.pool_config.underlying_mint;
        let bump = ctx.accounts.pool_config.bump;
        let pool_seeds: &[&[u8]] = &[b"pool".as_ref(), underlying.as_ref(), &[bump]];

        // 1. Burn X csSOL-WT from user (Token-2022, user signs as
        //    authority on their own ATA).
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.cssol_wt_token_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.cssol_wt_mint.to_account_info(),
                    from: ctx.accounts.user_cssol_wt_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Transfer X wSOL from pool's pending_wsol_pool → user's
        //    wSOL ATA. Pool PDA signs.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.spl_token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.pool_pending_wsol_ata.to_account_info(),
                    mint: ctx.accounts.wsol_mint.to_account_info(),
                    to: ctx.accounts.user_wsol_ata.to_account_info(),
                    authority: ctx.accounts.pool_config.to_account_info(),
                },
                &[pool_seeds],
            ),
            amount,
            ctx.accounts.pool_config.decimals,
        )?;

        let queue = &mut ctx.accounts.withdraw_queue;
        queue.pending_wsol = queue.pending_wsol.saturating_sub(amount);
        queue.total_cssol_wt_redeemed = queue.total_cssol_wt_redeemed.saturating_add(amount);

        emit!(RedeemCsSolWtEvent {
            pool: ctx.accounts.pool_config.key(),
            user: ctx.accounts.user.key(),
            cssol_wt_burned: amount,
            wsol_paid: amount,
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

/// Set elevation group — supports pre-v3 account migration.
#[derive(Accounts)]
pub struct SetElevationGroup<'info> {
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

/// Wrap underlying into d-tokens AND deposit underlying into a Jito Vault
/// in one tx. Pool PDA signs CPI MintTo as the Vault's `mintBurnAdmin`.
#[derive(Accounts)]
pub struct WrapWithJitoVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Pool config — keyed by underlying mint, signs CPIs as mintBurnAdmin
    /// + delta-mint authority. Marked mut because delta-mint::mint_to
    /// expects the signer (us, via PDA) as a writable account.
    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// User's underlying token account — source of wSOL transferred into
    /// the Jito Vault during MintTo.
    #[account(mut)]
    pub user_underlying_ata: InterfaceAccount<'info, token_interface::TokenAccount>,

    // ── Jito Vault accounts ─────────────────────────────────────────────
    /// CHECK: program id check inside the ix.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// CHECK: Jito Vault Config singleton PDA.
    pub jito_vault_config: UncheckedAccount<'info>,

    /// CHECK: our Jito Vault PDA.
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,

    /// CHECK: VRT mint owned by Jito Vault.
    #[account(mut)]
    pub vrt_mint: UncheckedAccount<'info>,

    /// CHECK: Vault's underlying-token ATA — receives the user's wSOL.
    #[account(mut)]
    pub vault_st_token_account: UncheckedAccount<'info>,

    /// CHECK: User's VRT ATA — Jito Vault MintTo enforces
    /// `depositor_vrt.owner == depositor`, so VRT mints here first. The
    /// next step in the same ix sweeps it to `pool_vrt_token_account`.
    #[account(mut)]
    pub user_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Pool's VRT vault — ATA(vrt_mint, pool_pda, off_curve).
    /// Final destination of the freshly-minted VRT. Pool holds the
    /// canonical backing for csSOL supply.
    #[account(mut)]
    pub pool_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Vault's fee VRT ATA — checked by Jito Vault program.
    #[account(mut)]
    pub vault_fee_token_account: UncheckedAccount<'info>,

    /// CHECK: SPL Token program (Jito Vault expects classic SPL Token for wSOL/VRT).
    pub spl_token_program: UncheckedAccount<'info>,

    // ── delta-mint accounts ─────────────────────────────────────────────
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

    /// CHECK: User's d-token ATA — destination for minted csSOL.
    #[account(mut)]
    pub user_wrapped_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,
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
    /// Klend elevation group this pool's reserves belong to. 0 = no group.
    /// Added in v3 — appended after `gatekeeper_network` for backwards compatibility.
    pub elevation_group: u8,
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
    /// Klend elevation group for the reserve pair. 0 = no group.
    pub elevation_group: u8,
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
pub struct WrapWithJitoVaultEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub jito_vault: Pubkey,
    pub pool_vrt_token_account: Pubkey,
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
    #[msg("Withdraw queue is at capacity — wait for matured tickets to be reaped before enqueueing more")]
    WithdrawQueueFull,
    #[msg("Withdrawal ticket is not in this pool's queue or already redeemed")]
    TicketNotFound,
    #[msg("Redeem amount exceeds the queue's currently-matured wSOL pool")]
    RedeemExceedsPending,
}

// ---------------------------------------------------------------------------
// csSOL-WT (withdraw ticket) state + accounts + events
// ---------------------------------------------------------------------------

#[account]
pub struct WithdrawQueue {
    /// Pool this queue belongs to.
    pub pool_config: Pubkey,
    /// wSOL currently sitting in `pool_pending_wsol_pool` that has been
    /// matured from a Jito ticket but not yet redeemed by a csSOL-WT
    /// burn. Mirrors `pool_pending_wsol_ata`'s real balance modulo
    /// dust / on-chain rounding.
    pub pending_wsol: u64,
    /// Lifetime totals for analytics + reconciliation.
    pub total_cssol_wt_minted: u64,
    pub total_cssol_wt_redeemed: u64,
    /// Bounded list of in-flight tickets. Capacity-checked in
    /// `enqueue_withdraw_via_pool`. Redeemed entries are eagerly
    /// drained from the head on `mature_withdrawal_tickets`.
    pub tickets: Vec<WithdrawTicket>,
    pub bump: u8,
}

impl WithdrawQueue {
    /// 32 (pool_config) + 8 (pending_wsol) + 8 (minted) + 8 (redeemed)
    ///   + 4 (Vec len prefix) + N * sizeof(WithdrawTicket) + 1 (bump)
    /// WithdrawTicket = 32 + 32 + 8 + 8 + 1 = 81.
    pub const INIT_SPACE: usize = 32 + 8 + 8 + 8 + 4 + (MAX_WITHDRAW_QUEUE_TICKETS * 81) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawTicket {
    /// The Jito Vault `VaultStakerWithdrawalTicket` PDA we own.
    pub ticket_pda: Pubkey,
    /// The user who originally enqueued this ticket and is the
    /// `base` + `staker` of the underlying Jito ticket. Required for
    /// `mature_withdrawal_tickets` to satisfy Jito's check
    /// `ticket.staker == provided_staker` (error 1042). Also lets the
    /// playground UI filter "your tickets" without a per-ticket
    /// extra RPC fetch.
    pub staker: Pubkey,
    /// csSOL-WT minted to the requester at enqueue-time. wSOL payout
    /// after Jito unlock will land 1:1 against this (less any vault
    /// fees, which Jito takes inside its own ix and we do not
    /// double-account here).
    pub cssol_wt_amount: u64,
    /// Slot at which the ticket was enqueued. Useful for off-chain
    /// "should this be matured yet?" reasoning; the on-chain unlock
    /// gate is enforced by Jito Vault itself, not by us.
    pub created_at_slot: u64,
    /// True once `mature_withdrawal_tickets` has redeemed this entry
    /// against Jito (wSOL has flowed into our pending pool).
    pub redeemed: bool,
}

#[event]
pub struct EnqueueWithdrawEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub ticket: Pubkey,
    pub cssol_burned: u64,
    pub cssol_wt_minted: u64,
    pub slot: u64,
}

#[event]
pub struct MatureTicketEvent {
    pub pool: Pubkey,
    pub ticket: Pubkey,
    pub wsol_payout: u64,
}

#[event]
pub struct RedeemCsSolWtEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub cssol_wt_burned: u64,
    pub wsol_paid: u64,
}

// ---------------------------------------------------------------------------
// Account contexts for the csSOL-WT flow
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ImportOrphanTicket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    /// CHECK: csSOL Jito vault — used to verify the orphan's vault.
    pub jito_vault: UncheckedAccount<'info>,

    /// CHECK: orphan ticket PDA on the Jito Vault program. Validated
    /// inside the ix (owner must equal Jito Vault, vault field must
    /// match `jito_vault`, staker field must match the `staker` arg).
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseWithdrawQueue<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: validated inside the ix via PDA derivation against the
    /// pool config; we use UncheckedAccount so old-layout queues can
    /// still be closed (the old data won't deserialize against the
    /// new WithdrawQueue layout).
    #[account(mut)]
    pub withdraw_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitWithdrawQueue<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
        has_one = authority,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + WithdrawQueue::INIT_SPACE,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnqueueWithdrawViaPool<'info> {
    /// The user requesting the unstake. Pays the Jito ticket creation
    /// rent + the Solana base fee; signs the Token-2022 burn for csSOL.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Ephemeral keypair the client generates for *this* enqueue. Used
    /// as Jito's `base` for the ticket PDA so each enqueue produces a
    /// unique ticket address (so the user isn't blocked from a second
    /// enqueue while their first ticket is still locked). Not stored
    /// anywhere — once the ticket exists, the client can discard the
    /// keypair; only the ticket_pda matters going forward.
    pub base: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // ── csSOL (the token being burned) ──
    /// CHECK: csSOL Token-2022 mint, pinned via pool_config.wrapped_mint.
    #[account(mut, address = pool_config.wrapped_mint)]
    pub cssol_mint: UncheckedAccount<'info>,

    /// CHECK: user's csSOL ATA, validated by the Token-2022 burn CPI.
    #[account(mut)]
    pub user_cssol_ata: UncheckedAccount<'info>,

    /// SPL Token-2022 program (csSOL is a Token-2022 mint).
    pub cssol_token_program: Interface<'info, token_interface::TokenInterface>,

    // ── Jito Vault EnqueueWithdrawal accounts ──
    /// CHECK: Jito Vault Config PDA — validated by Jito CPI.
    pub jito_vault_config: UncheckedAccount<'info>,
    /// CHECK: Jito Vault account (the csSOL Jito vault).
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,
    /// CHECK: VaultStakerWithdrawalTicket PDA — created by the Jito CPI.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
    /// CHECK: ticket-owned VRT ATA — created by the Jito CPI.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket_token_account: UncheckedAccount<'info>,
    /// CHECK: pool's VRT ATA — source of VRT moved transiently to user
    /// before the Jito EnqueueWithdrawal CPI. Pool PDA is the authority.
    #[account(mut)]
    pub pool_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: VRT mint — needed for transfer_checked decimals validation
    /// when moving VRT pool→user.
    pub vrt_mint: UncheckedAccount<'info>,

    /// CHECK: user's VRT ATA — VRT lands here transiently from pool, then
    /// is consumed by the Jito EnqueueWithdrawal CPI within the same ix.
    #[account(mut)]
    pub user_vrt_token_account: UncheckedAccount<'info>,

    /// CHECK: Jito Vault program ID.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// SPL Token program (regular, not 2022) — VRT is SPL Token.
    /// CHECK: pinned to canonical Token program by Jito CPI.
    pub spl_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    // ── delta-mint csSOL-WT mint accounts ──
    /// CHECK: csSOL-WT mint config (a *separate* delta-mint MintConfig
    /// from the csSOL one). Validated by the delta-mint CPI.
    #[account(mut)]
    pub cssol_wt_mint_config: UncheckedAccount<'info>,
    /// CHECK: csSOL-WT mint (Token-2022, KYC-gated via delta-mint).
    #[account(mut)]
    pub cssol_wt_mint: UncheckedAccount<'info>,
    /// CHECK: delta-mint MintAuthority PDA for csSOL-WT.
    pub cssol_wt_mint_authority: UncheckedAccount<'info>,
    /// CHECK: user's whitelist entry on the csSOL-WT mint config —
    /// validated by delta-mint::mint_to.
    pub whitelist_entry: UncheckedAccount<'info>,
    /// CHECK: user's csSOL-WT ATA — receives the freshly-minted WT.
    #[account(mut)]
    pub user_cssol_wt_ata: UncheckedAccount<'info>,

    pub delta_mint_program: Program<'info, DeltaMintProgram>,

    /// SPL Token-2022 program (csSOL-WT is also Token-2022).
    pub cssol_wt_token_program: Interface<'info, token_interface::TokenInterface>,
}

#[derive(Accounts)]
pub struct MatureWithdrawalTicket<'info> {
    /// The original ticket creator. Must match the staker recorded in
    /// the queue entry AND in the underlying Jito ticket. Pays the
    /// base fee. Maturation is therefore NOT permissionless — only
    /// the user who enqueued can mature their own ticket. This is a
    /// requirement of Jito's `ticket.staker == provided_staker` check
    /// and a correctness requirement of our pool accounting (we sweep
    /// the matured wSOL through this user's wSOL ATA).
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // ── Jito Vault BurnWithdrawalTicket accounts ──
    /// CHECK: Jito Vault Config PDA.
    pub jito_vault_config: UncheckedAccount<'info>,
    /// CHECK: csSOL Jito Vault account.
    #[account(mut)]
    pub jito_vault: UncheckedAccount<'info>,
    /// CHECK: vault's underlying (wSOL) ATA — wSOL flows out from here.
    #[account(mut)]
    pub vault_st_token_account: UncheckedAccount<'info>,
    /// CHECK: VRT mint.
    #[account(mut)]
    pub vrt_mint: UncheckedAccount<'info>,
    /// CHECK: NATIVE_MINT (wSOL) — needed for transfer_checked.
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: user's wSOL ATA — Jito BurnWithdrawalTicket sends wSOL
    /// here first, then we sweep it into pool_pending_wsol_ata
    /// inside the same ix.
    #[account(mut)]
    pub user_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: pool's pending-wSOL ATA — final destination of the wSOL
    /// after the same-ix sweep. Used by `redeem_cssol_wt` as the
    /// payout source.
    #[account(mut)]
    pub pool_pending_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: ticket PDA being burned.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket: UncheckedAccount<'info>,
    /// CHECK: ticket's VRT ATA being closed.
    #[account(mut)]
    pub vault_staker_withdrawal_ticket_token_account: UncheckedAccount<'info>,
    /// CHECK: vault fee ATA.
    #[account(mut)]
    pub vault_fee_token_account: UncheckedAccount<'info>,
    /// CHECK: program fee ATA.
    #[account(mut)]
    pub program_fee_token_account: UncheckedAccount<'info>,

    /// CHECK: Jito Vault program.
    #[account(address = JITO_VAULT_PROGRAM_ID)]
    pub jito_vault_program: UncheckedAccount<'info>,

    /// CHECK: SPL Token program (regular Token, not Token-2022 — wSOL is SPL Token).
    pub spl_token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemCsSolWt<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool_config.underlying_mint.as_ref()],
        bump = pool_config.bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [b"withdraw_queue", pool_config.key().as_ref()],
        bump = withdraw_queue.bump,
        has_one = pool_config,
    )]
    pub withdraw_queue: Account<'info, WithdrawQueue>,

    // csSOL-WT side (burn) — Token-2022.
    /// CHECK: csSOL-WT mint.
    #[account(mut)]
    pub cssol_wt_mint: UncheckedAccount<'info>,
    /// CHECK: user's csSOL-WT ATA.
    #[account(mut)]
    pub user_cssol_wt_ata: UncheckedAccount<'info>,
    pub cssol_wt_token_program: Interface<'info, token_interface::TokenInterface>,

    // wSOL side (transfer pool→user).
    /// CHECK: NATIVE_MINT pubkey, fixed.
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: pool's pending-wSOL ATA.
    #[account(mut)]
    pub pool_pending_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: user's wSOL ATA.
    #[account(mut)]
    pub user_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: SPL Token program (wSOL is regular SPL Token).
    pub spl_token_program: UncheckedAccount<'info>,
}
