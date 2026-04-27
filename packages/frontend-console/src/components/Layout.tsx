import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import AdminPanel from "../pages/AdminPanel";
import LendingPanel from "../pages/LendingPanel";
import OraclePanel from "../pages/OraclePanel";
import MintPanel from "../pages/MintPanel";
import MarketPanel from "../pages/MarketPanel";
import WrapPanel from "../pages/WrapPanel";
import RateCurvePanel from "../pages/RateCurvePanel";

type Tab = "admin" | "wrap" | "lending" | "oracles" | "mint" | "market" | "rates";

const tabs: { key: Tab; label: string; desc: string }[] = [
  { key: "admin", label: "Governance", desc: "KYC & Admin" },
  { key: "wrap", label: "Wrap", desc: "KYC Collateral" },
  { key: "mint", label: "Faucet", desc: "Test Tokens" },
  { key: "market", label: "Markets", desc: "Reserves" },
  { key: "rates", label: "Rate Curves", desc: "IRM Config" },
  { key: "lending", label: "Lending", desc: "Borrow / Deposit" },
  { key: "oracles", label: "Oracles", desc: "Price Feeds" },
];

const themes = [
  { id: "business", label: "Business" },
  { id: "dark", label: "Dark" },
  { id: "night", label: "Night" },
  { id: "corporate", label: "Corporate" },
  { id: "luxury", label: "Luxury" },
  { id: "dracula", label: "Dracula" },
  { id: "dim", label: "Dim" },
  { id: "synthwave", label: "Synthwave" },
  { id: "forest", label: "Forest" },
  { id: "black", label: "Black" },
  { id: "light", label: "Light" },
  { id: "nord", label: "Nord" },
];

export default function Layout() {
  const { connected } = useWallet();
  const [tab, setTab] = useState<Tab>("admin");
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("delta-theme") || "business";
    }
    return "business";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("delta-theme", theme);
  }, [theme]);

  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      {/* Navbar */}
      <div className="navbar bg-base-200 border-b border-base-300 px-4 lg:px-8 gap-2">
        <div className="navbar-start">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="Clearstone Fusion" className="w-8 h-8" />
            <div>
              <div className="flex items-baseline gap-1 font-display">
                <span className="brand-wordmark text-base text-primary">clearstone</span>
                <span className="brand-wordmark-thin text-xs text-base-content/50">fusion</span>
              </div>
              <p className="text-[10px] opacity-40 leading-tight">Admin Console</p>
            </div>
          </div>
        </div>
        <div className="navbar-end gap-2">
          {/* Theme switcher */}
          <div className="dropdown dropdown-end">
            <div tabIndex={0} role="button" className="btn btn-ghost btn-sm btn-square">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            </div>
            <ul tabIndex={0} className="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow-2xl border border-base-300 max-h-80 overflow-y-auto">
              <li className="menu-title text-xs opacity-40 px-2 pt-1 pb-2">Theme</li>
              {themes.map((t) => (
                <li key={t.id}>
                  <button
                    className={`${theme === t.id ? "active font-semibold" : ""}`}
                    onClick={() => setTheme(t.id)}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <div className="flex gap-0.5" data-theme={t.id}>
                        <span className="w-2 h-4 rounded-sm bg-primary"></span>
                        <span className="w-2 h-4 rounded-sm bg-secondary"></span>
                        <span className="w-2 h-4 rounded-sm bg-accent"></span>
                        <span className="w-2 h-4 rounded-sm bg-neutral"></span>
                      </div>
                      {t.label}
                      {theme === t.id && <span className="ml-auto opacity-50">&#10003;</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <WalletMultiButton />
        </div>
      </div>

      {/* Tab navigation */}
      <div className="bg-base-200/50 border-b border-base-300">
        <div className="max-w-5xl mx-auto px-4 lg:px-8">
          <div className="flex gap-2 py-3 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`
                  btn gap-2
                  ${tab === t.key
                    ? "btn-primary"
                    : "btn-ghost opacity-50 hover:opacity-100"
                  }
                `}
              >
                <span className="font-semibold">{t.label}</span>
                <span className={`text-xs hidden lg:inline ${tab === t.key ? "opacity-60" : "opacity-30"}`}>
                  {t.desc}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 lg:px-8 py-8">
        {!connected ? (
          <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-warning opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <p className="text-base-content/60 text-sm">Connect an admin wallet to access the console.</p>
            <WalletMultiButton />
          </div>
        ) : (
          <>
            {tab === "admin" && <AdminPanel />}
            {tab === "wrap" && <WrapPanel />}
            {tab === "mint" && <MintPanel />}
            {tab === "market" && <MarketPanel />}
            {tab === "rates" && <RateCurvePanel />}
            {tab === "lending" && <LendingPanel />}
            {tab === "oracles" && <OraclePanel />}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="footer footer-center p-6 text-base-content/20 text-xs border-t border-base-300 mt-8">
        <p>Clearstone Fusion — Solana Devnet</p>
      </footer>
    </div>
  );
}
