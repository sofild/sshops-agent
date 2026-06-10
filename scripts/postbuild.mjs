/**
 * Post-build: 给 dist 入口文件加 shebang
 *  - 否则 npm link 后 Windows .cmd shim 会因为没 shebang 而失败
 *  - Linux/macOS 直接 node 调用也需要 shebang
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targets = [
  resolve(__dirname, '..', 'dist', 'main.js'),
  resolve(__dirname, '..', 'dist', 'cli', 'root.js'),
];

const shebang = '#!/usr/bin/env node\n';
let added = 0;
let skipped = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  const content = readFileSync(target, 'utf-8');
  if (content.startsWith(shebang)) {
    skipped++;
    continue;
  }
  writeFileSync(target, shebang + content, 'utf-8');
  added++;
}
console.log(`[postbuild] shebang added=${added} skipped=${skipped}`);
