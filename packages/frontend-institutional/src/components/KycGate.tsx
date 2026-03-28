import { ReactNode, useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

// Root authority that can whitelist
const ROOT_AUTHORITY = "AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX";

// All known pools — check if wallet is whitelisted in ANY
const POOLS = [
  { name: "eUSX (Yield Vault)", pool: "5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj", dmConfig: "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD" },
  { name: "USX (Stablecoin)", pool: "DC3Cnrz84qS9p2PtBhAkgbsAnJXG2amgbsaxpAE4NT8u", dmConfig: "GjKooeks153zrhHSyxjnigWukHANbg2ydKZ8qMrY9SAg" },
  { name: "tUSDY (Test USDY)", pool: "7LyKDm9fq49ExBVWYEnjpxh13Z7jD8MJZXztY8uCrFY2", dmConfig: "9mFCzbnAUSM5fUgCbkvbSoKiXizpRePhWcCQr7RpyQMo" },
  { name: "Legacy Pool", pool: "5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb", dmConfig: "C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs" },
];

type KycStatus = "loading" | "not_connected" | "checking" | "approved" | "pending" | "self_whitelisting" | "error";

// Precomputed Anchor discriminator for global:add_participant
// = sha256("global:add_participant").slice(0, 8)
const ADD_PARTICIPANT_DISC = new Uint8Array([153, 137, 99, 142, 169, 212, 240, 50]);

export default function KycGate({ children }: { children: ReactNode }) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<KycStatus>("not_connected");
  const [institution, setInstitution] = useState<string | null>(null);
  const [approvedPools, setApprovedPools] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkWhitelist = useCallback(async () => {
    if (!publicKey) return;
    setStatus("checking");
    setError(null);

    try {
      const approved: string[] = [];
      let adminFound = false;

      for (const pool of POOLS) {
        // Check whitelist — validate account data length AND approved byte
        const [whitelistEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), new PublicKey(pool.dmConfig).toBuffer(), publicKey.toBuffer()],
          DELTA_MINT
        );
        const info = await connection.getAccountInfo(whitelistEntry);
        if (info && info.data.length >= 65 && info.data[64] === 1) {
          approved.push(pool.name);
        }

        // Check admin
        if (!adminFound) {
          const [adminEntry] = PublicKey.findProgramAddressSync(
            [Buffer.from("admin"), new PublicKey(pool.pool).toBuffer(), publicKey.toBuffer()],
            GOVERNOR
          );
          const adminInfo = await connection.getAccountInfo(adminEntry);
          if (adminInfo) adminFound = true;
        }
      }

      // Also check if this IS the root authority
      if (publicKey.toBase58() === ROOT_AUTHORITY) adminFound = true;

      setApprovedPools(approved);
      setIsAdmin(adminFound);
      setInstitution(approved.length > 0 ? approved[0] : adminFound ? "Admin" : null);
      setStatus(approved.length > 0 || adminFound ? "approved" : "pending");
    } catch (e: any) {
      setError("Failed to verify on-chain credentials. Check your connection and retry.");
      setStatus("error");
    }
  }, [publicKey, connection]);

  useEffect(() => {
    if (!connected || !publicKey) {
      setStatus("not_connected");
      return;
    }
    checkWhitelist();
  }, [publicKey, connected, checkWhitelist]);

  // Self-whitelist (only works if connected wallet IS the root authority)
  const handleSelfWhitelist = useCallback(async () => {
    if (!publicKey) return;
    setStatus("self_whitelisting");
    setError(null);

    try {
      const pool = POOLS[3]; // Legacy pool (authority-owned)
      const disc = Buffer.from(ADD_PARTICIPANT_DISC);
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), new PublicKey(pool.dmConfig).toBuffer(), publicKey.toBuffer()],
        DELTA_MINT
      );
      const roleData = Buffer.from([0]); // Holder

      const tx = new Transaction().add({
        programId: GOVERNOR,
        data: Buffer.concat([disc, roleData]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(pool.pool), isSigner: false, isWritable: false },
          { pubkey: publicKey, isSigner: false, isWritable: false }, // admin_entry = None (use program ID as placeholder)
          { pubkey: new PublicKey(pool.dmConfig), isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: false, isWritable: false },
          { pubkey: whitelistEntry, isSigner: false, isWritable: true },
          { pubkey: DELTA_MINT, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      await checkWhitelist();
    } catch (e: any) {
      setError(e.message?.slice(0, 100) || "Whitelist failed");
      setStatus("pending");
    }
  }, [publicKey, connection, sendTransaction, checkWhitelist]);

  // Not connected — landing page
  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] gap-8">
        <div className="text-center space-y-4 max-w-lg">
          <div className="flex justify-center mb-6">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-primary opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
          </div>
          <h1 className="text-3xl font-bold">Institutional Lending</h1>
          <p className="text-base-content/60 text-lg leading-relaxed">
            KYC-gated lending protocol for institutional collateral management.
            Deposit yield-bearing assets. Borrow stablecoins.
          </p>
        </div>

        <WalletMultiButton />

        <div className="grid grid-cols-3 gap-6 max-w-2xl w-full mt-4">
          <div className="text-center space-y-2">
            <div className="text-2xl font-bold text-primary">~10%</div>
            <div className="text-xs text-base-content/50">Collateral Yield (eUSX)</div>
          </div>
          <div className="text-center space-y-2">
            <div className="text-2xl font-bold text-success">75%</div>
            <div className="text-xs text-base-content/50">Max LTV Ratio</div>
          </div>
          <div className="text-center space-y-2">
            <div className="text-2xl font-bold text-warning">~5%</div>
            <div className="text-xs text-base-content/50">Borrow Rate (USDC)</div>
          </div>
        </div>

        <p className="text-xs text-base-content/30 max-w-sm text-center mt-4">
          Connect your institutional wallet. Access requires KYC/KYB verification
          through the institution onboarding process.
        </p>
      </div>
    );
  }

  // Checking
  if (status === "checking" || status === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="loading loading-spinner loading-lg text-primary"></span>
        <p className="text-base-content/60 text-sm">Verifying institutional credentials...</p>
      </div>
    );
  }

  // RPC / connection error
  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-base-content/60 text-sm text-center max-w-sm">{error}</p>
        <button className="btn btn-primary btn-sm" onClick={checkWhitelist}>Retry Verification</button>
      </div>
    );
  }

  // Self-whitelisting in progress
  if (status === "self_whitelisting") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="loading loading-spinner loading-lg text-primary"></span>
        <p className="text-base-content/60 text-sm">Processing KYC verification...</p>
      </div>
    );
  }

  // Not KYC'd — onboarding screen
  if (status === "pending") {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-8 space-y-6">
            <div className="text-center space-y-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              <h2 className="text-2xl font-bold">Institutional Verification</h2>
              <p className="text-base-content/60 text-sm">
                Your wallet is not yet approved. Complete verification to access the lending platform.
              </p>
            </div>

            <div className="divider text-xs text-base-content/40">VERIFICATION STEPS</div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  <span className="font-semibold text-sm">1. Identity</span>
                </div>
                <p className="text-xs text-base-content/50">
                  Microsoft Entra B2C authentication with corporate credentials (OIDC)
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  <span className="font-semibold text-sm">2. KYB Review</span>
                </div>
                <p className="text-xs text-base-content/50">
                  Entity verification, beneficial ownership, AML/KYT screening
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                  <span className="font-semibold text-sm">3. Wallet Link</span>
                </div>
                <p className="text-xs text-base-content/50">
                  On-chain whitelist entry created for permissioned DeFi access
                </p>
              </div>
            </div>

            {error && (
              <div className="alert alert-error text-sm">
                <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span>{error}</span>
              </div>
            )}

            {/* Devnet mock KYC — only for root authority */}
            {publicKey?.toBase58() === ROOT_AUTHORITY && (
              <div className="alert alert-warning">
                <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                <div>
                  <div className="font-semibold text-sm">Devnet: You are the root authority</div>
                  <div className="text-xs">You can self-whitelist for testing purposes.</div>
                </div>
                <button className="btn btn-sm btn-warning" onClick={handleSelfWhitelist}>
                  Mock KYC Approval
                </button>
              </div>
            )}

            {publicKey?.toBase58() !== ROOT_AUTHORITY && (
              <div className="alert alert-info">
                <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <div>
                  <div className="font-semibold text-sm">Devnet Demo</div>
                  <div className="text-xs">
                    Contact governance admin to whitelist:
                    <code className="ml-1 bg-base-100 px-1.5 py-0.5 rounded text-xs">{publicKey?.toBase58().slice(0, 20)}...</code>
                  </div>
                </div>
              </div>
            )}

            <div className="text-center">
              <button className="btn btn-primary btn-lg gap-2" disabled>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                Begin Verification
              </button>
              <p className="text-xs text-base-content/30 mt-2">
                Production: Microsoft Entra B2C + Chainalysis KYT
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Approved
  return (
    <div>
      <div className="alert alert-success mb-6 flex items-center">
        <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <div className="flex-1">
          <span className="text-sm font-medium">Institutional access verified</span>
          {approvedPools.length > 0 && (
            <span className="text-xs opacity-70 ml-2">
              Pools: {approvedPools.join(", ")}
            </span>
          )}
          {isAdmin && <span className="badge badge-xs badge-primary ml-2">admin</span>}
        </div>
        <span className="text-xs opacity-50 font-mono">{publicKey?.toBase58().slice(0, 12)}...</span>
      </div>
      {children}
    </div>
  );
}
