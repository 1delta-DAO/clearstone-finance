import type { FastifyInstance } from "fastify";
import {
  getKycService,
  ValidationError,
  NotFoundError,
  ConflictError,
  ComplianceError,
} from "../services/kyc.service.js";
import type { SubmitKycBody, ApproveRejectBody } from "../types.js";

function errorResponse(err: unknown): { statusCode: number; error: string } {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof ComplianceError
  ) {
    return { statusCode: err.statusCode, error: err.message };
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return { statusCode: 500, error: msg };
}

export async function kycRoutes(app: FastifyInstance): Promise<void> {
  const svc = getKycService();

  // -------------------------------------------------------------------------
  // POST /kyc/submit
  // -------------------------------------------------------------------------
  app.post<{ Body: SubmitKycBody }>("/kyc/submit", async (req, reply) => {
    try {
      const record = await svc.submitKyc(req.body);
      return reply.status(201).send({ success: true, data: record });
    } catch (err) {
      const { statusCode, error } = errorResponse(err);
      return reply.status(statusCode).send({ success: false, error });
    }
  });

  // -------------------------------------------------------------------------
  // GET /kyc/status/:walletAddress
  // -------------------------------------------------------------------------
  app.get<{ Params: { walletAddress: string } }>(
    "/kyc/status/:walletAddress",
    async (req, reply) => {
      try {
        const record = svc.getStatus(req.params.walletAddress);
        return reply.send({ success: true, data: record });
      } catch (err) {
        const { statusCode, error } = errorResponse(err);
        return reply.status(statusCode).send({ success: false, error });
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /kyc/approve
  // -------------------------------------------------------------------------
  app.post<{ Body: ApproveRejectBody }>("/kyc/approve", async (req, reply) => {
    try {
      const record = await svc.approveWallet(req.body.walletAddress);
      return reply.send({ success: true, data: record });
    } catch (err) {
      const { statusCode, error } = errorResponse(err);
      return reply.status(statusCode).send({ success: false, error });
    }
  });

  // -------------------------------------------------------------------------
  // POST /kyc/reject
  // -------------------------------------------------------------------------
  app.post<{ Body: ApproveRejectBody }>("/kyc/reject", async (req, reply) => {
    try {
      const record = await svc.rejectWallet(req.body.walletAddress);
      return reply.send({ success: true, data: record });
    } catch (err) {
      const { statusCode, error } = errorResponse(err);
      return reply.status(statusCode).send({ success: false, error });
    }
  });

  // -------------------------------------------------------------------------
  // GET /kyc/list  (admin utility)
  // -------------------------------------------------------------------------
  app.get("/kyc/list", async (_req, reply) => {
    return reply.send({ success: true, data: svc.listAll() });
  });
}
