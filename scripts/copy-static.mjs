import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/copy-static.mjs <chrome|firefox>');
  process.exit(1);
}

const root = process.cwd();
const outDir = path.join(root, 'dist', target);

const copies = [
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/popup/popup.js', 'popup.js'],
  ['src/csp-listener.js', 'csp-listener.js'],
  ['icons/icon16-blue.png', 'icons/icon16-blue.png'],
  ['icons/icon32-blue.png', 'icons/icon32-blue.png'],
  ['icons/icon128-blue.png', 'icons/icon128-blue.png'],
  ['icons/icon16-yellow.png', 'icons/icon16-yellow.png'],
  ['icons/icon32-yellow.png', 'icons/icon32-yellow.png'],
  ['icons/icon128-yellow.png', 'icons/icon128-yellow.png'],
];

for (const [src, dest] of copies) {
  const absSrc = path.join(root, src);
  const absDest = path.join(outDir, dest);
  fs.mkdirSync(path.dirname(absDest), { recursive: true });
  fs.copyFileSync(absSrc, absDest);
}
console.log(`Copied static assets for ${target}`);
