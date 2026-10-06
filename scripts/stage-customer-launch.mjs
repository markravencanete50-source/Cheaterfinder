// Build artifacts only. Never invokes script/build.ts's live-dist deletion.
import { build } from "esbuild";
import { readFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const stage = resolve(process.argv[2] ?? "");
const backendOnly = process.argv[3] === "--backend-only";
if (!/^\/tmp\/cheaterfinder-customer-launch-build-[A-Za-z0-9]+$/.test(stage)) throw new Error("Explicit temporary customer-launch build directory required");
await readFile(join(stage,"dist/public/index.html")); // Vite must have finished
if (backendOnly) await readFile(join(stage,"dist/app-shell.html")); // exact existing shell, never prerender it twice
const buildSource = await readFile(join(repo,"script/build.ts"),"utf8");
const allowlistSource = buildSource.match(/const allowlist = \[([\s\S]*?)\];/)?.[1];
if (!allowlistSource) throw new Error("Cannot read canonical backend dependency allowlist");
const allowlist = new Set([...allowlistSource.matchAll(/"([^"]+)"/g)].map(match=>match[1]));
const pkg=JSON.parse(await readFile(join(repo,"package.json"),"utf8"));
const external=[...Object.keys(pkg.dependencies??{}),...Object.keys(pkg.devDependencies??{})].filter(dep=>!allowlist.has(dep));
await build({entryPoints:["server/index.ts"],platform:"node",bundle:true,format:"cjs",outfile:join(stage,"dist/index.cjs"),
  define:{"process.env.NODE_ENV":'"production"'},minify:true,external,logLevel:"info"});
if (backendOnly) {
  console.log(JSON.stringify({stage,backend:join(stage,"dist/index.cjs"),frontend:"existing verified artifacts, unchanged"}));
  process.exit(0);
}
await build({entryPoints:["script/prerender.ts"],platform:"node",bundle:true,format:"esm",packages:"external",outfile:join(stage,"prerender.mjs")});
await symlink(join(repo,"node_modules"),join(stage,"node_modules"),"dir").catch(error=>{if(error.code!=="EEXIST")throw error;});
process.chdir(stage);
const {prerender}=await import(pathToFileURL(join(stage,"prerender.mjs")).href);
await prerender();
console.log(JSON.stringify({stage,backend:join(stage,"dist/index.cjs"),public:join(stage,"dist/public"),shell:join(stage,"dist/app-shell.html")}));
