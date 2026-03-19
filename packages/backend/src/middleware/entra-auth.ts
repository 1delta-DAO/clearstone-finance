/**
 * Fastify preHandler — Microsoft Entra B2C authentication.
 *
 * Extracts the Bearer token from the Authorization header, validates it via
 * the Entra JWKS endpoint, and attaches the verified claims to the request.
 *
 * Usage (on a single route):
 *   app.post("/auth/link-wallet", { preHandler: requireEntraAuth }, handler)
 *
 * Usage (on a whole plugin):
 *   app.addHook("preHandler", requireEntraAuth)
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { getEntraService, type EntraTokenClaims } from "../services/entra.service.js";

// Extend Fastify's request type so handlers can access `req.entraUser`
declare module "fastify" {
  interface FastifyRequest {
    entraUser?: EntraTokenClaims;
  }
}

// Role assigned in Azure portal → App registrations → App roles
// Assign this role to compliance officers who can approve/reject KYC
const ADMIN_ROLE = "VaultAdmin";

export async function requireEntraAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({
      success: false,
      error: "Missing or malformed Authorization header. Expected: Bearer <token>",
    });
  }

  const token = authHeader.slice(7).trim();

  try {
    const claims = await getEntraService().validateToken(token);
    req.entraUser = claims;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token validation failed";
    return reply.status(401).send({ success: false, error: `Entra auth: ${message}` });
  }
}

/**
 * Extends requireEntraAuth — also checks that the token carries the VaultAdmin
 * app role. Assign this role in Azure portal → App registrations → App roles
 * to compliance officers who are allowed to approve/reject KYC applications.
 */
export async function requireEntraAdmin(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireEntraAuth(req, reply);

  // If requireEntraAuth already sent a 401, stop here
  if (reply.sent) return;

  if (!req.entraUser?.roles?.includes(ADMIN_ROLE)) {
    return reply.status(403).send({
      success: false,
      error: `Forbidden: requires the '${ADMIN_ROLE}' app role in Entra.`,
    });
  }
}
