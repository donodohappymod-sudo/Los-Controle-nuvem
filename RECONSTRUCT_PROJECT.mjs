import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
for (const name of fs.readdirSync(root)) {
  if (!name.includes('__')) continue;
  const target = name.split('__').join(path.sep);
  const src = path.join(root, name);
  const dst = path.join(root, target);
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  if (!fs.existsSync(dst)) fs.copyFileSync(src,dst);
}
