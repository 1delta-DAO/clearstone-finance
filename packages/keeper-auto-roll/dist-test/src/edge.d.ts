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
export declare function fetchCuratorVaults(edgeUrl: string): Promise<CuratorVaultSnapshot[]>;
//# sourceMappingURL=edge.d.ts.map