import { useMemo, useState, useEffect } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { DEVNET_CONFIG } from "../config/devnet";

export function usePrograms() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [govIdl, setGovIdl] = useState<any>(null);
  const [dmIdl, setDmIdl] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      fetch("/idl/governor.json").then((r) => r.json()),
      fetch("/idl/delta_mint.json").then((r) => r.json()),
    ]).then(([gov, dm]) => {
      setGovIdl(gov);
      setDmIdl(dm);
    });
  }, []);

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  }, [connection, wallet]);

  const governor = useMemo(() => {
    if (!provider || !govIdl) return null;
    return new Program(govIdl, provider);
  }, [provider, govIdl]);

  const deltaMint = useMemo(() => {
    if (!provider || !dmIdl) return null;
    return new Program(dmIdl, provider);
  }, [provider, dmIdl]);

  return {
    ready: !!governor && !!deltaMint,
    provider,
    governor,
    deltaMint,
    config: DEVNET_CONFIG,
  };
}
