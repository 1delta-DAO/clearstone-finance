import { ReactNode } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";

type Tab = "dashboard" | "collateral" | "borrow" | "positions";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "collateral", label: "Supply Collateral", icon: "🏦" },
  { id: "borrow", label: "Borrow", icon: "💰" },
  { id: "positions", label: "Positions", icon: "📋" },
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
    <div className="min-h-screen bg-base-100 text-base-content">
      {/* Header */}
      <header className="navbar bg-base-200 border-b border-base-300 px-6">
        <div className="flex-1 gap-3">
          <span className="text-xl font-bold tracking-tight">Delta</span>
          <span className="badge badge-outline badge-sm font-mono">Institutional</span>
          <span className="badge badge-ghost badge-sm">devnet</span>
        </div>
        <div className="flex-none">
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
                  className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                    tab === t.id
                      ? "border-primary text-primary"
                      : "border-transparent text-base-content/60 hover:text-base-content hover:border-base-300"
                  }`}
                >
                  <span className="mr-2">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </nav>
      )}

      {/* Main */}
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>

      {/* Footer */}
      <footer className="border-t border-base-300 bg-base-200 py-4 px-6 text-center text-xs text-base-content/50">
        Delta Institutional Lending — Powered by Kamino (klend) on Solana Devnet
      </footer>
    </div>
  );
}
