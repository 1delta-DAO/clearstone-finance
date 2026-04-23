/**
 * Backend-edge HTTP client. Minimal — just the endpoints the keeper
 * needs, typed narrowly.
 */

export interface CuratorVaultSnapshot {
  id: string;
  label: string;
  baseSymbol: string;
  baseMint: string;
  baseDecimals: number;
  kycGated: boolean;
  vault: string;
  curator: string;
  baseEscrow: string;
  totalAssets: string;
  totalShares: string;
  feeBps: number;
  nextAutoRollTs: number | null;
  allocations: Array<{
    market: string;
    weightBps: number;
    deployedBase: string;
  }>;
}

export async function fetchCuratorVaults(
  edgeUrl: string
): Promise<CuratorVaultSnapshot[]> {
  const res = await fetch(`${edgeUrl}/fixed-yield/curator-vaults`);
  if (!res.ok) {
    throw new Error(`edge GET /fixed-yield/curator-vaults → ${res.status}`);
  }
  const body = (await res.json()) as { vaults: CuratorVaultSnapshot[] };
  return body.vaults;
}
