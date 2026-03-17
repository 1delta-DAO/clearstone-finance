/**
 * KYC Store — pluggable interface over an in-memory Map.
 *
 * Swap this out for Postgres/SQLite/Redis in production by implementing
 * the same `KycStore` interface and updating the factory at the bottom.
 */

import type { KycRecord, KycStatus } from "../types.js";

export interface KycStore {
  create(
    record: Omit<KycRecord, "createdAt" | "updatedAt">
  ): KycRecord;
  findByWallet(walletAddress: string): KycRecord | undefined;
  updateStatus(
    walletAddress: string,
    status: KycStatus,
    whitelistResults?: KycRecord["whitelistResults"]
  ): KycRecord | undefined;
  findAll(): KycRecord[];
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

class InMemoryKycStore implements KycStore {
  private readonly records = new Map<string, KycRecord>();

  create(record: Omit<KycRecord, "createdAt" | "updatedAt">): KycRecord {
    if (this.records.has(record.walletAddress)) {
      throw new Error(
        `KYC record already exists for wallet ${record.walletAddress}`
      );
    }
    const now = new Date().toISOString();
    const full: KycRecord = { ...record, createdAt: now, updatedAt: now };
    this.records.set(record.walletAddress, full);
    return full;
  }

  findByWallet(walletAddress: string): KycRecord | undefined {
    return this.records.get(walletAddress);
  }

  updateStatus(
    walletAddress: string,
    status: KycStatus,
    whitelistResults?: KycRecord["whitelistResults"]
  ): KycRecord | undefined {
    const record = this.records.get(walletAddress);
    if (!record) return undefined;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (whitelistResults) record.whitelistResults = whitelistResults;
    return record;
  }

  findAll(): KycRecord[] {
    return Array.from(this.records.values());
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — replace implementation here to swap DB
// ---------------------------------------------------------------------------

export function createKycStore(): KycStore {
  return new InMemoryKycStore();
}
