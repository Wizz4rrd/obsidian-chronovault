// Bundles tests/*.test.ts with esbuild and runs them with node:test. "obsidian" is replaced by the small stand-in in tests/stubs.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const outdir = ".test-build";
rmSync(outdir, { recursive: true, force: true });
const entryPoints = readdirSync("tests")
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => `tests/${f}`);
await esbuild.build({ entryPoints, outdir, bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" }, alias: { obsidian: "./tests/stubs/obsidian.ts" }, logLevel: "warning" });
const res = spawnSync(process.execPath, ["--test", outdir], { stdio: "inherit" });
rmSync(outdir, { recursive: true, force: true });
process.exit(res.status ?? 1);
