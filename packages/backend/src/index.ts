import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { kycRoutes } from "./routes/kyc.routes.js";
import { config } from "./config.js";

const app = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

await app.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindowMs,
  errorResponseBuilder: (_req, context) => ({
    success: false,
    error: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s`,
  }),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

await app.register(kycRoutes);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
