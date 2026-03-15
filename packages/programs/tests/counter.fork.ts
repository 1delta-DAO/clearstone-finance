import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import type { Counter } from "../target/types/counter";

// Well-known mainnet addresses to clone into the fork.
// Add any accounts your integration tests need from mainnet here.
const ACCOUNTS_TO_CLONE: PublicKey[] = [
  // Example: Token Program
  // new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
];

const PROGRAMS_TO_CLONE: PublicKey[] = [
  // Example: clone a deployed mainnet program to test interactions
  // new PublicKey("SomeProgramAddress..."),
];

describe("counter (mainnet fork)", () => {
  let provider: BankrunProvider;
  let program: Program<Counter>;
  const counterKeypair = Keypair.generate();

  before(async () => {
    // startAnchor boots a lightweight BanksServer with Anchor workspace
    // programs deployed. Accounts and programs listed here are cloned
    // from the RPC endpoint in ANCHOR_PROVIDER_URL (defaults to mainnet).
    const context = await startAnchor(
      "", // project root (uses Anchor.toml to discover programs)
      [], // extra programs to load: [{ name, programId }]
      [
        // Extra accounts to preload into the fork.
        // Each entry: { address, info: { lamports, data, owner, executable } }
        // You can also fetch & snapshot accounts programmatically — see below.
      ]
    );

    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    program = new Program<Counter>(
      anchor.workspace.Counter.idl,
      provider
    );
  });

  it("initializes on a mainnet fork", async () => {
    await program.methods
      .initialize()
      .accounts({
        counter: counterKeypair.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([counterKeypair])
      .rpc();

    const account = await program.account.counter.fetch(
      counterKeypair.publicKey
    );
    expect(account.count.toNumber()).to.equal(0);
  });

  it("increments on a mainnet fork", async () => {
    await program.methods
      .increment()
      .accounts({
        counter: counterKeypair.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.counter.fetch(
      counterKeypair.publicKey
    );
    expect(account.count.toNumber()).to.equal(1);
  });
});

// ─── Utility: snapshot accounts from mainnet for fork tests ────────────────
//
// Use this pattern to clone arbitrary mainnet accounts into your fork:
//
//   import { Connection } from "@solana/web3.js";
//
//   async function snapshotAccount(address: PublicKey) {
//     const conn = new Connection("https://api.mainnet-beta.solana.com");
//     const info = await conn.getAccountInfo(address);
//     if (!info) throw new Error(`Account ${address} not found on mainnet`);
//     return {
//       address,
//       info: {
//         lamports: info.lamports,
//         data: info.data,
//         owner: info.owner,
//         executable: info.executable,
//       },
//     };
//   }
//
// Then pass the result into the third argument of startAnchor().
// This lets you test against real mainnet state (token mints, pools, etc.)
// without needing a running validator.
