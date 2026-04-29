import { useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import { RPC_URL } from "./lib/addresses";
import JitoRestakingTab from "./tabs/JitoRestakingTab";
import OneStepDepositTab from "./tabs/OneStepDepositTab";
import OneStepUnwindTab from "./tabs/OneStepUnwindTab";

type Tab = { id: string; label: string; render: () => JSX.Element };

const TABS: Tab[] = [
  { id: "jito-restaking", label: "Jito Restaking", render: () => <JitoRestakingTab /> },
  { id: "one-step-deposit", label: "1-tx SOL → klend collateral", render: () => <OneStepDepositTab /> },
  { id: "unwind", label: "Unwind (csSOL → wSOL)", render: () => <OneStepUnwindTab /> },
  // Add more tabs here as flows land:
  //   { id: "bundles", label: "Jito Bundles" }
  //   { id: "shredstream", label: "ShredStream Monitor" }
];

function Shell({ children, tab, setTab }: { children: React.ReactNode; tab: string; setTab: (t: string) => void }) {
  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      <header className="border-b border-base-300 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="badge badge-warning badge-sm">DEV PLAYGROUND</span>
          <span className="font-bold">Clearstone Playground</span>
          <span className="text-xs opacity-60">— not for institutions or retail; this is a developer testing tool.</span>
        </div>
        <WalletMultiButton style={{ height: 36, fontSize: 13 }} />
      </header>

      <nav role="tablist" className="tabs tabs-lift px-6 pt-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="px-6 py-6">{children}</main>

      <footer className="px-6 py-4 text-xs opacity-60 border-t border-base-300 mt-12">
        RPC: {RPC_URL}
      </footer>
    </div>
  );
}

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [tab, setTab] = useState<string>(TABS[0].id);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Shell tab={tab} setTab={setTab}>{active.render()}</Shell>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
