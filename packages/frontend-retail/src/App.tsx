import { useMemo } from "react";
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
            <SavingsApp />
          </CivicWrapper>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
