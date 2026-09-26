// Everything environment-specific lives here. Paths default to where Tower
// keeps them; override by env var when running tests or somewhere else.
import { join } from "node:path";

const env = (k: string, d: string) => process.env[k] ?? d;
// Private identifiers (phone numbers, chat IDs) come from the environment only:
// this repo is public. In the stack they're in .env / the thenairn-env item.
const required = (k: string) => {
  const v = process.env[k]?.replace(/\D/g, "");
  if (!v) throw new Error(`${k} must be set (digits only, country code first)`);
  return v;
};
const HARNESS = import.meta.dir + "/..";

export const config = {
  state: env("HARNESS_STATE", "/mnt/user/Config/harness"),
  codexBin: env(
    "CODEX_BIN",
    join(HARNESS, "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"),
  ),
  prompts: join(HARNESS, "prompts"),

  // WhatsApp numbers, digits only. The owner can message Milo like anyone
  // else and is the only person who can approve new contacts.
  ownerNumber: required("OWNER_NUMBER"),

  milo: {
    model: env("MILO_MODEL", "gpt-5.6-terra"),
    cwd: env("MILO_CWD", "/var/empty/milo"),
  },
  // Model for memory extraction (small, fast; runs on the same subscription).
  memoryModel: env("MEMORY_MODEL", "gpt-5.6-terra"),
  media: {
    model: env("MEDIA_MODEL", "gpt-6-astra"),
    cwd: env("MEDIA_CWD", "/mnt/user/HQ/media"),
  },
  thor: {
    model: env("THOR_MODEL", "gpt-6-astra"),
    cwd: env("THOR_CWD", "/mnt/user/HQ"),
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "", // else credentials.json
    // Off until cutover: two pollers on one bot token fight (Telegram 409).
    enabled: env("TELEGRAM", "off") === "on",
    ownerChatId: process.env.TELEGRAM_OWNER_ID ?? "",
  },

  // "live" sends on WhatsApp; "shadow" receives and logs but never sends, so
  // the harness can run alongside OpenClaw on the same account; "off" skips it.
  whatsapp: env("WHATSAPP_MODE", "off") as "live" | "shadow" | "off",
  testPort: Number(env("TEST_PORT", "0")), // 0 = no local test channel
  consolePort: Number(env("CONSOLE_PORT", "7812")), // 0 = no console

  memory: env("MEMORY", "on") === "on",
  jobPollMs: Number(env("JOB_POLL_MS", String(2 * 60_000))),
};

export const paths = {
  db: join(config.state, "harness.sqlite"),
  waAuth: join(config.state, "whatsapp-auth"),
  codexHome: join(config.state, "codex"),
  credentials: join(config.state, "credentials.json"),
};
