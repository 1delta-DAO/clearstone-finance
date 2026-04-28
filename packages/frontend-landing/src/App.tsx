import { useEffect, useRef, useState } from "react";

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
          <a href="#solution" className="hover:text-stone-0 transition-colors">Platform</a>
          <a href="#surfaces" className="hover:text-stone-0 transition-colors">Products</a>
          <a href="#stack" className="hover:text-stone-0 transition-colors">Architecture</a>
          <a href="#compliance" className="hover:text-stone-0 transition-colors">Compliance</a>
        </div>
        <a href="#cta" className="btn-primary-cs text-sm">Book a demo</a>
      </div>
    </nav>
  );
}

/* ---- Hero ---------------------------------------------------- */
function Hero() {
  const heroRef = useRef<HTMLElement>(null);
  const [px, setPx] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      const y = ((e.clientY - r.top) / r.height - 0.5) * 2;
      setPx({ x, y });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  const wordmark = "clearstone".split("");

  return (
    <section
      ref={heroRef}
      id="top"
      className="relative min-h-[100svh] flex items-center justify-center overflow-hidden"
    >
      {/* Mesh gradient — 3 drifting radial blobs */}
      <div className="absolute inset-0 hero-mesh pointer-events-none" />

      {/* Slow orbital conic sweep behind the logo */}
      <div
        className="absolute hero-conic pointer-events-none"
        style={{ transform: `translate3d(${px.x * -10}px, ${px.y * -10}px, 0)` }}
      />

      {/* Faint vector grid */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.04] pointer-events-none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="g" width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M 56 0 L 0 0 0 56" fill="none" stroke="#A6B3C5" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)" />
      </svg>

      {/* SVG noise grain — premium texture */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.05] pointer-events-none mix-blend-overlay">
        <filter id="hero-noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#hero-noise)" />
      </svg>

      {/* Hero content with subtle parallax */}
      <div
        className="relative max-w-4xl mx-auto px-6 text-center"
        style={{
          transform: `translate3d(${px.x * 6}px, ${px.y * 6}px, 0)`,
          transition: "transform 0.5s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        {/* Logo with 3D tilt + glow pulse */}
        <div
          className="hero-logo-wrap relative inline-block mb-10"
          style={{
            transform: `perspective(1200px) rotateY(${px.x * 7}deg) rotateX(${-px.y * 5}deg)`,
            transition: "transform 0.4s cubic-bezier(.2,.7,.2,1)",
          }}
        >
          <div className="hero-glow" aria-hidden />
          <img
            src={logo}
            alt=""
            className="relative h-44 md:h-56 w-auto drop-shadow-[0_30px_60px_rgba(7,13,31,0.85)] hero-float"
          />
        </div>

        {/* Wordmark — letter-by-letter mount-in */}
        <div className="font-display flex items-baseline justify-center gap-3 md:gap-4 mb-7">
          <span className="brand-wordmark text-5xl md:text-7xl text-stone-0">
            {wordmark.map((c, i) => (
              <span
                key={i}
                className="hero-letter inline-block"
                style={{ animationDelay: `${i * 55}ms` }}
              >
                {c}
              </span>
            ))}
          </span>
          <span className="brand-wordmark-thin text-2xl md:text-3xl text-stone-2 hero-fusion">
            fusion
          </span>
        </div>

        <p className="hero-tag text-lg md:text-xl text-stone-2 max-w-2xl mx-auto leading-relaxed">
          Institutional DeFi infrastructure. Software, programs, and rails that let banks,
          fintechs, and asset managers stand up KYC-gated savings apps and trading desks —
          running on permissionless liquidity underneath.
        </p>

        <div className="hero-cta flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-10">
          <a href="#cta" className="btn-primary-cs btn-shimmer">Book a demo</a>
          <a href="#solution" className="btn-ghost-cs">See the architecture ↓</a>
        </div>
      </div>

      {/* Scroll cue */}
      <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none">
        <div className="flex flex-col items-center gap-2 text-stone-3">
          <span className="text-[10px] tracking-[0.32em] uppercase">scroll</span>
          <span className="hero-scroll-dot block h-7 w-px bg-gradient-to-b from-stone-3/80 to-transparent" />
        </div>
      </div>
    </section>
  );
}

/* ---- Solution overview --------------------------------------- */
function Solution() {
  return (
    <Section id="solution" className="bg-stone-rise">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>What we provide</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          Infrastructure, not an app.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          Clearstone Fusion is the institutional layer between regulated counterparties and DeFi.
          We ship the SDK, the on-chain programs, the custody patterns, and the operator console.
          You ship a compliant product to your customers — under your brand.
        </p>
      </div>

      <div className="divider-hair my-16" />

      <div className="grid md:grid-cols-3 gap-6 reveal-stagger">
        {[
          {
            title: "Audited programs",
            body: "Open-source governor and vault contracts your compliance team can read. Timelocked changes, parameter-bounded, no privileged backdoors.",
          },
          {
            title: "Permissioned-on-permissionless",
            body: "KYC/KYB gates wrap permissionless DeFi liquidity. Your users never leave your perimeter. Capital never leaves chain.",
          },
          {
            title: "One ledger of truth",
            body: "TVL, APY, utilization, reserves — read directly from Solana. Audit and reporting work without reconciliation across systems.",
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
      tag: "White-label · savings",
      title: "Retail savings, your brand",
      body: "Spin up a regulated USDC savings product for your customers in days. KYC-gated wallet flow, branded UI, audit-ready operations — from a single SDK.",
      points: ["KYC-gated deposit & withdraw", "Brandable UI components", "Real-time APY from chain"],
      cta: "Tour the savings demo →",
    },
    {
      tag: "B2B · trading",
      title: "Trading desks, white-labeled",
      body: "A permissioned trading and lending surface for treasury teams, family offices, and corporate clients. Curated markets, policy-bounded execution, full audit trail.",
      points: ["KYB gates per counterparty", "Policy-bounded automation", "Position & exposure exports"],
      cta: "Tour the desk demo →",
    },
    {
      tag: "Internal · ops",
      title: "Operator console",
      body: "The cockpit your ops team runs everything from: reserve config, oracle status, elevation groups, vault deployments, keeper telemetry, audit exports.",
      points: ["Reserve & oracle ops", "Vault management", "Keeper telemetry & alerts"],
      cta: "Tour the console →",
    },
  ];
  return (
    <Section id="surfaces" className="bg-stone-light">
      <div className="reveal text-center max-w-3xl mx-auto">
        <Eyebrow>What you ship</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold leading-tight tracking-tight">
          Three deliverables. Your brand.
        </h2>
        <p className="text-[#4F607C] text-lg mt-6 leading-relaxed">
          Pick a surface — or all three. Your engineers integrate the SDK; your customers see your UI.
          We provide the rails, the audits, and the on-chain plumbing.
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
        <Eyebrow>Architecture</Eyebrow>
        <h2 className="font-display text-4xl md:text-5xl font-semibold text-stone-0 leading-tight tracking-tight">
          What you ship vs. what we ship.
        </h2>
        <p className="text-stone-2 text-lg mt-6 leading-relaxed">
          You ship the brand and the customer relationship. We ship the SDK, the on-chain programs,
          the keeper, and the operator console — running on audited Solana liquidity.
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

          {/* row labels */}
          <text x={20} y={56} fill="#7C8BA3" fontFamily="Geist, sans-serif" fontSize={10} letterSpacing={2}>YOU SHIP</text>
          <text x={20} y={186} fill="#7C8BA3" fontFamily="Geist, sans-serif" fontSize={10} letterSpacing={2}>WE SHIP</text>
          <text x={20} y={316} fill="#7C8BA3" fontFamily="Geist, sans-serif" fontSize={10} letterSpacing={2}>UNDERLYING</text>

          {/* 3 surfaces (top row) — your white-label products */}
          {[
            { x: 80,  label: "Your savings app" },
            { x: 380, label: "Your trading desk" },
            { x: 680, label: "Your ops console" },
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
                fill="#E2E7EF" fontFamily="Geist, sans-serif" fontWeight={500} fontSize={15}>
            Clearstone Fusion · SDK · Programs · Keeper · Console
          </text>

          {/* connector to chain */}
          <line x1={450} y1={210} x2={450} y2={280}
                stroke="#A6B3C5" strokeWidth={1.2} className="flow-line" />

          {/* Solana row */}
          <rect x={250} y={280} width={400} height={60} rx={12}
                fill="url(#diag-stone)" stroke="rgba(166,179,197,0.32)" />
          <text x={450} y={316} textAnchor="middle"
                fill="#E2E7EF" fontFamily="Geist, sans-serif" fontWeight={500} fontSize={15}>
            Solana · Kamino (klend) · Permissionless DeFi liquidity
          </text>
        </svg>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mt-14 reveal-stagger">
        {[
          { k: "Settlement",    v: "Solana mainnet" },
          { k: "Liquidity",     v: "Kamino · klend" },
          { k: "Access control",v: "KYC / KYB gated" },
          { k: "Programs",      v: "Governor + Vault" },
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

/* ---- Compliance & Ops ---------------------------------------- */
function Compliance() {
  return (
    <Section id="compliance" className="bg-stone-light">
      <div className="grid md:grid-cols-2 gap-12 items-start">
        <div className="reveal">
          <Eyebrow>Compliance, baked in</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            Permissioned access. Permissionless rails.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            The on-chain programs gate every interaction by KYC or KYB attestation. Your compliance
            team defines who clears the gate. We don't replace your KYC vendor — we plug into it.
            Underneath, capital lives in audited DeFi reserves you can verify on-chain.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "KYC / KYB gating enforced at the program level",
              "Per-jurisdiction policy controls",
              "Timelocked governance, parameter-bounded automation",
              "Audit-ready exports — no off-chain reconciliation",
            ].map((s) => (
              <li key={s} className="flex gap-3">
                <span className="text-[#4F607C] font-bold">›</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal">
          <Eyebrow>Operations, simplified</Eyebrow>
          <h3 className="font-display text-3xl md:text-4xl font-semibold leading-tight mb-5">
            One console for every reserve, oracle, and vault.
          </h3>
          <p className="text-[#4F607C] text-base leading-relaxed mb-6">
            Real-time reserve health, oracle status, keeper telemetry, and per-policy alerts.
            Your ops team gets out of spreadsheets and into a cockpit built specifically for
            running an institutional DeFi product.
          </p>
          <ul className="space-y-3 text-sm text-[#1F2D48]">
            {[
              "Reserve, oracle, and elevation-group operations",
              "Vault deployment and configuration",
              "Keeper health and alert routing",
              "On-chain audit trail surfaced inline",
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
    { v: "0",       k: "Off-chain custody points" },
    { v: "Audited", k: "Governor & vault programs" },
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
          Ship your institutional DeFi product.
          <span className="block text-stone-3 font-light">We do the rails.</span>
        </h2>
        <p className="text-stone-2 text-base md:text-lg max-w-xl mx-auto mt-7 leading-relaxed">
          Talk to us. We'll walk through the SDK, the on-chain programs, the compliance flow,
          and the operator console — and show you how partners are deploying.
        </p>
        <div className="flex flex-col md:flex-row gap-3 md:gap-4 justify-center mt-10">
          <a href="mailto:hello@clearstone.fi" className="btn-primary-cs">Book a demo</a>
          <a href="#surfaces" className="btn-ghost-cs">Tour the demos</a>
          <a href="https://github.com" className="btn-ghost-cs">View on GitHub</a>
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
          <a href="#solution" className="hover:text-stone-0 transition-colors">Platform</a>
          <a href="#surfaces" className="hover:text-stone-0 transition-colors">Products</a>
          <a href="#stack" className="hover:text-stone-0 transition-colors">Architecture</a>
          <a href="#compliance" className="hover:text-stone-0 transition-colors">Compliance</a>
        </div>
        <div className="text-xs">© {new Date().getFullYear()} Clearstone Fusion · Institutional DeFi infrastructure · Solana</div>
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
      <Compliance />
      <Numbers />
      <CTA />
      <Footer />
    </div>
  );
}
