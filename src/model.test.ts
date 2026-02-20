import { describe, test, expect } from "bun:test";
import { resolveModel, parseModelString } from "./model.js";

describe("parseModelString", () => {
  test("parses provider/model format", () => {
    const result = parseModelString("anthropic/claude-sonnet-4.6");
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4.6");
  });

  test("throws on missing slash", () => {
    expect(() => parseModelString("no-slash")).toThrow("Invalid model string");
  });
});

describe("resolveModel", () => {
  test("resolves a model ID known to pi-ai (anthropic/claude-sonnet-4-0)", () => {
    const { model } = resolveModel("anthropic/claude-sonnet-4-0");
    expect(model).toBeDefined();
    expect(model.contextWindow).toBeGreaterThan(0);
  });

  test("resolves an unknown model ID for a known provider (anthropic/claude-sonnet-4.6)", () => {
    // This is the exact bug: claude-sonnet-4.6 is not in the pi-ai registry,
    // but anthropic is a known provider. The model should still be usable
    // with a valid contextWindow instead of being undefined.
    const { model } = resolveModel("anthropic/claude-sonnet-4.6");
    expect(model).toBeDefined();
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.id).toBe("claude-sonnet-4.6");
    expect(model.provider).toBe("anthropic");
  });

  test("resolves anthropic/claude-sonnet-4 (alias not in pi-ai registry)", () => {
    // claude-sonnet-4 is NOT under the anthropic provider in pi-ai,
    // only claude-sonnet-4-0 and claude-sonnet-4-20250514 are.
    const { model } = resolveModel("anthropic/claude-sonnet-4");
    expect(model).toBeDefined();
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.id).toBe("claude-sonnet-4");
  });

  test("resolves an unknown model ID for openai provider", () => {
    const { model } = resolveModel("openai/gpt-5-turbo");
    expect(model).toBeDefined();
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.id).toBe("gpt-5-turbo");
  });

  test("returned model has all required fields", () => {
    const { model } = resolveModel("anthropic/claude-sonnet-4.6");
    expect(model.id).toBe("claude-sonnet-4.6");
    expect(model.provider).toBe("anthropic");
    expect(typeof model.contextWindow).toBe("number");
    expect(typeof model.maxTokens).toBe("number");
    expect(model.api).toBeDefined();
  });

  test("throws on completely unknown provider", () => {
    expect(() => resolveModel("fakeprovider/some-model")).toThrow("Unknown provider");
  });
});
