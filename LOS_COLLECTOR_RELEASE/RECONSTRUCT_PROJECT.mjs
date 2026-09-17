import fs from 'node:fs';
import path from 'node:path';

// Safety net for upload tools that flatten folders on GitHub/mobile uploads.
// If real folders already exist, this does nothing harmful.
const root = process.cwd();
for (const name of fs.readdirSync(root)) {
  if (!name.includes('__')) continue;
  const src = path.join(root, name);
  if (!fs.statSync(src).isFile()) continue;
  const target = name.split('__').join(path.sep);
  const dst = path.join(root, target);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}
