import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat, unlink, writeFile, appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export async function postgresBackupTools(databaseUrl, pgEnv) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000" });
  let serverMajor;
  try {
    await client.connect();
    const result = await client.query("SHOW server_version_num");
    serverMajor = Math.floor(Number(result.rows[0].server_version_num) / 10_000);
  } finally { await client.end(); }
  if (!Number.isInteger(serverMajor) || serverMajor < 12) throw new Error("Unsupported PostgreSQL server version");
  const directory = `/usr/lib/postgresql/${serverMajor}/bin`;
  const dump = existsSync(join(directory, "pg_dump")) ? join(directory, "pg_dump") : "pg_dump";
  const restore = existsSync(join(directory, "pg_restore")) ? join(directory, "pg_restore") : "pg_restore";
  for (const binary of [dump, restore]) {
    const { stdout } = await promisify(execFile)(binary, ["--version"], { env: pgEnv, timeout: 10_000 });
    if (Number(stdout.match(/PostgreSQL\)?\s+(\d+)/)?.[1]) !== serverMajor) {
      throw new Error("Backup tools must match the PostgreSQL server major version");
    }
  }
  return { dump, restore, serverMajor };
}

/** The URL never reaches process arguments, an archive manifest, or a log. */
export function postgresBackupEnvironment(databaseUrl, inherited = process.env) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error("A valid DATABASE_URL is required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    throw new Error("Unsupported backup database URL");
  }
  const env = { ...inherited,
    PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: "10", PGAPPNAME: "cheaterfinder_verified_backup",
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function runPostgresCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", () => reject(new Error(`${command} could not start`)));
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code})`)));
  });
}

async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Publish only an archive pg_dump finished AND pg_restore can parse. A failed
 * attempt never overwrites a previous backup or leaves a success-looking file.
 * runCommand is injected only by local tests; the CLI always uses real binaries.
 */
export async function runDatabaseBackup({ databaseUrl, directory, runCommand = runPostgresCommand, resolveTools = postgresBackupTools, env = process.env, now = new Date() }) {
  const pgEnv = postgresBackupEnvironment(databaseUrl, env);
  const tools = await resolveTools(databaseUrl, pgEnv);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const name = `${pgEnv.PGDATABASE}-${timestamp}-${randomUUID().slice(0, 8)}.dump`;
  const partial = join(directory, `.${name}.partial`), archive = join(directory, name);
  const manifestPartial = join(directory, `.${name}.json.partial`), manifest = archive + ".json";
  try {
    const reservation = await open(partial, "wx", 0o600);
    await reservation.close();
    await runCommand(tools.dump, ["--format=custom", "--compress=6", "--no-owner", "--no-acl", "--file", partial], pgEnv);
    await chmod(partial, 0o600);
    const bytes = (await stat(partial)).size;
    if (bytes < 5) throw new Error("Backup archive is empty");
    await runCommand(tools.restore, ["--list", partial], pgEnv);
    const sha256 = await checksum(partial);
    const record = { file: name, format: "postgres-custom", postgresMajor: tools.serverMajor, createdAt: now.toISOString(), bytes, sha256, archiveVerified: true, restoreVerified: false };
    await writeFile(manifestPartial, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (const file of [partial, manifestPartial]) {
      const handle = await open(file, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await rename(partial, archive);
    await rename(manifestPartial, manifest);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return record;
  } finally {
    // Only the two uniquely reserved partial files belonging to THIS attempt.
    // A published archive is retained even if manifest publication failed.
    await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
    await unlink(manifestPartial).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Retention covers only this script's timestamped custom archives, never
 * legacy SQL backups. Preserve at least the two newest verified generations.
 */
export async function pruneVerifiedBackups(directory, databaseName, retentionDays = 14) {
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseName) || retentionDays < 1) throw new Error("Invalid retention policy");
  const prefix = databaseName + "-";
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !/^\d{8}-\d{6}-[a-f0-9]{8}\.dump$/.test(name.slice(prefix.length))) continue;
    try {
      const manifest = JSON.parse(await readFile(join(directory, name + ".json"), "utf8"));
      const info = await stat(join(directory, name));
      if (manifest.file === name && manifest.archiveVerified === true && manifest.bytes === info.size) candidates.push({ name, mtime: info.mtimeMs });
    } catch { /* Unverified files are never silently deleted. */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const item of candidates.slice(2)) {
    if (item.mtime >= Date.now() - retentionDays * 86_400_000) continue;
    await unlink(join(directory, item.name));
    await unlink(join(directory, item.name + ".json"));
    removed.push(item.name);
  }
  return removed;
}

async function main() {
  process.umask(0o077);
  config({ path: resolve(scriptDir, "../.env") });
  const directory = process.env.BACKUP_DIRECTORY || "/var/backups/cheaterfinder";
  const logFile = process.env.BACKUP_LOG_FILE || "/var/log/cheaterfinder-backup.log";
  const log = message => appendFile(logFile, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  try {
    await log("Starting verified database backup");
    const record = await runDatabaseBackup({ databaseUrl: process.env.DATABASE_URL, directory });
    await log(`Backup archive verified: ${record.file} (${record.bytes} bytes, sha256 ${record.sha256}); isolated restore not yet verified`);
    const databaseName = postgresBackupEnvironment(process.env.DATABASE_URL).PGDATABASE;
    const removed = await pruneVerifiedBackups(directory, databaseName);
    if (removed.length) await log(`Retention removed verified archives: ${removed.join(", ")}`);
    console.log(JSON.stringify(record));
  } catch {
    // pg_dump may echo private SQL/connection details. Do not copy stderr into
    // an archive or application log. Nonzero cron exit remains actionable.
    await log("ERROR: database backup failed; no success declared").catch(() => {});
    console.error("Database backup failed; existing archives preserved");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
