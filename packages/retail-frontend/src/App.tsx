import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletAdapterNetwork, } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import { SavingsApp } from "./pages/SavingsApp";

import "@solana/wallet-adapter-react-ui/styles.css";

const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

export default function App() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter({ network })],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SavingsApp />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
