import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { audit } from "./audit.js";
import { whitelist } from "./whitelist.js";

const app = new Hono<{ Bindings: Env }>();

// CORS — allow frontends
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
    ],
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
  })
);

// Health check
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "delta-edge",
    timestamp: new Date().toISOString(),
  })
);

// Mount route groups
app.route("/audit", audit);
app.route("/whitelist", whitelist);

export default app;
