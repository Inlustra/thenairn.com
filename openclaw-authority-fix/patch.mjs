import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const patches = [
  {
    file: 'principal-CweFVZNq.mjs',
    hash: 'bfc14ec79a60aef407c94b1679e6b4d87f7ebefbad7d68e45c5c32e5c52e02f9',
    before: 'const senderIsOwner = params.restoredCronContinuation ? true : clientHasAdminScope(params.client);',
    after: 'const senderIsOwner = params.inputProvenance?.kind === "inter_session" ? false : params.restoredCronContinuation ? true : clientHasAdminScope(params.client);',
  },
  {
    file: 'openclaw-tools-Bo9W_tg_.mjs',
    hash: 'f8d27b259dbb9bc4ffd491c3e756004d35433974653e488682fc8369080e4124',
    before: 'if (options.senderIsOwner === false) throw new ToolAuthorizationError("Conversation tools require owner access");',
    after: 'if (options.senderIsOwner !== true) throw new ToolAuthorizationError("Conversation tools require owner access");',
  },
];
const digest = text => createHash('sha256').update(text).digest('hex');
export function transform(source, patch) {
  if (source.includes(patch.after)) {
    const original = source.replace(patch.after, patch.before);
    if (digest(original) === patch.hash) return source;
  }
  if (digest(source) !== patch.hash || source.split(patch.before).length !== 2)
    throw new Error(`Unrecognized runtime artifact: ${patch.file}; refusing to patch`);
  return source.replace(patch.before, patch.after);
}
export function apply(appRoot, write = false) {
  if (JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'))).version !== '2026.9.4')
    throw new Error('This repair is pinned to OpenClaw 2026.9.4');
  // Validate the whole pair before writing either file.
  const changes = patches.map(patch => {
    const file = path.join(appRoot, 'dist', patch.file);
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, patch) };
  });
  // Refuse any conflicting backup before changing either runtime artifact.
  for (const { file, source, next } of changes) {
    const backup = `${file}.before-milo-authority-fix`;
    if (write && next !== source && fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') !== source)
      throw new Error('Backup mismatch');
  }
  for (const { file, source, next } of changes) {
    if (write && next !== source) {
      const backup = `${file}.before-milo-authority-fix`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, source, { flag: 'wx', mode: 0o600 });
      else if (fs.readFileSync(backup, 'utf8') !== source) throw new Error('Backup mismatch');
      fs.writeFileSync(file, next);
    }
  }
  return { checked: changes.length, changed: changes.filter(c => c.source !== c.next).length, applied: write };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(apply(process.env.OPENCLAW_APP_ROOT || '/app', process.argv.includes('--apply'))));
