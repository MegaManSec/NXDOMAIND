import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2]; // "chrome" | "firefox"
if (!target) {
  console.error('Usage: node scripts/gen-manifest.mjs <chrome|firefox>');
  process.exit(1);
}

const root = process.cwd();
const base = JSON.parse(fs.readFileSync(path.join(root, 'manifests/base.json'), 'utf8'));
const patch = JSON.parse(
  fs.readFileSync(path.join(root, `manifests/${target}.patch.json`), 'utf8'),
);

function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }
  return b === undefined ? a : b;
}

let manifest = deepMerge(base, patch);
if (target === 'firefox' && manifest.action) {
  delete manifest.action;
}
const outDir = path.join(root, 'dist', target);
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${target}/manifest.json`);
