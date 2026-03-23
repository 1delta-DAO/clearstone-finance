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

  // Check KYC status
  useEffect(() => {
    if (!publicKey || !connected) { setKycStatus("unknown"); return; }
    setKycStatus("checking");

    const [whitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.deltaMint
    );
    connection.getAccountInfo(whitelistEntry).then((info) => {
      setKycStatus(info ? "approved" : "not_approved");
    });
  }, [publicKey, connected, connection, config]);

  // Fetch USDC balance
  const refreshUsdcBalance = useCallback(() => {
    if (!publicKey || !connected) { setUsdcBalance(null); return; }
    const ata = getAssociatedTokenAddressSync(config.usdc.mint, publicKey, false, TOKEN_PROGRAM_ID);
    connection.getTokenAccountBalance(ata)
      .then((bal) => setUsdcBalance(Number(bal.value.uiAmount)))
      .catch(() => setUsdcBalance(0));
  }, [publicKey, connected, connection, config]);

  useEffect(() => { refreshUsdcBalance(); }, [refreshUsdcBalance]);

  // Self-register via Civic
  const handleSelfRegister = useCallback(async () => {
    if (!publicKey || !governor) return;

    const [whitelistEntry] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.deltaMint
    );
    // Civic Gateway v2 program ID
    const CIVIC_GATEWAY = new PublicKey("Gtwph6B4yrNFi2E7VEVoE3bSEEj1CFBRFBZodvmBp59K");
    const gkNetwork = config.civic.gatekeeperNetwork;
    const [gatewayToken] = PublicKey.findProgramAddressSync(
      [publicKey.toBuffer(), Buffer.from("gateway"), Buffer.alloc(8), gkNetwork.toBuffer()],
      CIVIC_GATEWAY
    );

    const sig = await (governor.methods as any)
      .selfRegister()
      .accounts({
        user: publicKey,
        poolConfig: config.pool.poolConfig,
        gatewayToken,
        dmMintConfig: config.pool.dmMintConfig,
        whitelistEntry,
        deltaMintProgram: config.programs.deltaMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    setKycStatus("approved");
    return sig;
  }, [publicKey, governor, config]);

  const apyDisplay = reserveData.loading ? "—" : `~${(reserveData.supplyAPY * 100).toFixed(1)}%`;

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>&#9651;</span>
          <span style={styles.logoText}>Delta Savings</span>
        </div>
        <WalletMultiButton style={styles.walletBtn} />
      </header>

      <section style={styles.hero}>
        <h1 style={styles.heroTitle}>Earn yield on your USDC</h1>
        <p style={styles.heroSub}>
          Deposit USDC into our regulated lending market and earn competitive
          returns. KYC-verified for your protection.
        </p>
        <div style={styles.apyBadge}>
          <span style={styles.apyLabel}>Current APY</span>
          <span style={styles.apyValue}>{apyDisplay}</span>
        </div>
      </section>

      <main style={styles.main}>
        {!connected ? (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Get Started</h2>
            <p style={styles.cardText}>
              Connect your Solana wallet to start earning yield on your USDC deposits.
            </p>
            <WalletMultiButton style={styles.ctaBtn} />
          </div>
        ) : kycStatus === "checking" || kycStatus === "unknown" ? (
          <div style={styles.card}>
            <p style={styles.cardText}>Checking verification status...</p>
          </div>
        ) : kycStatus === "not_approved" ? (
          <KycGate onRegister={handleSelfRegister} />
        ) : (
          <div style={styles.grid}>
            <PortfolioCard
              usdcBalance={usdcBalance}
              depositedUsdc={cTokenData.usdcValue}
              supplyAPY={reserveData.supplyAPY}
            />
            <div style={styles.actionsCol}>
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

      <footer style={styles.footer}>
        <p>Delta Protocol — Regulated DeFi Savings</p>
        <p style={styles.footerSmall}>Powered by Kamino Finance on Solana Devnet</p>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 32px", borderBottom: "1px solid #1a2035" },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoIcon: { fontSize: 24, color: "#4ecdc4" },
  logoText: { fontSize: 20, fontWeight: 700, color: "#fff" },
  walletBtn: { background: "#1a2035", border: "1px solid #2a3050", borderRadius: 8, fontSize: 13 },
  hero: { textAlign: "center", padding: "60px 32px 40px", background: "linear-gradient(180deg, #0a0e17 0%, #111827 100%)" },
  heroTitle: { fontSize: 42, fontWeight: 800, color: "#fff", marginBottom: 12 },
  heroSub: { fontSize: 16, color: "#9ca3af", maxWidth: 500, margin: "0 auto 24px", lineHeight: 1.5 },
  apyBadge: { display: "inline-flex", flexDirection: "column", background: "#1a2035", border: "1px solid #4ecdc4", borderRadius: 12, padding: "12px 32px" },
  apyLabel: { fontSize: 11, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: 1 },
  apyValue: { fontSize: 28, fontWeight: 800, color: "#4ecdc4" },
  main: { flex: 1, padding: "32px", maxWidth: 900, margin: "0 auto", width: "100%" },
  card: { background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: "32px", textAlign: "center" },
  cardTitle: { fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8 },
  cardText: { fontSize: 14, color: "#9ca3af", marginBottom: 20 },
  ctaBtn: { background: "#4ecdc4", color: "#0a0e17", border: "none", borderRadius: 8, padding: "12px 32px", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 },
  actionsCol: { display: "flex", flexDirection: "column", gap: 20 },
  footer: { textAlign: "center", padding: "24px", borderTop: "1px solid #1a2035", color: "#6b7280", fontSize: 13 },
  footerSmall: { fontSize: 11, marginTop: 4, color: "#4b5563" },
};
