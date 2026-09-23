/**
 * OpenAI chat client (#108 AI surfaces) — JVM-free replacement for Spring AI's
 * ChatClient. A plain `fetch` against the OpenAI Chat Completions REST API (no new
 * dependency, Cloudflare/Node-native): a primary model, then a fallback model, with fixed
 * options (no reasoning, temperature 0.3, at most 1000 completion tokens).
 *
 * `createChat` returns a `ChatFn` that throws on any failure (missing key, non-2xx,
 * empty content) AND after both models are exhausted — exactly the signal the AI
 * surfaces use to fall back to their deterministic, never-decides-compliance text.
 * A reply names the model that gave it, so the audit ledger records which one answered.
 */

/** A model's answer, and which model gave it: the primary, or the fallback after the primary failed. */
export interface ChatReply {
  text: string;
  model: string;
}

/** A single system+user turn → the answer. Throws on failure (→ deterministic fallback). */
export type ChatFn = (systemPrompt: string, userPrompt: string) => Promise<ChatReply>;

export interface ChatConfig {
  /** OpenAI API key; when unset every call throws → callers use their fallback. */
  apiKey?: string;
  /** Primary model (default in `routes/ai.ts`). */
  model: string;
  /** Fallback model tried on primary failure. It must accept the same options as the primary. */
  fallbackModel: string;
  /** API base; override in tests. */
  baseUrl?: string;
  /** Injected fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

async function callModel(cfg: ChatConfig, model: string, system: string, user: string): Promise<ChatReply> {
  if (!cfg.apiKey || !cfg.apiKey.trim()) {
    throw new Error("OpenAI API key is not configured.");
  }
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${cfg.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      // GPT-5-era models reject `max_tokens`, and reject `temperature` unless reasoning is off. These
      // surfaces are short, templated text, so reasoning stays off: fast, cheap, and the whole token
      // budget goes to the answer.
      reasoning_effort: "none",
      temperature: 0.3,
      max_completion_tokens: 1000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI chat call failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI chat call returned empty content.");
  }
  return { text: content, model };
}

/** Build a ChatFn that tries the primary model, then the fallback model (if distinct). */
export function createChat(cfg: ChatConfig): ChatFn {
  return async (system: string, user: string): Promise<ChatReply> => {
    try {
      return await callModel(cfg, cfg.model, system, user);
    } catch (primaryError) {
      const fb = cfg.fallbackModel?.trim();
      if (!fb || fb.toLowerCase() === cfg.model.toLowerCase()) {
        throw new Error(
          `Primary model call failed and no fallback configured: ${(primaryError as Error).message}`,
        );
      }
      return callModel(cfg, fb, system, user);
    }
  };
}
