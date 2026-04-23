import { useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import { GatewayProvider } from "@civic/solana-gateway-react";
import { PublicKey } from "@solana/web3.js";
import { SavingsApp } from "./pages/SavingsApp";
import { TermDepositsApp } from "./pages/TermDepositsApp";
import GeoGate from "./components/GeoGate";

import "@solana/wallet-adapter-react-ui/styles.css";

const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

// Civic Uniqueness gatekeeper network (liveness check, no PII)
const GATEKEEPER_NETWORK = new PublicKey("ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6");

function CivicWrapper({ children }: { children: React.ReactNode }) {
  return (
    <GatewayProvider
      gatekeeperNetwork={GATEKEEPER_NETWORK}
      cluster="devnet"
      clusterUrl={endpoint}
    >
      {children}
    </GatewayProvider>
  );
}

type Tab = "savings" | "term-deposits";

function AppShell() {
  const [tab, setTab] = useState<Tab>("savings");

  return (
    <>
      <div className="tabs tabs-boxed mx-4 mt-4 w-fit">
        <button
          type="button"
          className={`tab ${tab === "savings" ? "tab-active" : ""}`}
          onClick={() => setTab("savings")}
        >
          Savings
        </button>
        <button
          type="button"
          className={`tab ${tab === "term-deposits" ? "tab-active" : ""}`}
          onClick={() => setTab("term-deposits")}
        >
          Term Deposits
        </button>
      </div>
      {tab === "savings" ? <SavingsApp /> : <TermDepositsApp />}
    </>
  );
}

export default function App() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter({ network })],
    []
  );

  return (
    <GeoGate>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <CivicWrapper>
            <AppShell />
          </CivicWrapper>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
