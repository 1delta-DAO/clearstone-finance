import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { usePrograms } from "../hooks/usePrograms";
import { useReserveData } from "../hooks/useReserveData";
import { useCTokenBalance } from "../hooks/useCTokenBalance";
import { KycGate } from "../components/KycGate";
import { DepositCard } from "../components/DepositCard";
import { WithdrawCard } from "../components/WithdrawCard";
import { PortfolioCard } from "../components/PortfolioCard";
import { FaucetCard } from "../components/FaucetCard";

export function SavingsApp() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { ready, governor, config } = usePrograms();
  const reserveData = useReserveData();
  const cTokenData = useCTokenBalance(reserveData.exchangeRate);

  const [kycStatus, setKycStatus] = useState<"unknown" | "checking" | "approved" | "not_approved">("unknown");
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!publicKey || !connected) { setKycStatus("unknown"); return; }
    setKycStatus("checking");
    const [whitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.deltaMint
    );
    connection.getAccountInfo(whitelistEntry).then((info) => {
      // Validate data length and approved byte (offset 64) before granting access
      setKycStatus(info && info.data.length >= 65 && info.data[64] === 1 ? "approved" : "not_approved");
    }).catch(() => {
      setKycStatus("unknown");
    });
  }, [publicKey, connected, connection, config]);

  const refreshUsdcBalance = useCallback(() => {
    if (!publicKey || !connected) { setUsdcBalance(null); return; }
    const ata = getAssociatedTokenAddressSync(config.usdc.mint, publicKey, false, TOKEN_PROGRAM_ID);
    connection.getTokenAccountBalance(ata)
      .then((bal) => setUsdcBalance(Number(bal.value.uiAmount)))
      .catch(() => setUsdcBalance(0));
  }, [publicKey, connected, connection, config]);

  useEffect(() => { refreshUsdcBalance(); }, [refreshUsdcBalance]);

  const handleSelfRegister = useCallback(async () => {
    if (!publicKey || !governor) return;
    const [whitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.deltaMint
    );
    const CIVIC_GATEWAY = new PublicKey("Gtwph6B4yrNFi2E7VEVoE3bSEEj1CFBRFBZodvmBp59K");
    const gkNetwork = config.civic.gatekeeperNetwork;
    const [gatewayToken] = PublicKey.findProgramAddressSync(
      [publicKey.toBuffer(), Buffer.from("gateway"), Buffer.alloc(8), gkNetwork.toBuffer()],
      CIVIC_GATEWAY
    );
    const sig = await (governor.methods as any)
      .selfRegister()
      .accounts({
        user: publicKey, poolConfig: config.pool.poolConfig, gatewayToken,
        dmMintConfig: config.pool.dmMintConfig, whitelistEntry,
        deltaMintProgram: config.programs.deltaMint, systemProgram: SystemProgram.programId,
      })
      .rpc();
    setKycStatus("approved");
    return sig;
  }, [publicKey, governor, config]);

  const apyDisplay = reserveData.loading ? "..." : `~${(reserveData.supplyAPY * 100).toFixed(1)}%`;

  return (
    <div data-theme="synthwave" className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Navbar */}
      <div className="navbar bg-base-200/50 backdrop-blur-sm border-b border-primary/20 px-6">
        <div className="navbar-start gap-2">
          <span className="text-2xl">&#9651;</span>
          <span className="font-bold text-lg bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
            Delta Savings
          </span>
        </div>
        <div className="navbar-end">
          <WalletMultiButton />
        </div>
      </div>

      {/* Hero */}
      <section className="text-center py-16 px-8 bg-gradient-to-b from-base-200 to-base-100">
        <h1 className="text-5xl font-extrabold mb-4 bg-gradient-to-r from-primary via-secondary to-accent bg-clip-text text-transparent">
          Earn yield on your USDC
        </h1>
        <p className="text-base-content/60 max-w-lg mx-auto mb-8 text-lg leading-relaxed">
          Deposit USDC into our regulated lending market and earn competitive returns.
          KYC-verified for your protection.
        </p>
        <div className="inline-flex flex-col items-center bg-base-200 border-2 border-primary rounded-2xl px-10 py-4 shadow-lg shadow-primary/20">
          <span className="text-xs uppercase tracking-widest text-base-content/50 mb-1">Current APY</span>
          <span className="text-4xl font-black text-primary">{apyDisplay}</span>
        </div>
      </section>

      {/* Main */}
      <main className="flex-1 px-8 py-8 max-w-4xl mx-auto w-full">
        {!connected ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center text-center">
              <h2 className="card-title text-2xl mb-2">Get Started</h2>
              <p className="text-base-content/60 mb-6">
                Connect your Solana wallet to start earning yield on your USDC deposits.
              </p>
              <WalletMultiButton />
            </div>
          </div>
        ) : kycStatus === "checking" || kycStatus === "unknown" ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center">
              <span className="loading loading-spinner loading-lg text-primary"></span>
              <p className="text-base-content/60 mt-4">Checking verification status...</p>
            </div>
          </div>
        ) : kycStatus === "not_approved" ? (
          <KycGate onRegister={handleSelfRegister} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <PortfolioCard
              usdcBalance={usdcBalance}
              depositedUsdc={cTokenData.usdcValue}
              supplyAPY={reserveData.supplyAPY}
            />
            <div className="flex flex-col gap-6">
              <FaucetCard usdcBalance={usdcBalance} onMinted={refreshUsdcBalance} />
              <DepositCard
                usdcBalance={usdcBalance}
                config={config}
                supplyAPY={reserveData.supplyAPY}
              />
              <WithdrawCard
                depositedUsdc={cTokenData.usdcValue}
                cTokenBalance={cTokenData.cTokens}
                exchangeRate={reserveData.exchangeRate}
                config={config}
              />
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer footer-center p-6 text-base-content/30 text-sm border-t border-base-300">
        <div>
          <p>Delta Protocol — Regulated DeFi Savings</p>
          <p className="text-xs mt-1">Powered by Kamino Finance on Solana Devnet</p>
        </div>
      </footer>
    </div>
  );
}
