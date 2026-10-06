// Loaded before tsx/application imports in EVERY scenario and crash child.
// Provider credentials are absent; additionally fail closed on network mistakes.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const allowed = new Set((process.env.STRESS_ALLOWED_PORTS ?? "").split(",").map(Number));
if (!process.env.STRESS_NONCE || allowed.size !== 3 || allowed.has(5432) || allowed.has(6379)) throw new Error("Missing/unsafe isolated stress network configuration");
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node internals sometimes pass their already-normalized [options, callback].
  const a = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof a[0] === "object" ? a[0] : { port: a[0], host: typeof a[1] === "string" ? a[1] : "localhost" };
  const host = options.host ?? "localhost";
  if (options.path || !["127.0.0.1", "localhost", "::1"].includes(host) || !allowed.has(Number(options.port))) {
    throw new Error(`STRESS_NETWORK_DENIED ${host}:${options.port ?? "unix-socket"}`);
  }
  return Reflect.apply(original, this, args);
};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !allowed.has(Number(url.port))) return Promise.reject(new Error("STRESS_NETWORK_DENIED fetch"));
  return fetchOriginal(input, init);
};
syncBuiltinESMExports();
