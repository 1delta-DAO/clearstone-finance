import { useEffect } from "react";

// Logo lives in /public — design-system SVGs are not typed for TS imports.
const logo = "/logo.svg";

/* ---- Reveal-on-scroll hook ---------------------------------- */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal, .reveal-stagger");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ---- Section ------------------------------------------------- */
function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`relative w-full px-6 md:px-10 py-24 md:py-32 ${className}`}
    >
      <div className="max-w-6xl mx-auto">{children}</div>
    </section>
  );
}

/* ---- Eyebrow ------------------------------------------------- */
function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <span
      className={`inline-block uppercase text-[11px] tracking-[0.28em] mb-5 ${
        dark ? "text-stone-3" : "text-[#6B7E9A]"
      }`}
    >
      {children}
    </span>
  );
}

/* ---- Top Nav ------------------------------------------------- */
function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-30 backdrop-blur-md bg-[#070D1F]/65 border-b border-white/5">
      <div className="max-w-6xl mx-auto px-6 md:px-10 h-16 flex items-center justify-between">
        <a href="#top" className="flex items-center gap-3">
          <img src={logo} alt="Clearstone Fusion" className="h-7 w-auto" />
          <div className="flex items-baseline gap-1.5 font-display">
            <span className="brand-wordmark text-base text-stone-0">clearstone</span>
            <span className="brand-wordmark-thin text-xs text-stone-3">fusion</span>
          </div>
        </a>
        <div className="hidden md:flex items-center gap-7 text-sm text-stone-2">
          <a href="#solution" className="hover:text-stone-0 transition-colors">Solution</a>
          <a href="#surfaces" className="hover:text-stone-0 transition-colors">Products</a>
          <a href="#stack" className="hover:text-stone-0 transition-colors">Stack</a>
          <a href="#numbers" className="hover:text-stone-0 transition-colors">Numbers</a>
        </div>
        <a href="#cta" className="btn-primary-cs text-sm">Launch app</a>
      </div>
    </nav>
  );
}

/* ---- Hero ---------------------------------------------------- */
function Hero() {
  return (
    <section
      id="top"
      className="relative min-h-[100svh] flex items-center justify-center overflow-hidden"
    >
      <div className="absolute inset-0 hero-aura pointer-events-none" />
      {/* faint grid */}
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.05] pointer-events-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#A6B3C5" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)" />
      </svg>

      <div className="relative max-w-4xl mx-auto px-6 text-center reveal">
        <div className="hero-float inline-block mb-10">
          <img src={logo} alt="" className="h-40 md:h-52 w-auto drop-shadow-[0_30px_60px_rgba(7,13,31,0.7)]" />
        </div>

        <div className="font-display flex items-baseline justify-center gap-3 md:gap-4 mb-7">
          <span className="brand-wordmark text-5xl md:text-7xl text-stone-0">clearstone</span>
          <span className="brand-wordmark-thin text-2xl md:text-3xl text-stone-2">fusion</span>
        </div>

        <p className="text-lg md:text-xl text-stone-2 max-w-2xl mx-auto leading-relaxed">
          The end-to-end on-chain savings stack. Institutional custody, retail simplicity,
          and a unified operator console — fused on Solana.
        </p>

        <div className="flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-10">
          <a href="#cta" className="btn-primary-cs">Get started</a>
          <a href="#solution" className="btn-ghost-cs">See the solution ↓</a>
        </div>
      </div>

      <div className="absolute bottom-8 left-0 right-0 flex justify-center">
        <div className="text-stone-3 text-xs tracking-[0.3em] uppercase animate-pulse">scroll</div>
      </div>
    </section>
  );
}

