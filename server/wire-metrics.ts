// Dedicated privileged counter collector. No HTTP server, customer workers,
// browser automation or payment credentials are loaded by this entrypoint.
import { startProxyWireSampler, stopProxyWireSampler } from "./services/proxy-wire-sampler.js";
import { pool } from "./db.js";
import { logger } from "./observability/logger.js";
if (process.getuid?.() !== 0) throw new Error("Wire counter service requires its privileged service identity");
if (process.env.PROXY_WIRE_SAMPLER_ENABLED !== "true" || !process.env.PROXY_GATEWAY_HOST) {
  throw new Error("Wire counter service needs explicit configuration");
}
startProxyWireSampler();
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await stopProxyWireSampler(); await pool.end(); clearInterval(keepAlive); }
  catch (err) { logger.error({ err }, "wire counter shutdown failed"); process.exitCode = 1; clearInterval(keepAlive); }
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
