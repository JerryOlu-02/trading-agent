import type { NewToken, StrategySettings } from "../types.js";

const PAYMENT_TICKERS = new Set(["SOL", "USDC", "USDT", "BTC", "ETH"]);

export function screen(
  token: NewToken,
  strategy: StrategySettings,
): { ok: true } | { ok: false; reason: string } {
  if (!token.name || !token.symbol) {
    return { ok: false, reason: "The mint arrived without a name." };
  }
  if (token.symbol.length < 2 || token.symbol.length > 12) {
    return { ok: false, reason: "Ticker length is outside 2–12 characters." };
  }
  if (PAYMENT_TICKERS.has(token.symbol.toUpperCase())) {
    return { ok: false, reason: "Ticker impersonates a payment asset." };
  }
  if (/https?:|www\.|\.com\b/i.test(`${token.name} ${token.symbol}`)) {
    return { ok: false, reason: "Name looks like a link." };
  }
  if (token.pool && token.pool !== "pump") {
    return { ok: false, reason: "Already off the bonding curve." };
  }
  if (!(token.vTokens > 0) || !(token.vSol > 0)) {
    return { ok: false, reason: "Bonding curve reserves were unreadable." };
  }
  if (token.marketCapSol < strategy.minMarketCapSol) {
    return {
      ok: false,
      reason: `Market cap ${token.marketCapSol.toFixed(1)} SOL is under the floor.`,
    };
  }
  if (token.marketCapSol > strategy.maxMarketCapSol) {
    return {
      ok: false,
      reason: `Market cap ${token.marketCapSol.toFixed(1)} SOL is past the ceiling.`,
    };
  }
  if (token.initialBuySol < strategy.minInitialBuySol) {
    return { ok: false, reason: "Creator buy is below the minimum." };
  }
  if (token.initialBuySol > strategy.maxInitialBuySol) {
    return {
      ok: false,
      reason: "Creator buy is large enough to dump the curve.",
    };
  }
  return { ok: true };
}
