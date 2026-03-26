import { ReactNode, useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

// All known pools — check if wallet is whitelisted in ANY of them
const POOLS = [
  { name: "eUSX", pool: "5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj", dmConfig: "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD" },
  { name: "USX", pool: "DC3Cnrz84qS9p2PtBhAkgbsAnJXG2amgbsaxpAE4NT8u", dmConfig: "GjKooeks153zrhHSyxjnigWukHANbg2ydKZ8qMrY9SAg" },
  { name: "tUSDY", pool: "7LyKDm9fq49ExBVWYEnjpxh13Z7jD8MJZXztY8uCrFY2", dmConfig: "9mFCzbnAUSM5fUgCbkvbSoKiXizpRePhWcCQr7RpyQMo" },
  { name: "Legacy", pool: "5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb", dmConfig: "C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs" },
];

type KycStatus = "loading" | "not_connected" | "checking" | "approved" | "pending" | "rejected";

export default function KycGate({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<KycStatus>("not_connected");
  const [institution, setInstitution] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) {
      setStatus("not_connected");
      return;
    }

    setStatus("checking");

    // Check if wallet is whitelisted in any pool
    async function checkWhitelist() {
      for (const pool of POOLS) {
        const [whitelistEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), new PublicKey(pool.dmConfig).toBuffer(), publicKey!.toBuffer()],
          DELTA_MINT
        );
        const info = await connection.getAccountInfo(whitelistEntry);
        if (info && info.data.length > 0) {
          // Check approved flag (offset: wallet(32) + mint_config(32) + approved(1) = 65)
          const approved = info.data[64] === 1;
          if (approved) {
            setStatus("approved");
            setInstitution(pool.name);
            return;
          }
        }
      }

      // Also check if wallet is an admin
      for (const pool of POOLS) {
        const [adminEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("admin"), new PublicKey(pool.pool).toBuffer(), publicKey!.toBuffer()],
          GOVERNOR
        );
        const info = await connection.getAccountInfo(adminEntry);
        if (info) {
          setStatus("approved");
          setInstitution("Admin");
          return;
        }
      }

      setStatus("pending");
    }

    checkWhitelist().catch(() => setStatus("pending"));
  }, [publicKey, connected, connection]);

  // Not connected
  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8">
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold">Delta Institutional Lending</h1>
          <p className="text-base-content/60 text-lg max-w-md">
            KYC-gated lending protocol for institutional collateral management.
            Deposit yield-bearing assets, borrow stablecoins.
          </p>
        </div>
        <WalletMultiButton />
        <div className="text-xs text-base-content/40 max-w-sm text-center">
          Connect your institutional wallet to access the lending platform.
          Your wallet must be KYC-verified through the institution onboarding process.
        </div>
      </div>
    );
  }

  // Checking KYC
  if (status === "checking" || status === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
        <span className="loading loading-spinner loading-lg text-primary"></span>
        <p className="text-base-content/60">Verifying institutional credentials...</p>
      </div>
    );
  }

  // Not KYC'd — show institutional onboarding
  if (status === "pending" || status === "rejected") {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-8 text-center space-y-6">
            <div className="text-5xl">🏛️</div>
            <h2 className="text-2xl font-bold">Institutional Verification Required</h2>
            <p className="text-base-content/60">
              Access to Delta Institutional Lending requires KYC/KYB verification.
              Your wallet is not yet approved for institutional operations.
            </p>

            <div className="divider">Verification Process</div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
              <div className="bg-base-300 rounded-lg p-4">
                <div className="font-bold text-primary mb-1">1. Identity</div>
                <p className="text-sm text-base-content/60">
                  Microsoft Entra B2C authentication with corporate credentials
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4">
                <div className="font-bold text-primary mb-1">2. KYB Review</div>
                <p className="text-sm text-base-content/60">
                  Corporate entity verification, beneficial ownership, AML screening
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4">
                <div className="font-bold text-primary mb-1">3. Wallet Linking</div>
                <p className="text-sm text-base-content/60">
                  Approved wallets are whitelisted on-chain for permissioned access
                </p>
              </div>
            </div>

            <div className="alert alert-info">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" className="stroke-current shrink-0 w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              <div>
                <div className="font-bold text-sm">Devnet Demo Mode</div>
                <div className="text-xs">
                  Contact the governance admin to whitelist your wallet:
                  <code className="ml-1 bg-base-100 px-1 rounded">{publicKey?.toBase58().slice(0, 16)}...</code>
                </div>
              </div>
            </div>

            <div className="card-actions justify-center">
              <button className="btn btn-primary btn-lg" disabled>
                Begin Verification (Coming Soon)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Approved — show the app
  return (
    <div>
      <div className="alert alert-success mb-6">
        <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <span className="text-sm">
          Institutional access verified — {institution} pool
          <span className="opacity-60 ml-2">({publicKey?.toBase58().slice(0, 8)}...)</span>
        </span>
      </div>
      {children}
    </div>
  );
}
