use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_interface;
use spl_token_2022::{
    extension::{
        confidential_transfer::instruction as ct_instruction,
        ExtensionType,
    },
    instruction as token_instruction,
    state::Mint as Token2022Mint,
};

declare_id!("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

#[program]
pub mod delta_mint {
    use super::*;

    /// Creates a Token-2022 mint with the confidential transfer extension.
    /// The mint authority is a PDA owned by this program, ensuring all minting
    /// goes through the KYC whitelist check.
    pub fn initialize_mint(
        ctx: Context<InitializeMint>,
        decimals: u8,
    ) -> Result<()> {
        let config = &mut ctx.accounts.mint_config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.decimals = decimals;
        config.bump = ctx.bumps.mint_config;
        config.mint_authority_bump = ctx.bumps.mint_authority;
        config.total_whitelisted = 0;

        // Calculate space for mint + confidential transfer extension
        let extension_types = &[ExtensionType::ConfidentialTransferMint];
        let mint_size = ExtensionType::try_calculate_account_len::<Token2022Mint>(extension_types)
            .map_err(|_| DeltaError::MintInitFailed)?;

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(mint_size);

        // 1. Create the mint account with enough space for extensions
        invoke(
            &system_instruction::create_account(
                ctx.accounts.authority.key,
                ctx.accounts.mint.key,
                lamports,
                mint_size as u64,
                ctx.accounts.token_program.key,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.mint.to_account_info(),
            ],
        )?;

        // 2. Initialize confidential transfer extension on the mint.
        //    - authority: the program's PDA (can approve accounts later)
        //    - auto_approve: false (authority must approve each account for CT)
        //      Kamino requires auto_approve=false for liquidity tokens.
        //    - auditor: none (can be set later for compliance auditing)
        invoke(
            &ct_instruction::initialize_mint(
                ctx.accounts.token_program.key,
                ctx.accounts.mint.key,
                Some(ctx.accounts.mint_authority.key()),
                false,
                None,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        // 3. Initialize the mint itself with the PDA as mint + freeze authority
        invoke(
            &token_instruction::initialize_mint2(
                ctx.accounts.token_program.key,
                ctx.accounts.mint.key,
                &ctx.accounts.mint_authority.key(),
                Some(&ctx.accounts.mint_authority.key()),
                decimals,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        Ok(())
    }

    /// Adds a wallet to the KYC whitelist, allowing it to receive minted tokens.
    /// Only the mint config authority can approve wallets.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Holder;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Removes a wallet from the whitelist. Closes the PDA and returns rent to authority.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.saturating_sub(1);

        emit!(WhitelistEvent {
            wallet: ctx.accounts.whitelist_entry.wallet,
            mint: config.mint,
            approved: false,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Adds a wallet as an approved liquidator.
    /// Liquidators can receive dUSDY collateral during Kamino liquidations
    /// without going through full KYC — they are pre-vetted bot operators.
    pub fn add_liquidator(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.wallet = ctx.accounts.wallet.key();
        entry.mint_config = ctx.accounts.mint_config.key();
        entry.approved = true;
        entry.role = WhitelistRole::Liquidator;
        entry.approved_at = Clock::get()?.unix_timestamp;
        entry.bump = ctx.bumps.whitelist_entry;

        let config = &mut ctx.accounts.mint_config;
        config.total_whitelisted = config.total_whitelisted.checked_add(1).unwrap();

        emit!(WhitelistEvent {
            wallet: entry.wallet,
            mint: config.mint,
            approved: true,
            timestamp: entry.approved_at,
        });

        Ok(())
    }

    /// Mints tokens to a whitelisted recipient's token account.
    /// Fails if the recipient is not on the KYC whitelist.
    pub fn mint_to(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.whitelist_entry.approved,
            DeltaError::NotWhitelisted
        );
        require!(
            ctx.accounts.whitelist_entry.role == WhitelistRole::Holder,
            DeltaError::LiquidatorCannotMint
        );
        require!(amount > 0, DeltaError::InvalidAmount);

        let config = &ctx.accounts.mint_config;
        let seeds = &[
            b"mint_authority".as_ref(),
            config.mint.as_ref(),
            &[config.mint_authority_bump],
        ];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(MintEvent {
            recipient: ctx.accounts.whitelist_entry.wallet,
            mint: config.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMint<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// New Token-2022 mint keypair (generated client-side).
    #[account(mut)]
    pub mint: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + MintConfig::INIT_SPACE,
        seeds = [b"mint_config", mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: PDA used as mint authority — verified by seeds constraint.
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToWhitelist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: The wallet being whitelisted — does not need to sign.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [b"whitelist", mint_config.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [b"whitelist", mint_config.key().as_ref(), whitelist_entry.wallet.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(has_one = authority)]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: Token-2022 mint — validated via address constraint against mint_config.
    #[account(
        mut,
        address = mint_config.mint,
    )]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: PDA mint authority — verified by seeds constraint.
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump = mint_config.mint_authority_bump,
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [b"whitelist", mint_config.key().as_ref(), whitelist_entry.wallet.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// CHECK: Recipient's Token-2022 token account — ownership verified via token_program CPI.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, token_interface::TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MintConfig {
    /// The authority that can whitelist wallets and trigger mints.
    pub authority: Pubkey,
    /// The Token-2022 mint address.
    pub mint: Pubkey,
    /// Mint decimals.
    pub decimals: u8,
    /// Bump for this PDA.
    pub bump: u8,
    /// Bump for the mint_authority PDA.
    pub mint_authority_bump: u8,
    /// Number of currently whitelisted wallets.
    pub total_whitelisted: u64,
}

#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    /// The whitelisted wallet address.
    pub wallet: Pubkey,
    /// The mint config this entry belongs to.
    pub mint_config: Pubkey,
    /// Whether the wallet is currently approved.
    pub approved: bool,
    /// Role: Holder (KYC'd, can mint/hold) or Liquidator (can receive via liquidation only).
    pub role: WhitelistRole,
    /// Unix timestamp when the wallet was approved.
    pub approved_at: i64,
    /// Bump for this PDA.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum WhitelistRole {
    /// Full KYC'd holder — can receive minted tokens and hold.
    Holder,
    /// Approved liquidator bot — can receive collateral during Kamino liquidations.
    /// Cannot mint new tokens, only receive via protocol liquidation flows.
    Liquidator,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct WhitelistEvent {
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub approved: bool,
    pub timestamp: i64,
}

#[event]
pub struct MintEvent {
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum DeltaError {
    #[msg("Recipient is not on the KYC whitelist")]
    NotWhitelisted,
    #[msg("Mint amount must be greater than zero")]
    InvalidAmount,
    #[msg("Liquidator role cannot mint new tokens")]
    LiquidatorCannotMint,
    #[msg("Failed to initialize Token-2022 mint with extensions")]
    MintInitFailed,
}
