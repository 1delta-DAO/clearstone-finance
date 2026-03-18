/**
 * Authentication routes — Microsoft Entra B2C identity linking.
 *
 * POST /auth/link-wallet
 *   Links a verified Entra B2C identity (sub claim) to a Solana wallet address.
 *   The caller must present a valid Entra Bearer token.
 *
 *   After linking, the wallet's KYC record carries the `entraSubjectId`, proving
 *   that the wallet owner has been authenticated by the bank's institutional IDP
 *   (Microsoft Entra B2C per Amina's requirements).
 *
 * GET /auth/identity/:walletAddress
 *   Returns the Entra identity linked to a wallet (admin / audit use).
 *
 * GET /auth/me
 *   Returns the KYC record for the authenticated Entra user (self-service).
 */

import type { FastifyInstance } from "fastify";
import { requireEntraAuth } from "../middleware/entra-auth.js";
import { getKycService, NotFoundError } from "../services/kyc.service.js";
import { EntraService } from "../services/entra.service.js";
import { getBlockchainService } from "../services/blockchain.service.js";

interface LinkWalletBody {
  walletAddress: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const kycSvc = getKycService();
  const blockchain = getBlockchainService();

  // -------------------------------------------------------------------------
  // POST /auth/link-wallet
  // Requires: Authorization: Bearer <entra_token>
  // Body:     { walletAddress: string }
  // -------------------------------------------------------------------------
  app.post<{ Body: LinkWalletBody }>(
    "/auth/link-wallet",
    { preHandler: requireEntraAuth },
    async (req, reply) => {
      const claims = req.entraUser!;
      const { walletAddress } = req.body;

      if (!walletAddress?.trim()) {
        return reply.status(400).send({ success: false, error: "walletAddress is required" });
      }

      if (!blockchain.validateAddress(walletAddress)) {
        return reply.status(400).send({ success: false, error: "Invalid Solana wallet address" });
      }

      // Prevent one Entra identity from claiming multiple wallets
      const existingBySub = kycSvc.findByEntraSub(claims.sub);
      if (existingBySub && existingBySub.walletAddress !== walletAddress) {
        return reply.status(409).send({
          success: false,
          error: `This Entra identity is already linked to wallet ${existingBySub.walletAddress}`,
        });
      }

      // Ensure a KYC record exists for the wallet before linking
      let kycRecord = kycSvc.getStatusOrNull(walletAddress);
      if (!kycRecord) {
        // Auto-create a stub KYC record from the Entra claims so the compliance
        // team can approve it — they now have a verified institutional identity anchor.
        const email = EntraService.extractEmail(claims) ?? "";
        const name = claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(" ") ?? "Unknown";

        kycRecord = await kycSvc.submitKyc({
          walletAddress,
          entityType: "individual",
          name,
          email,
        });
      }

      const linked = kycSvc.linkEntraSub(walletAddress, claims.sub);
      if (!linked) {
        return reply.status(500).send({ success: false, error: "Failed to link identity" });
      }

      return reply.status(200).send({
        success: true,
        data: {
          walletAddress,
          entraSubjectId: claims.sub,
          kycStatus: linked.status,
          message: "Entra identity linked to wallet. KYC review is pending.",
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /auth/me
  // Requires: Authorization: Bearer <entra_token>
  // Returns the KYC record for the authenticated Entra user.
  // -------------------------------------------------------------------------
  app.get(
    "/auth/me",
    { preHandler: requireEntraAuth },
    async (req, reply) => {
      const claims = req.entraUser!;
      const record = kycSvc.findByEntraSub(claims.sub);

      if (!record) {
        return reply.status(404).send({
          success: false,
          error: "No wallet linked to this Entra identity. Call POST /auth/link-wallet first.",
        });
      }

      return reply.send({ success: true, data: record });
    }
  );

  // -------------------------------------------------------------------------
  // GET /auth/identity/:walletAddress  (admin / audit)
  // Returns Entra identity info for a given wallet address.
  // -------------------------------------------------------------------------
  app.get<{ Params: { walletAddress: string } }>(
    "/auth/identity/:walletAddress",
    async (req, reply) => {
      try {
        const record = kycSvc.getStatus(req.params.walletAddress);
        return reply.send({
          success: true,
          data: {
            walletAddress: record.walletAddress,
            entraSubjectId: record.entraSubjectId ?? null,
            entraLinked: !!record.entraSubjectId,
            kycStatus: record.status,
          },
        });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ success: false, error: (err as Error).message });
        }
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    }
  );
}
