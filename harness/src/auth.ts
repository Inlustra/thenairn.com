// The harness's credentials, in <state>/credentials.json (mode 600).
//
// ChatGPT: the harness owns the one refresh token. Codex never writes an
// auth.json; it runs with cli_auth_credentials_store="ephemeral", is handed
// the access token at startup, and asks us (account/chatgptAuthTokens/refresh)
// when it needs a new one. One owner means no refresh-token rotation races
// between processes. This is the same arrangement OpenClaw uses.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { log } from "./log";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex's public OAuth client

type ChatGPT = { accessToken: string; refreshToken: string; accountId: string; planType: string | null; expiresAt?: number; email?: string };
type File = { chatgpt?: ChatGPT; telegramBotToken?: string };

export class Credentials {
  private data: File;
  private refreshing: Promise<ChatGPT> | null = null;

  constructor(private path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  get telegramBotToken() {
    return this.data.telegramBotToken ?? "";
  }

  get chatgpt(): ChatGPT {
    if (!this.data.chatgpt) throw new Error(`no ChatGPT login in ${this.path}`);
    return this.data.chatgpt;
  }

  private save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // Access token, refreshed first if it's within a day of expiring.
  async fresh(): Promise<ChatGPT> {
    const c = this.chatgpt;
    if (c.expiresAt && c.expiresAt - Date.now() < 24 * 3_600_000) return this.refresh("expiring");
    return c;
  }

  // One refresh at a time: a rotated refresh token is single-use, so two
  // concurrent refreshes would log the harness out.
  refresh(reason: string): Promise<ChatGPT> {
    this.refreshing ??= this.doRefresh(reason).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(reason: string): Promise<ChatGPT> {
    const c = this.chatgpt;
    log.info({ reason }, "refreshing ChatGPT token");
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const code = j?.error?.code ?? j?.error ?? r.status;
      log.error({ code }, "ChatGPT token refresh failed; the harness needs a new login");
      throw new Error(`token refresh failed: ${code}`);
    }
    this.data.chatgpt = {
      ...c,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? c.refreshToken,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : jwtExpiry(j.access_token),
    };
    this.save();
    return this.data.chatgpt;
  }
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
