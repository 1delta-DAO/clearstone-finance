export type KycStatus = "pending" | "approved" | "rejected";
export type EntityType = "individual" | "company";

export interface KycRecord {
  walletAddress: string;
  entityType: EntityType;
  name: string;
  email: string;
  status: KycStatus;
  // Per-pool whitelist results, populated on approval.
  // One entry per mint in WRAPPED_MINT_ADDRESSES.
  whitelistResults?: Array<{ mintAddress: string; signature: string; whitelistEntryAddress: string }>;

  createdAt: string;    // ISO timestamp
  updatedAt: string;
}

export interface SubmitKycBody {
  walletAddress: string;
  entityType: EntityType;
  name: string;
  email: string;
}

export interface ApproveRejectBody {
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// KYT (Know Your Transaction)
// ---------------------------------------------------------------------------

export type KytRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface KytResult {
  walletAddress: string;
  riskLevel: KytRiskLevel;
  /** Flags from the screening provider, e.g. "SANCTIONS_MATCH", "MIXER" */
  flags: string[];
  screenedAt: string; // ISO timestamp
  /** External reference ID from real provider */
  providerRef?: string;
}

export type KytRecord = KytResult;


// ---------------------------------------------------------------------------
// Risk Controls
// ---------------------------------------------------------------------------

export interface RiskCheckResult {
  passed: boolean;
  /** Populated when passed === false */
  reason?: string;
  walletExposureUsd: number;
  poolExposureUsd: number;
}
