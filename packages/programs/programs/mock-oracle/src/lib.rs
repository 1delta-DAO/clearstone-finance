use anchor_lang::prelude::*;

declare_id!("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");

/// FixedPriceOracle — A simple oracle for devnet/testing.
///
/// Creates accounts with Pyth V2-compatible binary layout so klend can parse them.
/// Each feed is a PDA derived from [b"feed", label], making addresses deterministic.
///
/// Note: klend may reject these if it checks oracle.owner == pyth_program.
/// In that case, use a local validator with `--clone` from mainnet.
#[program]
pub mod mock_oracle {
    use super::*;

    /// Create a new fixed-price feed PDA.
    pub fn create_feed(
        ctx: Context<CreateFeed>,
        label: String,
        price: i64,
        expo: i32,
    ) -> Result<()> {
        let feed = &mut ctx.accounts.price_feed;
        feed.authority = ctx.accounts.authority.key();
        feed.label = pad_label(&label);
        feed.price = price;
        feed.expo = expo;
        feed.last_update_slot = Clock::get()?.slot;
        feed.bump = ctx.bumps.price_feed;
        Ok(())
    }

    /// Update the price of an existing feed.
    pub fn set_price(
        ctx: Context<UpdateFeed>,
        price: i64,
    ) -> Result<()> {
        let feed = &mut ctx.accounts.price_feed;
        feed.price = price;
        feed.last_update_slot = Clock::get()?.slot;
        Ok(())
    }

    /// Write Pyth V2-compatible binary data to a raw account owned by this program.
    /// Used to create oracle accounts that klend's Pyth parser can read.
    /// Account must be created externally via SystemProgram.createAccount with owner=this program.
    pub fn write_pyth_v2(
        ctx: Context<WritePythV2>,
        price: i64,
        expo: i32,
    ) -> Result<()> {
        let feed = &ctx.accounts.raw_feed;
        let slot = Clock::get()?.slot;
        let mut data = feed.try_borrow_mut_data()?;

        // Pyth V2 price account layout (3312 bytes)
        write_le(&mut data, 0, &0xa1b2c3d4u32.to_le_bytes()); // magic
        write_le(&mut data, 4, &2u32.to_le_bytes());           // version
        write_le(&mut data, 8, &3u32.to_le_bytes());           // type = price
        write_le(&mut data, 52, &expo.to_le_bytes());          // exponent
        write_le(&mut data, 56, &1u32.to_le_bytes());          // num components
        write_le(&mut data, 208, &price.to_le_bytes());        // price
        write_le(&mut data, 216, &10000u64.to_le_bytes());     // conf
        write_le(&mut data, 224, &1u32.to_le_bytes());         // status=trading
        write_le(&mut data, 232, &slot.to_le_bytes());         // valid_slot
        write_le(&mut data, 240, &slot.to_le_bytes());         // pub_slot
        write_le(&mut data, 248, &price.to_le_bytes());        // ema_price
        write_le(&mut data, 256, &10000u64.to_le_bytes());     // ema_conf

        msg!("Pyth V2 data written: price={}, expo={}, slot={}", price, expo, slot);
        Ok(())
    }
}

fn pad_label(s: &str) -> [u8; 32] {
    let mut buf = [0u8; 32];
    let bytes = s.as_bytes();
    let len = bytes.len().min(32);
    buf[..len].copy_from_slice(&bytes[..len]);
    buf
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(label: String)]
pub struct CreateFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [b"feed", label.as_bytes()],
        bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority)]
    pub price_feed: Account<'info, PriceFeed>,
}

#[derive(Accounts)]
pub struct WritePythV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Raw account owned by this program. Created via SystemProgram.createAccount.
    #[account(mut, owner = crate::ID)]
    pub raw_feed: AccountInfo<'info>,
}

fn write_le(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub label: [u8; 32],
    pub price: i64,
    pub expo: i32,
    pub last_update_slot: u64,
    pub bump: u8,
}