/* ---- Solution overview --------------------------------------- */
function Solution() {
  return (
    <Section id="solution" className="bg-stone-rise">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>The fusion</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          One stack. Three doors. Every step on-chain.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          Clearstone Fusion is a single, audited DeFi backbone with three purpose-built surfaces.
          Treasuries get institutional rails. Savers get a clean yield experience. Operators get a
          single console for every position, every reserve, every reconciliation.
        </p>
      </div>

      <div className="divider-hair my-16" />

      <div className="grid md:grid-cols-3 gap-6 reveal-stagger">
        {[
          {
            title: "Same protocol",
            body: "All three surfaces speak to the same Kamino-powered klend reserves. No mirror books, no shadow ledgers.",
          },
          {
            title: "Same custody",
            body: "Wallet-native end-to-end. Funds stay on-chain in audited PDAs — never in operator-controlled accounts.",
          },
          {
            title: "Same numbers",
            body: "TVL, supply APY, borrow APY, utilization — pulled from chain in real time. What you see is the source of truth.",
          },
        ].map((c) => (
          <div key={c.title} className="card-stone p-7">
            <div className="text-stone-0 font-display font-semibold text-lg mb-2">{c.title}</div>
            <p className="text-stone-2 text-sm leading-relaxed">{c.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Three surfaces ------------------------------------------ */
function Surfaces() {
  const items = [
    {
      tag: "Institutional",
      title: "Treasury-grade lending",
      body: "Deposit, borrow, and rebalance against curated reserves with full position transparency, audit exports, and policy-bounded keepers.",
      points: ["Curated risk reserves", "On-chain audit trail", "Policy-bounded automation"],
      cta: "Explore institutional →",
    },
    {
      tag: "Retail",
      title: "Yield, without the noise",
      body: "A clean savings experience for non-technical users — connect a wallet, deposit USDC, watch yield compound. No charts to read.",
      points: ["One-click deposits", "Simple withdraws", "Real-time APY display"],
      cta: "Open the savings app →",
    },
    {
      tag: "Console",
      title: "The operator's cockpit",
      body: "A single admin surface for governors and curators: reserve config, oracle status, elevation groups, vault deployments, keeper health.",
      points: ["Reserve & oracle ops", "Vault management", "Keeper telemetry"],
      cta: "Tour the console →",
    },
  ];
  return (
    <Section id="surfaces" className="bg-stone-light">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>Products</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold leading-tight tracking-tight">
          Three surfaces. One Clearstone.
        </h2>
        <p className="text-[#4F607C] text-lg mt-6 leading-relaxed">
          Built for the people who manage capital, the people who save it,
          and the people who run the rails underneath.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mt-16 reveal-stagger">
        {items.map((it) => (
          <div key={it.tag} className="card-stone-light p-8 flex flex-col">
            <span className="uppercase tracking-[0.22em] text-[10px] text-[#7C8BA3] font-semibold mb-4">
              {it.tag}
            </span>
            <h3 className="font-display text-2xl font-semibold leading-tight mb-3 text-[#1F2D48]">
              {it.title}
            </h3>
            <p className="text-[#4F607C] text-sm leading-relaxed mb-6">{it.body}</p>
            <ul className="space-y-2 mb-8 text-sm text-[#1F2D48]">
              {it.points.map((p) => (
                <li key={p} className="flex items-start gap-2">
                  <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#4F607C] flex-shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
            <span className="mt-auto text-sm font-medium text-[#1F2D48] hover:text-[#4F607C] cursor-pointer transition-colors">
              {it.cta}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Architecture diagram ------------------------------------ */
function Stack() {
  return (
    <Section id="stack" className="bg-stone-deep">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>The stack</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          On-chain end to end.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          Solana settlement. Kamino-powered lending markets. Audited governor and vault programs.
          Three frontends — one ledger of truth.
        </p>
      </div>

      <div className="reveal mt-16 max-w-5xl mx-auto">
        <svg viewBox="0 0 900 360" className="w-full h-auto">
          <defs>
            <linearGradient id="diag-stone" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#4F607C" />
              <stop offset="100%" stopColor="#1F2D48" />
            </linearGradient>
            <linearGradient id="diag-glow" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="#A6B3C5" stopOpacity="0.6"/>
              <stop offset="100%" stopColor="#A6B3C5" stopOpacity="0"/>
            </linearGradient>
          </defs>

          {/* 3 surfaces (top row) */}
          {[
            { x: 80,  label: "Institutional" },
            { x: 380, label: "Retail" },
            { x: 680, label: "Console" },
          ].map((s) => (
            <g key={s.label}>
              <rect x={s.x} y={20} width={140} height={60} rx={12}
                    fill="url(#diag-stone)" stroke="rgba(166,179,197,0.32)" />
              <text x={s.x + 70} y={56} textAnchor="middle"
                    fill="#E2E7EF" fontFamily="Quicksand, sans-serif" fontWeight={600} fontSize={15}>
                {s.label}
              </text>
            </g>
          ))}

          {/* connector lines */}
          {[150, 450, 750].map((x) => (
            <line key={x} x1={x} y1={80} x2={x} y2={150}
                  stroke="#A6B3C5" strokeWidth={1.2} className="flow-line" />
          ))}

          {/* SDK / Programs row */}
          <rect x={80} y={150} width={740} height={60} rx={12}
                fill="url(#diag-stone)" stroke="rgba(166,179,197,0.32)" />
          <text x={450} y={186} textAnchor="middle"
                fill="#E2E7EF" fontFamily="Quicksand, sans-serif" fontWeight={600} fontSize={15}>
            Calldata SDK · Governor Program · Vault Programs · Keeper
          </text>

          {/* connector to chain */}
          <line x1={450} y1={210} x2={450} y2={280}
                stroke="#A6B3C5" strokeWidth={1.2} className="flow-line" />

          {/* Solana row */}
          <rect x={250} y={280} width={400} height={60} rx={12}
                fill="url(#diag-stone)" stroke="rgba(166,179,197,0.32)" />
          <text x={450} y={316} textAnchor="middle"
                fill="#E2E7EF" fontFamily="Quicksand, sans-serif" fontWeight={600} fontSize={15}>
            Solana · Kamino (klend)
          </text>
        </svg>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mt-14 reveal-stagger">
        {[
          { k: "Settlement", v: "Solana mainnet" },
          { k: "Lending", v: "Kamino · klend" },
          { k: "Custody", v: "On-chain PDAs" },
          { k: "Programs", v: "Governor + Vault" },
        ].map((x) => (
          <div key={x.k} className="card-stone p-5">
            <div className="text-stone-3 text-[11px] uppercase tracking-[0.22em] mb-1">{x.k}</div>
            <div className="text-stone-0 font-display font-semibold">{x.v}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Why both sides ------------------------------------------ */
function BothSides() {
  return (
    <Section className="bg-stone-light">
      <div className="grid md:grid-cols-2 gap-12 items-start">
        <div className="reveal">
          <Eyebrow>For institutions</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            Treasury rails, on-chain transparency.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            Curators define elevation groups, oracle policies, and reserve risk parameters in code.
            Allocators move capital with full audit trail and bounded automation. Every state
            transition lives on-chain, with calldata that any counterparty can re-verify.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "Curated reserves with explicit elevation groups",
              "Audited governor program with timelocked changes",
              "Operator-bounded automation via the keeper",
              "Composable with the broader Solana institutional stack",
            ].map((s) => (
              <li key={s} className="flex gap-3">
                <span className="text-[#4F607C] font-bold">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal">
          <Eyebrow>For everyone else</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            Yield, without the cognitive load.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            Connect a wallet. Deposit USDC. That's the entire flow. Yield accrues
            transparently from the same reserves powering institutional positions —
            no segregated retail "lite" version, no different rate.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "One-click deposit + withdraw",
              "Real-time APY pulled from chain",
              "No tokens to learn, no positions to manage",
              "Same reserves, same rates as institutional",
            ].map((s) => (
              <li key={s} className="flex gap-3">
                <span className="text-[#4F607C] font-bold">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ---- Numbers / KPIs ------------------------------------------ */
function Numbers() {
  const kpis = [
    { v: "100%",    k: "On-chain settlement" },
    { v: "3",       k: "Purpose-built surfaces" },
    { v: "0",       k: "Off-chain custody points" },
    { v: "Solana",  k: "Network of choice" },
  ];
  return (
    <Section id="numbers" className="bg-stone-fade">
      <div className="reveal text-center max-w-3xl mx-auto mb-16">
        <Eyebrow>By the numbers</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          Boring is a feature.
        </h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 reveal-stagger">
        {kpis.map((x) => (
          <div key={x.k} className="card-stone p-7 text-center">
            <div className="kpi-num text-stone-0 font-display text-4xl md:text-5xl font-semibold">{x.v}</div>
            <div className="text-stone-3 text-xs uppercase tracking-[0.22em] mt-3">{x.k}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---- Final CTA ----------------------------------------------- */
function CTA() {
  return (
    <Section id="cta" className="bg-stone-deep">
      <div className="reveal max-w-3xl mx-auto text-center">
        <img src={logo} alt="" className="h-24 mx-auto mb-8 opacity-90" />
        <h2 className="font-display text-4xl md:text-6xl font-semibold text-stone-0 leading-[1.05] tracking-tight">
          Bring your treasury on-chain.
          <span className="block text-stone-3 font-light">Or just earn yield. Either works.</span>
        </h2>
        <div className="flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-12">
          <a href="http://localhost:3002" className="btn-primary-cs">Institutional →</a>
          <a href="http://localhost:3001" className="btn-ghost-cs">Retail savings →</a>
          <a href="http://localhost:5173" className="btn-ghost-cs">Console →</a>
        </div>
      </div>
    </Section>
  );
}

/* ---- Footer -------------------------------------------------- */
function Footer() {
  return (
    <footer className="border-t border-white/5 bg-[#040814] py-10 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 md:items-center md:justify-between text-stone-3 text-sm">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="h-6" />
          <div className="font-display flex items-baseline gap-1.5">
            <span className="brand-wordmark text-sm text-stone-2">clearstone</span>
            <span className="brand-wordmark-thin text-[11px]">fusion</span>
          </div>
        </div>
        <div className="flex gap-6">
          <a href="#solution" className="hover:text-stone-0 transition-colors">Solution</a>
          <a href="#surfaces" className="hover:text-stone-0 transition-colors">Products</a>
          <a href="#stack" className="hover:text-stone-0 transition-colors">Stack</a>
        </div>
        <div className="text-xs">© {new Date().getFullYear()} Clearstone Fusion · Built on Solana · Powered by Kamino</div>
      </div>
    </footer>
  );
}

/* ---- Composition -------------------------------------------- */
export default function App() {
  useReveal();
  return (
    <div className="text-stone-0">
      <Nav />
      <Hero />
      <Solution />
      <Surfaces />
      <Stack />
      <BothSides />
      <Numbers />
      <CTA />
      <Footer />
    </div>
  );
}
