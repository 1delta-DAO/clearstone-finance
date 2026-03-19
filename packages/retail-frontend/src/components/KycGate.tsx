import { useState } from "react";

interface KycGateProps {
  onRegister: () => Promise<string | undefined>;
}

export function KycGate({ onRegister }: KycGateProps) {
  const [status, setStatus] = useState<"idle" | "registering" | "error">("idle");
  const [error, setError] = useState<string>("");

  const handleVerify = async () => {
    setStatus("registering");
    setError("");
    try {
      await onRegister();
    } catch (e: any) {
      setError(e.message?.slice(0, 120) || "Registration failed");
      setStatus("error");
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.icon}>&#128274;</div>
      <h2 style={styles.title}>Identity Verification Required</h2>
      <p style={styles.text}>
        To protect all participants, deposits require a one-time identity
        verification. This takes about 2 minutes and your data is handled by
        Civic, a trusted identity provider.
      </p>

      <div style={styles.steps}>
        <div style={styles.step}>
          <span style={styles.stepNum}>1</span>
          <span>Get a Civic Pass at <a href="https://getpass.civic.com" target="_blank" rel="noreferrer" style={styles.link}>getpass.civic.com</a></span>
        </div>
        <div style={styles.step}>
          <span style={styles.stepNum}>2</span>
          <span>Complete the liveness check</span>
        </div>
        <div style={styles.step}>
          <span style={styles.stepNum}>3</span>
          <span>Return here and click "Register" below</span>
        </div>
      </div>

      <button
        onClick={handleVerify}
        disabled={status === "registering"}
        style={{
          ...styles.btn,
          opacity: status === "registering" ? 0.6 : 1,
        }}
      >
        {status === "registering" ? "Verifying..." : "Register with Civic Pass"}
      </button>

      {error && <p style={styles.error}>{error}</p>}

      <p style={styles.note}>
        Already have a Civic Pass? Click Register to complete on-chain
        verification. No admin approval needed.
      </p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 12,
    padding: "40px 32px",
    textAlign: "center",
  },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8 },
  text: {
    fontSize: 14,
    color: "#9ca3af",
    maxWidth: 440,
    margin: "0 auto 24px",
    lineHeight: 1.6,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxWidth: 380,
    margin: "0 auto 28px",
    textAlign: "left",
  },
  step: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    fontSize: 14,
    color: "#d1d5db",
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    background: "#4ecdc4",
    color: "#0a0e17",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 13,
    flexShrink: 0,
  },
  link: { color: "#4ecdc4", textDecoration: "underline" },
  btn: {
    background: "#4ecdc4",
    color: "#0a0e17",
    border: "none",
    borderRadius: 8,
    padding: "14px 40px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    marginBottom: 16,
  },
  error: {
    color: "#ef4444",
    fontSize: 12,
    marginTop: 8,
    maxWidth: 400,
    margin: "0 auto",
    wordBreak: "break-word",
  },
  note: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 16,
  },
};
