// web_fetch for Milo. Guests can make Milo fetch any URL they type, so this
// refuses anything that isn't the public internet: the harness sits on the
// Docker network next to Sonarr, Home Assistant and the rest, and a naive
// fetch would hand a guest all of them.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 2_000_000;
const MAX_TEXT = 12_000;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  );
}

// Resolve once, check, and return the address to connect to. The fetch then
// goes to that exact IP, so a DNS answer that changes between the check and
// the connection (rebinding) can't point it at the LAN.
async function publicAddress(url: URL): Promise<string> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s)");
  if (url.username || url.password) throw new Error("no credentials in URLs");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !isIP(host)) throw new Error("not a public host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("not a public address");
  return addrs[0]!.address;
}

async function toText(html: string): Promise<string> {
  let title = "";
  const parts: string[] = [];
  let skip = 0;
  const rw = new HTMLRewriter()
    .on("head, script, style, noscript, svg, nav, footer, header, form", {
      element(el) {
        skip++;
        el.onEndTag(() => void skip--);
      },
    })
    .on("title", { text(t) { title += t.text; } })
    .on("*", {
      text(t) {
        if (!skip && t.text.trim()) parts.push(t.text);
      },
    });
  await rw.transform(new Response(html)).text();
  const body = parts.join(" ").replace(/\s+/g, " ").trim();
  return (title.trim() ? `${title.trim()}\n\n` : "") + body;
}

export async function webFetch(raw: string): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    const ip = await publicAddress(url);
    const pinned = new URL(url);
    pinned.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    const r = await fetch(pinned, {
      redirect: "manual",
      headers: { Host: url.host, "User-Agent": "Mozilla/5.0 (compatible; Milo/1.0)", Accept: "text/html,text/plain,*/*;q=0.5" },
      tls: { serverName: url.hostname },
      signal: AbortSignal.timeout(20_000),
    } as RequestInit);
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      url = new URL(r.headers.get("location")!, url);
      continue;
    }
    if (!r.ok) return `The page returned HTTP ${r.status}.`;
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return "The page is too large to read.";
    const type = r.headers.get("content-type") ?? "";
    const body = (await r.text()).slice(0, MAX_BYTES);
    const text = type.includes("html") ? await toText(body) : body;
    return text.slice(0, MAX_TEXT) + (text.length > MAX_TEXT ? "\n[truncated]" : "");
  }
  return "Too many redirects.";
}
