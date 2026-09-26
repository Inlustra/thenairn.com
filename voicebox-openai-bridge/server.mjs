import http from "node:http";

const port = Number(process.env.PORT || 8880);
const voiceboxUrl = (process.env.VOICEBOX_URL || "http://voicebox:17493").replace(/\/$/, "");
const profileName = process.env.VOICEBOX_PROFILE || "OpenClaw Ryan";
const speaker = process.env.VOICEBOX_SPEAKER || "Ryan";
const modelSize = process.env.VOICEBOX_MODEL_SIZE || "1.7B";
const defaultInstruct = process.env.VOICEBOX_INSTRUCT ||
  "Speak naturally and conversationally, with warm, emotionally appropriate delivery.";
let profilePromise;

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${voiceboxUrl}${path}`, options);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function resolveProfile() {
  if (!profilePromise) {
    profilePromise = (async () => {
      const profiles = await jsonFetch("/profiles");
      const existing = profiles.find((profile) => profile.name === profileName);
      if (existing) return existing;
      return jsonFetch("/profiles", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          name: profileName,
          description: "Preset Qwen CustomVoice profile for OpenClaw Talk Mode",
          language: "en",
          voice_type: "preset",
          preset_engine: "qwen_custom_voice",
          preset_voice_id: speaker,
          default_engine: "qwen_custom_voice"
        })
      });
    })().catch((error) => {
      profilePromise = undefined;
      throw error;
    });
  }
  return profilePromise;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 100_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {"content-type": "application/json", "content-length": data.length});
  response.end(data);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const health = await jsonFetch("/health");
      return sendJson(response, 200, {status: "ok", upstream: health.status || "ok"});
    }
    if (request.method !== "POST" || request.url !== "/v1/audio/speech") {
      return sendJson(response, 404, {error: "not found"});
    }

    const body = await readJson(request);
    if (typeof body.input !== "string" || !body.input.trim()) {
      return sendJson(response, 400, {error: "input must be non-empty text"});
    }
    if (body.input.length > 50_000) return sendJson(response, 413, {error: "input too long"});

    const profile = await resolveProfile();
    const requestedStyle = [body.instruct, body.instructions, body.style]
      .find((value) => typeof value === "string" && value.trim());
    const upstream = await fetch(`${voiceboxUrl}/generate/stream`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        profile_id: profile.id,
        text: body.input,
        language: "en",
        engine: "qwen_custom_voice",
        model_size: modelSize,
        instruct: requestedStyle || defaultInstruct,
        normalize: true
      })
    });
    if (!upstream.ok) {
      return sendJson(response, 503, {error: await upstream.text()});
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": audio.length,
      "cache-control": "no-store"
    });
    response.end(audio);
  } catch (error) {
    console.error(error);
    sendJson(response, 503, {error: String(error?.message || error)});
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Voicebox OpenAI bridge listening on ${port}`);
});
