import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";
import type { Model, KnownProvider } from "@mariozechner/pi-ai";
import { log } from "./ui.js";

interface ParsedModel {
  provider: string;
  modelId: string;
}

export function parseModelString(modelStr: string): ParsedModel {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(
      `Invalid model string "${modelStr}". Expected format: provider/model-id (e.g. ollama/gpt-oss:20b)`
    );
  }
  return {
    provider: modelStr.slice(0, slashIdx),
    modelId: modelStr.slice(slashIdx + 1),
  };
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";

const CUSTOM_BASE_URLS: Record<string, string> = {
  ollama: OLLAMA_BASE_URL,
  lmstudio: LMSTUDIO_BASE_URL,
  vllm: "http://localhost:8000/v1",
};

const API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function resolveModel(modelStr: string): { model: Model<any>; apiKey?: string } {
  const { provider, modelId } = parseModelString(modelStr);

  // Try built-in registry first
  const knownProviders = getProviders();
  if (knownProviders.includes(provider as KnownProvider)) {
    try {
      const model = getModel(provider as any, modelId as any);
      const apiKey = getApiKey(provider);
      log("setup", `Using built-in model: ${provider}/${modelId}`);
      return { model, apiKey };
    } catch {
      // Fall through to custom model
    }
  }

  // Build custom model by cloning a known model and overriding fields.
  if (!(provider in CUSTOM_BASE_URLS)) {
    const known = [...knownProviders, ...Object.keys(CUSTOM_BASE_URLS)].join(", ");
    throw new Error(
      `Unknown provider "${provider}". Known providers: ${known}\n` +
      `Use the format: provider/model-id (e.g. ollama/qwen3:8b, anthropic/claude-sonnet-4-20250514)`
    );
  }
  const baseUrl = CUSTOM_BASE_URLS[provider];
  // Local providers (ollama, lmstudio, vllm) don't need real API keys,
  // but pi-ai requires one — use a dummy value.
  const apiKey = "local";

  log("setup", `Using custom model: ${provider}/${modelId} at ${baseUrl}`);

  // Clone from a groq model — they use "openai-completions" API which is the
  // standard /v1/chat/completions endpoint that Ollama and other local servers support.
  // (The "openai" provider uses "openai-responses" which only works with OpenAI's API.)
  const groqModels = getModels("groq");
  if (groqModels.length === 0) {
    throw new Error("No built-in groq models found — cannot create custom model");
  }
  const base = groqModels[0];
  const model: Model<any> = {
    ...base,
    id: modelId,
    name: modelId,
    provider: provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };

  return { model, apiKey };
}

function getApiKey(provider: string): string | undefined {
  const envVar = API_KEY_ENV[provider];
  if (envVar) return process.env[envVar];
  // Generic fallback
  const genericKey = process.env[`${provider.toUpperCase()}_API_KEY`];
  return genericKey || undefined;
}
