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
