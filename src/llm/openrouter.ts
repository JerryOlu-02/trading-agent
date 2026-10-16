import type { Settings } from "../config.js";
import type { NewToken, StrategySettings } from "../types.js";
import { SYSTEM_PROMPT } from "./prompts.js";

export type ModelDecision = {
  action: "buy" | "pass";
  confidence: number;
  thesis: string;
  sizeSol: number;
  takeProfitMultiple: number;
  stopLossMultiple: number;
  maxHoldMinutes: number;
};

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model reply had no JSON object");
  }
  return JSON.parse(body.slice(start, end + 1));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function complete(
  settings: Settings,
  user: string,
  jsonMode: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.openRouterModel,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1",
      "X-Title": "Pit",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });

  if (response.status === 400 && jsonMode)
    return complete(settings, user, false);
  if (!response.ok) {
    const body = await response.text();

    const limit =
      response.status === 403 && body.includes("Key limit exceeded");

    throw new Error(
      limit
        ? "OpenRouter key is over its limit."
        : `OpenRouter ${response.status}.`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = contentText(payload.choices?.[0]?.message?.content);
  if (!text.trim()) throw new Error("OpenRouter returned an empty reply");
  return text;
}

export async function decide(
  settings: Settings,
  token: NewToken,
  strategy: StrategySettings,
  maxSizeSol: number,
): Promise<ModelDecision> {
  const fallback: ModelDecision = {
    action: "pass",
    confidence: 0,
    thesis: "The model did not answer. Passed.",
    sizeSol: Math.min(strategy.buySizeSol, maxSizeSol),
    takeProfitMultiple: strategy.takeProfitMultiple,
    stopLossMultiple: strategy.stopLossMultiple,
    maxHoldMinutes: strategy.maxHoldMinutes,
  };

  try {
    const text = await complete(
      settings,
      JSON.stringify({
        name: token.name,
        symbol: token.symbol,
        mint: token.mint,
        creator: token.creator,
        creatorBuySol: token.initialBuySol,
        marketCapSol: round(token.marketCapSol),
        maxSizeSol,
        defaults: {
          takeProfitMultiple: strategy.takeProfitMultiple,
          stopLossMultiple: strategy.stopLossMultiple,
          maxHoldMinutes: strategy.maxHoldMinutes,
        },
      }),
      true,
    );
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") return fallback;
    const row = parsed as Record<string, unknown>;
    const action = row.action === "buy" ? "buy" : "pass";
    const confidence = typeof row.confidence === "number" ? row.confidence : 0;
    const thesis =
      typeof row.thesis === "string" && row.thesis.trim()
        ? row.thesis.trim().slice(0, 280)
        : "No thesis. Passed.";
    const sizeSol = clamp(
      typeof row.sizeSol === "number" ? row.sizeSol : strategy.buySizeSol,
      0.0001,
      maxSizeSol,
      Math.min(strategy.buySizeSol, maxSizeSol),
    );
    return {
      action:
        action === "buy" && confidence < strategy.minConfidence
          ? "pass"
          : action,
      confidence: clamp(confidence, 0, 1, 0),
      thesis,
      sizeSol,
      takeProfitMultiple: clamp(
        typeof row.takeProfitMultiple === "number"
          ? row.takeProfitMultiple
          : strategy.takeProfitMultiple,
        1.2,
        4,
        strategy.takeProfitMultiple,
      ),
      stopLossMultiple: clamp(
        typeof row.stopLossMultiple === "number"
          ? row.stopLossMultiple
          : strategy.stopLossMultiple,
        0.4,
        0.9,
        strategy.stopLossMultiple,
      ),
      maxHoldMinutes: clamp(
        typeof row.maxHoldMinutes === "number"
          ? row.maxHoldMinutes
          : strategy.maxHoldMinutes,
        2,
        45,
        strategy.maxHoldMinutes,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Model call failed";
    return { ...fallback, thesis: `Passed. ${message}` };
  }
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
