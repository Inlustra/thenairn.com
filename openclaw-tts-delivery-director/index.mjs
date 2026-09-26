import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildDirectorPrompt,
  extractRecentTurns,
  normalizeCorrelationText,
  parseDirectorResult,
  SessionDeliveryStore,
  withTimeout,
} from "./director.mjs";

const PROVIDER_ID = "voicebox-directed";
const DEFAULT_BASE_URL = "http://voicebox-openai-bridge:8880/v1";
const DEFAULT_STATIC = "Speak naturally and conversationally, with warm, emotionally appropriate delivery.";

function readString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readInt(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalizeConfig(raw = {}) {
  return {
    baseUrl: readString(raw.baseUrl, DEFAULT_BASE_URL).replace(/\/$/u, ""),
    model: readString(raw.model, "qwen-custom-voice"),
    speakerVoice: readString(raw.speakerVoice ?? raw.voice, "Ryan"),
    responseFormat: readString(raw.responseFormat, "wav"),
    instructions: readString(raw.instructions, DEFAULT_STATIC),
  };
}

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function userTextFromMessageEvent(event) {
  for (const value of [event?.content, event?.text, event?.body, event?.bodyForAgent]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

async function postSpeech({ baseUrl, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Voicebox bridge returned ${response.status}: ${detail}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export default definePluginEntry({
  id: "tts-delivery-director",
  name: "TTS Delivery Director",
  description: "Per-session context-aware Qwen CustomVoice delivery direction",
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const directorModel = readString(pluginConfig.model, "openai/gpt-5.6-luna");
    const directorTimeoutMs = readInt(pluginConfig.directorTimeoutMs, 3000, 250, 10000);
    const staticInstruction = readString(pluginConfig.staticInstruction, DEFAULT_STATIC);
    const store = new SessionDeliveryStore({
      maxSessions: readInt(pluginConfig.maxSessions, 128, 1, 512),
      ttlMs: readInt(pluginConfig.sessionTtlMs, 1_800_000, 60_000, 86_400_000),
      recentTurns: readInt(pluginConfig.recentTurns, 6, 1, 8),
      maxTurnChars: readInt(pluginConfig.maxTurnChars, 280, 80, 500),
    });

    api.on("before_prompt_build", (event, ctx) => {
      if (ctx?.sessionKey) store.captureMessages(ctx.sessionKey, event?.messages);
    }, { registrationId: "capture-recent-context" });

    api.on("message_received", (event, ctx) => {
      if (ctx?.sessionKey) store.captureTurn(ctx.sessionKey, "user", userTextFromMessageEvent(event));
    }, { registrationId: "capture-inbound-turn" });

    api.on("before_message_write", (event, ctx) => {
      const text = assistantText(event?.message);
      if (ctx?.sessionKey && text) {
        store.captureTurn(ctx.sessionKey, "assistant", text);
        store.correlate(ctx.sessionKey, text);
      }
    }, { registrationId: "correlate-assistant-transcript" });

    api.on("before_tool_call", (event, ctx) => {
      const text = event?.params?.text;
      if (ctx?.sessionKey && typeof text === "string") store.correlate(ctx.sessionKey, text);
    }, { matcher: ["tts"], registrationId: "correlate-tts-tool" });

    api.registerSpeechProvider({
      id: PROVIDER_ID,
      label: "Voicebox (context-directed)",
      defaultModel: "qwen-custom-voice",
      models: ["qwen-custom-voice"],
      voices: ["Ryan"],
      defaultTimeoutMs: 120_000,
      resolveConfig: ({ rawConfig }) => normalizeConfig(rawConfig),
      resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => normalizeConfig({
        ...baseTtsConfig,
        ...talkProviderConfig,
        speakerVoice: talkProviderConfig?.speakerVoice ?? talkProviderConfig?.voiceId ?? baseTtsConfig?.speakerVoice,
        model: talkProviderConfig?.model ?? talkProviderConfig?.modelId ?? baseTtsConfig?.model,
      }),
      resolveTalkOverrides: ({ params }) => ({
        ...(params?.voiceId ? { voice: params.voiceId } : {}),
        ...(params?.modelId ? { model: params.modelId } : {}),
      }),
      listVoices: async () => [{ id: "Ryan", name: "Ryan" }],
      isConfigured: () => true,
      prepareSynthesis: async (ctx) => {
        const providerConfig = normalizeConfig(ctx.providerConfig);
        const correlated = store.resolve(ctx.text);
        if (!correlated?.entry) {
          return { text: ctx.text, providerConfig: { instructions: staticInstruction } };
        }
        const { entry } = correlated;
        try {
          const result = await withTimeout(
            (signal) => api.runtime.llm.complete({
              messages: [{
                role: "user",
                content: buildDirectorPrompt({
                  state: entry.state,
                  recent: entry.recent,
                  responseText: ctx.text,
                }),
              }],
              systemPrompt: "You are a speech delivery director. Return strict JSON only. Never alter or generate transcript wording.",
              model: directorModel,
              reasoning: "off",
              maxTokens: 160,
              temperature: 0.1,
              signal,
              purpose: "tts-delivery-director",
              execution: { mode: "isolated-agent-runtime", timeoutMs: directorTimeoutMs },
            }),
            directorTimeoutMs,
          );
          const parsed = parseDirectorResult(result.text, entry.state);
          if (!parsed) throw new Error("director returned invalid bounded JSON");
          entry.state = parsed.state;
          return { text: ctx.text, providerConfig: { instructions: parsed.instruct } };
        } catch (error) {
          api.logger.warn(`delivery director fallback: ${String(error?.message ?? error).split("\n", 1)[0]}`);
          return { text: ctx.text, providerConfig: { instructions: providerConfig.instructions || staticInstruction } };
        }
      },
      synthesize: async (req) => {
        const config = normalizeConfig(req.providerConfig);
        const audioBuffer = await postSpeech({
          baseUrl: config.baseUrl,
          timeoutMs: req.timeoutMs,
          body: {
            input: req.text,
            model: req.providerOverrides?.model ?? config.model,
            voice: req.providerOverrides?.voice ?? config.speakerVoice,
            response_format: config.responseFormat,
            instructions: config.instructions,
          },
        });
        return {
          audioBuffer,
          outputFormat: "wav",
          fileExtension: ".wav",
          voiceCompatible: false,
        };
      },
    });
  },
});
