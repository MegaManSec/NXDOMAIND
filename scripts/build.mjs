
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";

const target = process.argv[2]; // "chrome" | "firefox"
if (!target) { console.error("Usage: node scripts/build.mjs <chrome|firefox>"); process.exit(1); }

const root = process.cwd();
const outDir = path.join(root, "dist", target);
fs.mkdirSync(outDir, { recursive: true });

const isChrome = target === "chrome";
await build({
  entryPoints: ["src/background.ts"],
  bundle: true,
  minify: false,
  sourcemap: false,
  platform: "browser",
  format: isChrome ? "esm" : "iife",
  target: isChrome ? "chrome115" : "firefox115",
  outfile: path.join(outDir, "background.js"),
});

// generate manifest + copy static
child_process.execSync(`node scripts/gen-manifest.mjs ${target}`, { stdio: "inherit" });
child_process.execSync(`node scripts/copy-static.mjs ${target}`, { stdio: "inherit" });

console.log(`Built ${target} → ${outDir}`);
