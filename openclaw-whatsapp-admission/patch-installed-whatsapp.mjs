import { copyFileSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.env.OPENCLAW_NPM_PROJECTS_ROOT || "/home/node/.openclaw/npm/projects";
const messages = JSON.parse(readFileSync(new URL("./messages.json", import.meta.url), "utf8"));
const contact = messages.contact;
const packageRoots = globSync(`${root}/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/dist`);
if (packageRoots.length === 0) {
  throw new Error("No managed @openclaw/whatsapp runtime package was found");
}

function escapeVcard(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}

const contactPayload = {
  contacts: {
    displayName: contact.displayName,
    contacts: [{
      displayName: contact.displayName,
      vcard: [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${escapeVcard(contact.displayName)}`,
        `ORG:${escapeVcard(contact.organization)};`,
        `TITLE:${escapeVcard(contact.title)}`,
        `TEL;type=CELL;type=VOICE;waid=${contact.phone.replace(/^\+/, "")}:${contact.phone}`,
        "END:VCARD",
      ].join("\n"),
    }],
  },
};

function replaceOnce(file, marker, pattern, replacement) {
  const source = readFileSync(file, "utf8");
  if (source.includes(marker)) return false;
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
  if (!matches || matches.length !== 1) {
    throw new Error(`${path.basename(file)}: expected one patch site for ${marker}, found ${matches?.length ?? 0}`);
  }
  const backup = `${file}.pre-whatsapp-admission`;
  try {
    readFileSync(backup);
  } catch {
    copyFileSync(file, backup);
  }
  writeFileSync(file, source.replace(pattern, replacement));
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  return true;
}

function migrateLegacyPairingReply(file, replacement) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("thenairn-whatsapp-admission: friendly quarantined-sender reply")) return false;
  const pattern = /\t\t\t\t\/\/ thenairn-whatsapp-admission: friendly quarantined-sender reply\n\t\t\t\tbuildReplyText: \(\{ code \}\) => \[\n\t\t\t\t\t\.\.\.\[[^\n]+\],\n\t\t\t\t\t`Approval code: \$\{code\}`\n\t\t\t\t\]\.join\("\\n"\),/;
  const matches = source.match(new RegExp(pattern.source, "g"));
  if (!matches) return false;
  if (matches.length !== 1) throw new Error(`${path.basename(file)}: expected one legacy sender-reply patch, found ${matches.length}`);
  writeFileSync(file, source.replace(pattern, replacement));
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  return true;
}

let changed = 0;
for (const dist of packageRoots) {
  const monitorFiles = globSync(`${dist}/monitor-*.js`);
  const channelFiles = globSync(`${dist}/channel-*.js`);
  if (monitorFiles.length !== 1) {
    throw new Error(`${dist}: expected one monitor runtime, found ${monitorFiles.length}`);
  }
  const channelFile = channelFiles.find((file) => readFileSync(file, "utf8").includes("const whatsappPlugin = createChatChannelPlugin"));
  if (!channelFile) throw new Error(`${dist}: WhatsApp channel runtime not found`);

  const pairingLines = JSON.stringify([
    messages.pairingIntro,
    "",
    messages.pairingStatus,
  ]);
  const pairingContact = JSON.stringify(contactPayload);
  const pairingBuilder = [
    "\t\t\t\t// thenairn-whatsapp-admission: friendly quarantined-sender reply",
    `\t\t\t\tbuildReplyText: () => ${pairingLines}.join(\"\\n\"),`,
  ].join("\n");
  changed += Number(migrateLegacyPairingReply(monitorFiles[0], pairingBuilder));
  changed += Number(replaceOnce(
    monitorFiles[0],
    "thenairn-whatsapp-admission: friendly quarantined-sender reply",
    /(\n\t\t\t\tmeta: \{ name: \(params\.pushName \?\? ""\)\.trim\(\) \|\| void 0 \},\n)(\t\t\t\tonCreated:)/,
    `$1${pairingBuilder}\n$2`,
  ));
  const source = readFileSync(monitorFiles[0], "utf8");
  const duplicateContactPattern = /(\t\t\t\t\/\/ thenairn-whatsapp-admission: first-contact card\n)\t\t\t\tonCreated: async \(\) => \{ await params\.sock\.sendMessage\(params\.remoteJid, [^\n]+\); \},\n\t\t\t\tonCreated: \(\) => \{\n/;
  if (duplicateContactPattern.test(source)) {
    const repaired = source.replace(
      duplicateContactPattern,
      `$1\t\t\t\tonCreated: async () => {\n\t\t\t\t\tawait params.sock.sendMessage(params.remoteJid, ${pairingContact});\n`,
    );
    writeFileSync(monitorFiles[0], repaired);
    execFileSync(process.execPath, ["--check", monitorFiles[0]], { stdio: "inherit" });
    changed += 1;
  }
  changed += Number(replaceOnce(
    monitorFiles[0],
    "thenairn-whatsapp-admission: first-contact card",
    /(\t\t\t\tonCreated: )\(\) => \{\n/,
    `$1async () => {\n\t\t\t\t\tawait params.sock.sendMessage(params.remoteJid, ${pairingContact});\n`,
  ));

  const approvedText = JSON.stringify(messages.approved);
  changed += Number(replaceOnce(
    channelFile,
    "thenairn-whatsapp-admission: approval confirmation",
    /(\tpairing: \{\n\t\tidLabel: "whatsappSenderId",\n\t\tnormalizeAllowEntry: \(entry\) => normalizeWhatsAppAllowFromEntry\(entry\) \?\? "")\n\t\},/,
    `$1,\n\t\t// thenairn-whatsapp-admission: approval confirmation\n\t\tnotifyApproval: async ({ id, cfg, accountId }) => {\n\t\t\tawait whatsappChannelOutbound.sendText({ cfg, to: id, text: ${approvedText}, accountId });\n\t\t}\n\t},`,
  ));
}

console.log(`whatsapp-admission patches ready (${changed} file${changed === 1 ? "" : "s"} changed)`);
