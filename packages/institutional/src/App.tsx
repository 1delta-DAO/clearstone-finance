import { useMemo, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";

import Layout from "./components/Layout";
import KycGate from "./components/KycGate";
import Dashboard from "./pages/Dashboard";
import CollateralPage from "./pages/CollateralPage";
import BorrowPage from "./pages/BorrowPage";
import PositionsPage from "./pages/PositionsPage";

const RPC = "https://api.devnet.solana.com";

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [tab, setTab] = useState<"dashboard" | "collateral" | "borrow" | "positions">("dashboard");

  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Layout tab={tab} setTab={setTab}>
            <KycGate>
              {tab === "dashboard" && <Dashboard />}
              {tab === "collateral" && <CollateralPage />}
              {tab === "borrow" && <BorrowPage />}
              {tab === "positions" && <PositionsPage />}
            </KycGate>
          </Layout>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
