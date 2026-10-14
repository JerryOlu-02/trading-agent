import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Settings = {
  openRouterApiKey: string;
  openRouterModel: string;
  hasModelKey: boolean;
  rpcUrl: string;
  walletSecret: string;
  dryRun: boolean;
  maxSolPerTrade: number;
  maxOpenPositions: number;
  dailyLossLimitSol: number;
  port: number;
  host: string;
  allowedOrigins: string[];
};

function loadFiles() {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const files = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(here, "../.env"),
    path.resolve(here, "../../.env"),
  ];

  for (const file of files) {
    if (existsSync(file)) loadEnv({ path: file });
  }
}

function requiredNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") return fallback;

  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

export function loadSettings(): Settings {
  loadFiles();
  const openRouterApiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();

  const hasModelKey =
    openRouterApiKey.startsWith("sk-or-") &&
    openRouterApiKey.length > 20 &&
    !openRouterApiKey.includes("...");

  return {
    openRouterApiKey,
    openRouterModel:
      (process.env.OPENROUTER_MODEL ?? "").trim() ||
      "anthropic/claude-sonnet-4.5",
    hasModelKey,
    rpcUrl:
      (process.env.SOLANA_RPC_URL ?? "").trim() ||
      "https://api.mainnet-beta.solana.com",
    walletSecret: (process.env.AGENT_WALLET_SECRET ?? "").trim(),
    dryRun: flag("DRY_RUN", true),
    maxSolPerTrade: requiredNumber("MAX_SOL_PER_TRADE", 0.05),
    maxOpenPositions: Math.floor(requiredNumber("MAX_OPEN_POSITIONS", 3)),
    dailyLossLimitSol: requiredNumber("DAILY_LOSS_LIMIT_SOL", 0.3),
    port: Math.floor(requiredNumber("AGENT_PORT", 8787)),
    host: (process.env.AGENT_HOST ?? "").trim() || "127.0.0.1",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  };
}
