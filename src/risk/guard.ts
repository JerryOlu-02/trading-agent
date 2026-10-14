import type { Mode, RiskLimits } from "../types.js";

export type BuyContext = {
  sizeSol: number;
  openCount: number;
  dayPnlSol: number;
  mode: Mode;
  hasWallet: boolean;
  halted: boolean;
  limits: RiskLimits;
};

export function reviewBuy(ctx: BuyContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.halted) return { ok: false, reason: "Buys are halted." };
  if (ctx.mode === "live" && !ctx.hasWallet) {
    return { ok: false, reason: "Live mode has no wallet loaded." };
  }
  if (!(ctx.sizeSol > 0)) return { ok: false, reason: "Buy size is empty." };
  if (ctx.sizeSol > ctx.limits.maxSolPerTrade + 1e-12) {
    return {
      ok: false,
      reason: `Buy of ${ctx.sizeSol} SOL is above the ${ctx.limits.maxSolPerTrade} SOL cap.`,
    };
  }
  if (ctx.openCount >= ctx.limits.maxOpenPositions) {
    return {
      ok: false,
      reason: `Already holding ${ctx.openCount} of ${ctx.limits.maxOpenPositions} tickets.`,
    };
  }
  if (ctx.dayPnlSol <= -ctx.limits.dailyLossLimitSol) {
    return { ok: false, reason: "Today's loss limit is used up. New buys stay off." };
  }
  return { ok: true };
}
