import { useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";

import GeoGate from "./components/GeoGate";
import Layout from "./components/Layout";
import KycGate from "./components/KycGate";
import Dashboard from "./pages/Dashboard";
import PositionsPage from "./pages/PositionsPage";
import PreparePage from "./pages/PreparePage";

const RPC = "https://api.devnet.solana.com";

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [tab, setTab] = useState<"dashboard" | "prepare" | "positions">("dashboard");

  return (
    <GeoGate>
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Layout tab={tab} setTab={setTab}>
            <KycGate>
              {tab === "dashboard" && <Dashboard />}
              {tab === "prepare" && <PreparePage />}
              {tab === "positions" && <PositionsPage />}
            </KycGate>
          </Layout>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
