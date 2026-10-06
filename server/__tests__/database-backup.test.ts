import { mkdtemp, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error CLI is a native ESM script without a separate declaration.
import { runDatabaseBackup, postgresBackupEnvironment } from "../../scripts/backup-database.mjs";

describe("verified database backup publication", () => {
  const databaseUrl = "postgres://fixture:private%40value@127.0.0.1:5544/fixture_backup";
  const resolveTools = async () => ({dump:"pg_dump",restore:"pg_restore",serverMajor:16});
  const withDirectory = async (work: (directory: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), "cheaterfinder-backup-unit-"));
    try { await work(directory); } finally { await rm(directory, { recursive: true }); }
  };
  it("passes credentials through environment, not argv", () => {
    const env = postgresBackupEnvironment(databaseUrl, {});
    expect(env).toMatchObject({PGUSER:"fixture",PGPASSWORD:"private@value",PGDATABASE:"fixture_backup",PGPORT:"5544"});
    expect(() => postgresBackupEnvironment("file:///etc/passwd")).toThrow();
  });
  it("a dump failure cannot publish a success-looking archive or remove an old backup", async () => withDirectory(async directory => {
    await writeFile(join(directory,"previous.sql.gz"),"prior-backup");
    await expect(runDatabaseBackup({databaseUrl,directory,resolveTools,runCommand:async (_cmd:string,args:string[])=>{
      await writeFile(args.at(-1)!,"pg_dump: simulated error"); throw new Error("dump failed");
    }})).rejects.toThrow("dump failed");
    expect(await readdir(directory)).toEqual(["previous.sql.gz"]);
    expect(await readFile(join(directory,"previous.sql.gz"),"utf8")).toBe("prior-backup");
  }));
  it("rejects an archive which the restore tool cannot parse", async () => withDirectory(async directory => {
    await expect(runDatabaseBackup({databaseUrl,directory,resolveTools,runCommand:async (command:string,args:string[])=>{
      if(command === "pg_dump") await writeFile(args.at(-1)!,"corrupt-archive");
      else throw new Error("parse failed");
    }})).rejects.toThrow("parse failed");
    expect(await readdir(directory)).toEqual([]);
  }));
  it("atomically publishes a restricted archive and checksum manifest, without claiming a restore", async () => withDirectory(async directory => {
    const commands: string[] = [];
    const record = await runDatabaseBackup({databaseUrl,directory,resolveTools,runCommand:async (command:string,args:string[])=>{
      commands.push(command);
      expect(JSON.stringify(args)).not.toMatch(/private|postgres:\/\//);
      if(command === "pg_dump") await writeFile(args.at(-1)!,"PGDMP-fixture-only");
    }});
    expect(commands).toEqual(["pg_dump","pg_restore"]);
    expect(record).toMatchObject({archiveVerified:true,restoreVerified:false,bytes:18});
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(directory,record.file))).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual([record.file,record.file+".json"].sort());
    expect(JSON.parse(await readFile(join(directory,record.file+".json"),"utf8"))).toEqual(record);
  }));
});
