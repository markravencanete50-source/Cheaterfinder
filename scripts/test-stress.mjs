#!/usr/bin/env node
/** Isolated, bounded, destructive-to-FIXTURES-only stress runner. Never starts
 * the app, workers or providers. Source database access is schema-only pg_dump.
 * Requires local PostgreSQL 16 binaries, Redis, and Node >=22 on Linux.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, chown, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")));
const allowed = new Set(["schema", "schema-from-local", "cases", "label", "build-dir", "test-file"]);
if (Object.keys(options).some(key => !allowed.has(key)) || (!options.schema && !options["schema-from-local"])) {
  console.error("Usage: npm run test:stress -- --schema=/path/schema-only.sql [--cases=billing,credentials,roster-pool,roster,crash,bandwidth] [--label=before]\nUse --cases=regressions, --cases=customer-flows or --cases=backend-all separately for isolated Vitest suites.\nLocal schema-only alternative: --schema-from-local=DATABASE (read-only pg_dump; NEVER copies data)");
  process.exit(2);
}
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22+ required");
if (options["test-file"] && (options.cases !== "backend-all" || !/^(server|shared)\/[\w/.-]+\.test\.ts$/.test(options["test-file"]) || options["test-file"].includes(".."))) {
  throw new Error("--test-file requires --cases=backend-all and a repository server/shared test path");
}
// Lower CPU scheduling priority for this runner and its children, not the app.
setPriority(0, 10);
const asRoot = process.getuid?.() === 0;
const pgBin = "/usr/lib/postgresql/16/bin";
const temp = await mkdtemp(join(tmpdir(), "cheaterfinder-stress-"));
const data = join(temp, "pgdata"), socket = join(temp, "socket");
await chmod(temp, 0o755);
await mkdir(data, { mode: 0o700 });
await mkdir(socket, { mode: 0o700 });
const identity = asRoot ? spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }) : null;
if (asRoot && identity.status !== 0) throw new Error("Local postgres OS user required");
if (asRoot) {
  const uid = Number(identity.stdout.trim());
  await chown(data, uid, uid); await chown(socket, uid, uid);
}
const commandEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
function run(command, args, { pg = false, input, timeout = 60_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(pg && asRoot ? "/usr/sbin/runuser" : command,
      pg && asRoot ? ["-u", "postgres", "--", command, ...args] : args,
      { cwd: root, env: commandEnv, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", b => out.push(b)); child.stderr.on("data", b => err.push(b));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().slice(-3000)}`));
      else resolveRun(Buffer.concat(out));
    });
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
const pgPort = await freePort(), redisPort = await freePort(), faultPort = await freePort();
const nonce = randomUUID(), dbName = ["regressions", "customer-flows", "backend-all"].includes(options.cases) ? "cheaterfinder_backend_fix_test_20260907" : "cheaterfinder_stress_" + nonce.replaceAll("-", "");
const started = new Date().toISOString();
const report = { started, label: options.label ?? "current", node: process.version, schemaSha256: "", isolation: { data, pgPort, redisPort, faultPort, database: dbName, productionDataCopied: false, fsync: true, maxConnections: 32, appPoolMax: 20 }, cases: [], limitations: ["Synthetic inputs and local services; not Instagram/Stripe/email acceptance or browser end-to-end proof", "Shared host, bounded concurrency: timings are observations, not production capacity/SLA", "Abrupt process death before an in-memory bandwidth flush remains outside durable delivery guarantees"] };
if (options["test-file"]) report.selectedTestFile = options["test-file"];
const sources=["server/db.ts","server/stripe.ts","server/services/customer-billing-lifecycle.ts","server/services/customer-credentials.ts","server/services/public-data-persistence.ts","server/services/diff-completeness.ts","server/services/roster-store.ts","server/services/operation-lease.ts","server/services/bandwidth-meter.ts","client/src/pages/admin/AdminBandwidth.tsx","client/src/pages/admin/shared.ts","scripts/test-stress.mjs","tests/stress/scenarios.ts","tests/stress/network-guard.mjs","tests/stress/crash-child.ts","tests/stress/bandwidth-scenario.ts","tests/stress/pg-fault-proxy.ts"];
report.sourceSha256=Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash("sha256").update(await readFile(join(root,path))).digest("hex")])));
let pgStarted = false, redis, active;
async function stop() {
  if (active && active.exitCode === null && active.signalCode === null) process.kill(-active.pid, "SIGKILL");
  if (redis && redis.exitCode === null) {
    const closed = new Promise(r => redis.once("close", r));
    redis.kill("SIGTERM"); await closed;
  }
  if (pgStarted) {
    await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { pg: true });
    pgStarted = false;
  }
}
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => { await stop(); process.exit(130); });
try {
  // This is the ONLY possible read from an existing DB. No app code receives its URL.
  const source = options["schema-from-local"];
  if (source && !/^[a-zA-Z0-9_]+$/.test(source)) throw new Error("Invalid local schema-source database name");
  const schema = options.schema ? await readFile(resolve(options.schema)) : await run(join(pgBin, "pg_dump"), ["--schema-only", "--no-owner", "--no-privileges", "--dbname", source], { pg: true });
  if (/^COPY .* FROM stdin;|^INSERT INTO /m.test(schema.toString())) throw new Error("Refusing a data-bearing dump; provide schema-only SQL");
  report.schemaSha256 = createHash("sha256").update(schema).digest("hex");
  await writeFile(join(temp, "schema.sql"), schema, { mode: 0o600 });
  await run(join(pgBin, "initdb"), ["-D", data, "--username=postgres", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"], { pg: true });
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-l", join(data, "server.log"), "-o", `-p ${pgPort} -h 127.0.0.1 -k ${socket} -c max_connections=32 -c shared_buffers=32MB -c work_mem=2MB -c max_parallel_workers=0 -c fsync=on -c synchronous_commit=on`, "-w", "start"], { pg: true });
  pgStarted = true;
  const psql = ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres"];
  await run(join(pgBin, "psql"), [...psql, "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
  await run(join(pgBin, "psql"), [...psql, "-d", dbName], { input: schema });
  // The retained schema-only snapshot predates the additive recent-read lane.
  // Apply pending source DDL ONLY inside this independently owned cluster.
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0053_roster_recent_checks.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0054_customer_trial_history.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0055_post_engagement_tracking_index.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0056_transactional_email_outbox.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0057_customer_retention.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0058_trial_payment_credit.sql"))});
  await run(join(pgBin,"psql"),[...psql,"-d",dbName],{input:await readFile(join(root,"migrations/0059_rescue_discount_offer.sql"))});
  report.appliedMigrations=["0053_roster_recent_checks.sql", "0054_customer_trial_history.sql", "0055_post_engagement_tracking_index.sql", "0056_transactional_email_outbox.sql", "0057_customer_retention.sql", "0058_trial_payment_credit.sql", "0059_rescue_discount_offer.sql"];
  await run(join(pgBin, "psql"), [...psql, "-d", dbName, "-c", `CREATE ROLE stress_app LOGIN; GRANT USAGE ON SCHEMA public TO stress_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO stress_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO stress_app; CREATE TABLE public.stress_safety_marker(nonce text PRIMARY KEY); INSERT INTO public.stress_safety_marker VALUES('${nonce}'); GRANT SELECT ON public.stress_safety_marker TO stress_app;`]);
  redis = spawn("/usr/bin/redis-server", ["--bind", "127.0.0.1", "--port", String(redisPort), "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction", "--dir", temp], { env: commandEnv, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((r, j) => {
    const timeout = setTimeout(() => j(new Error("Isolated Redis did not start")), 5000);
    redis.once("error", j); redis.once("exit", code => j(new Error(`Redis exited ${code}`)));
    redis.stdout.on("data", b => { if (b.toString().includes("Ready to accept connections")) { clearTimeout(timeout); r(); } });
  });
  const env = {
    ...commandEnv, NODE_ENV: "test", LOG_LEVEL: "error",
    DATABASE_URL: `postgresql://stress_app@127.0.0.1:${pgPort}/${dbName}`,
    STRESS_ADMIN_URL: `postgresql://postgres@127.0.0.1:${pgPort}/${dbName}`,
    STRESS_NONCE: nonce, STRESS_DATA_DIR: data, STRESS_FAULT_PORT: String(faultPort),
    STRESS_OUTPUT_DIR: temp,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
    STRESS_ALLOWED_PORTS: [pgPort, redisPort, faultPort].join(","),
    WORKERS_ENABLED: "false", WORKERS_DISABLED: "1", DOTENV_CONFIG_PATH: "/dev/null",
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { PLAYWRIGHT_EXECUTABLE_PATH: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    SESSION_SECRET: "isolated-stress-only-not-a-secret", BANDWIDTH_MAX_PENDING_KEYS: "5000",
    NODE_OPTIONS: `--max-old-space-size=512 --import=${join(root, "tests/stress/network-guard.mjs")}`,
  };
  const cases = (options.cases ?? "billing,credentials,roster-pool,roster,crash,bandwidth").split(",");
  if (cases.some(c => !["billing", "credentials", "roster-pool", "roster", "crash", "bandwidth", "regressions", "customer-flows", "backend-all"].includes(c))) throw new Error("Unknown stress case");
  if(cases.some(c=>["regressions","customer-flows","backend-all"].includes(c))&&cases.length!==1)throw new Error("Run Vitest cases separately (guarded fixed DB name, still in a private cluster)");
  console.log(JSON.stringify({ status: "isolated-services-ready", temp, ports: [pgPort, redisPort], cases }));
  for (const name of cases) {
    const resultFile = join(temp, `${name}.json`), logFile = join(temp, `${name}.log`);
    const begin = Date.now();
    console.log(`[stress] ${name}: running actual application code`);
    const output = [];
    const regressionFiles=["billing-retention.integration", "customer-auth-http.integration", "private-follow-access.integration", "customer-billing-lifecycle.integration", "checkout-lifecycle.integration", "customer-credentials.integration", "bandwidth-delivery.integration", "bandwidth-report-wire", "roster-background.integration", "roster-store.integration", "roster-reliability.integration", "diff-completeness"].map(file=>`server/services/__tests__/${file}.test.ts`);
    const vitestCase=["regressions","customer-flows","backend-all"].includes(name);
    const files=name==="backend-all"?(options["test-file"]?[options["test-file"]]:["server", "shared", "--exclude=**/customer-launch-flows.integration.test.ts", "--exclude=**/tracked-account-twins-private.integration.test.ts", "--exclude=**/media-cache-jobs.integration.test.ts"]):name==="customer-flows"?["server/services/__tests__/customer-launch-flows.integration.test.ts"]:regressionFiles;
    const args=vitestCase ? ["node_modules/vitest/vitest.mjs", "run", ...files, "--maxWorkers=1", "--reporter=default", "--reporter=json", `--outputFile=${resultFile}`] : ["--import", "tsx", "tests/stress/scenarios.ts", name, resultFile];
    const scenarioEnv=vitestCase ? {...env,BACKEND_FIX_TEST_DATABASE_URL:env.DATABASE_URL,ROSTER_TEST_DATABASE_URL:env.DATABASE_URL,TEST_DATABASE_URL:env.DATABASE_URL,
      ...(name==="customer-flows"?{CUSTOMER_FLOW_EVIDENCE_DIR:join(temp,"customer-flows"),...(options["build-dir"]?{CUSTOMER_FLOW_BUILD_DIR:resolve(options["build-dir"])}:{})}:{}),} : env;
    active = spawn(process.execPath, args, { cwd: root, env:scenarioEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    active.stdout.on("data", b => { output.push(b); process.stdout.write(b); });
    active.stderr.on("data", b => { output.push(b); process.stderr.write(b); });
    const timedOut = setTimeout(() => { if(active?.pid)process.kill(-active.pid,"SIGKILL"); }, name === "backend-all" ? 600_000 : 180_000);
    const heartbeat = setInterval(() => console.log(`[stress] ${name}: ${Math.round((Date.now() - begin) / 1000)}s elapsed`), 20_000);
    const code = await new Promise((r, j) => { active.once("error", j); active.once("close", r); });
    clearTimeout(timedOut); clearInterval(heartbeat);
    await writeFile(logFile, Buffer.concat(output), { mode: 0o600 });
    const rawResult = await readFile(resultFile, "utf8").then(JSON.parse).catch(() => ({ error: "Scenario exited before writing a result" }));
    const result=vitestCase ? {passed:rawResult.success===true&&rawResult.numPendingTests===0,metrics:{passed:rawResult.numPassedTests,failed:rawResult.numFailedTests,pending:rawResult.numPendingTests},...(rawResult.error?{error:rawResult.error}:{})} : rawResult;
    const exitCode=code===0&&result.passed!==true?1:code;
    report.cases.push({ name, exitCode, elapsedMs: Date.now() - begin, ...result });
    console.log(`[stress] ${name}: ${exitCode === 0 ? "PASS" : "FAIL (including missing/skipped evidence)"}`);
  }
} catch (e) {
  report.setupError = e.stack ?? String(e);
  console.error(report.setupError);
} finally {
  try { await stop(); report.servicesStopped = true; }
  catch(e) { report.servicesStopped = false; report.cleanupError = e.message; console.error("Test service cleanup failed:",e.message); }
  report.finished = new Date().toISOString();
  await writeFile(join(temp, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`[stress] Evidence: ${join(temp, "report.json")} (${report.servicesStopped?"test services stopped":"CLEANUP NEEDS ATTENTION"}; retained for diagnosis)`);
}
process.exitCode = report.setupError || report.cleanupError || report.cases.some(c => c.exitCode !== 0) || !report.cases.length ? 1 : 0;
