import { ReactNode } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";

type Tab = "dashboard" | "prepare" | "positions";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  {
    id: "dashboard", label: "Dashboard",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>,
  },
  {
    id: "prepare", label: "Prepare Collateral",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
  },
  {
    id: "positions", label: "Manage Positions",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  },
];

export default function Layout({
  children,
  tab,
  setTab,
}: {
  children: ReactNode;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const { connected } = useWallet();

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Header */}
      <header className="navbar bg-base-200 border-b border-base-300 px-6 min-h-16">
        <div className="flex-1 gap-3 items-center">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="Clearstone Fusion" className="h-7 w-7" />
            <div className="flex items-baseline gap-1 font-display">
              <span className="brand-wordmark text-lg text-primary">clearstone</span>
              <span className="brand-wordmark-thin text-sm text-base-content/50">fusion</span>
            </div>
          </div>
          <span className="text-xs font-semibold text-primary/70">Institutional</span>
          <span className="text-xs font-mono text-base-content/30 ml-2">devnet</span>
        </div>
        <div className="flex-none flex items-center gap-3">
          <div className="hidden md:flex items-center gap-3 text-xs">
            <a href="https://clearstone.ai" target="_blank" rel="noreferrer"
              className="link link-hover text-base-content/50 hover:text-primary">Home</a>
            <span className="text-base-content/20">·</span>
            <a href="https://clearstone-fusion-console.pages.dev" target="_blank" rel="noreferrer"
              className="link link-hover text-base-content/50 hover:text-primary">Console</a>
          </div>
          <WalletMultiButton />
        </div>
      </header>

      {/* Navigation */}
      {connected && (
        <nav className="bg-base-200 border-b border-base-300">
          <div className="max-w-7xl mx-auto px-6">
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium border-b-2 transition-all ${
                    tab === t.id
                      ? "border-primary text-primary"
                      : "border-transparent text-base-content/50 hover:text-base-content hover:border-base-300"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </nav>
      )}

      {/* Main */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">{children}</main>

      {/* Footer */}
      <footer className="border-t border-base-300 bg-base-200 py-4 px-6 text-center text-xs text-base-content/40">
        Clearstone Fusion &middot; Institutional Lending &middot; Powered by Kamino (klend) on Solana &middot; Devnet
      </footer>
    </div>
  );
}
