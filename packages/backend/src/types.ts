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
