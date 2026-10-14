import { Connection, PublicKey } from "@solana/web3.js";
import type { Mark } from "../types.js";

const TOKEN_DECIMALS = 1e6;
const SOL_DECIMALS = 1e9;

export type CurveQuote = {
  tokens: number;
  sol: number;
  price: number;
  vSol: number;
  vTokens: number;
};

export function decodeCurve(data: Uint8Array): { vSol: number; vTokens: number; complete: boolean } | null {
  if (data.length < 49) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vTokens = Number(view.getBigUint64(8, true)) / TOKEN_DECIMALS;
  const vSol = Number(view.getBigUint64(16, true)) / SOL_DECIMALS;
  if (!(vTokens > 0) || !(vSol > 0)) return null;
  return { vSol, vTokens, complete: data[48] === 1 };
}

export function quoteBuy(vSol: number, vTokens: number, solIn: number): CurveQuote | null {
  if (!(vSol > 0) || !(vTokens > 0) || !(solIn > 0)) return null;
  const solToCurve = solIn * 0.99;
  const k = vSol * vTokens;
  const nextSol = vSol + solToCurve;
  const nextTokens = k / nextSol;
  const tokens = vTokens - nextTokens;
  if (!(tokens > 0) || !Number.isFinite(tokens)) return null;
  return { tokens, sol: solIn, price: nextSol / nextTokens, vSol: nextSol, vTokens: nextTokens };
}

export function quoteSell(vSol: number, vTokens: number, tokensIn: number): CurveQuote | null {
  if (!(vSol > 0) || !(vTokens > 0) || !(tokensIn > 0)) return null;
  const k = vSol * vTokens;
  const nextTokens = vTokens + tokensIn;
  const nextSol = k / nextTokens;
  const sol = (vSol - nextSol) * 0.99;
  if (!(sol > 0) || !Number.isFinite(sol)) return null;
  return { tokens: tokensIn, sol, price: nextSol / nextTokens, vSol: nextSol, vTokens: nextTokens };
}

export class PriceBook {
  solUsd: number | null = null;
  private marks = new Map<string, Mark>();
  private usdTimer: NodeJS.Timeout | null = null;
  private lastRpcWarn = 0;

  constructor(
    private readonly connection: Connection,
    private readonly warn: (message: string) => void,
  ) {}

  start() {
    void this.pollUsd();
    this.usdTimer = setInterval(() => void this.pollUsd(), 60_000);
  }

  stop() {
    if (this.usdTimer) clearInterval(this.usdTimer);
  }

  seed(mint: string, mark: Mark) {
    this.marks.set(mint, mark);
  }

  mark(mint: string): Mark | null {
    return this.marks.get(mint) ?? null;
  }

  async refresh(curves: Array<{ mint: string; bondingCurve: string }>) {
    const usable = curves.filter((curve) => curve.bondingCurve);
    if (usable.length === 0) return;
    let keys: PublicKey[];
    try {
      keys = usable.map((curve) => new PublicKey(curve.bondingCurve));
    } catch (error) {
      this.warnRpc(error);
      return;
    }
    try {
      const accounts = await this.connection.getMultipleAccountsInfo(keys, "confirmed");
      const now = Date.now();
      accounts.forEach((account, index) => {
        const curve = usable[index];
        if (!curve || !account) return;
        const decoded = decodeCurve(account.data);
        if (!decoded) return;
        this.marks.set(curve.mint, {
          price: decoded.vSol / decoded.vTokens,
          complete: decoded.complete,
          at: now,
          vSol: decoded.vSol,
          vTokens: decoded.vTokens,
        });
      });
    } catch (error) {
      this.warnRpc(error);
    }
  }

  private warnRpc(error: unknown) {
    const now = Date.now();
    if (now - this.lastRpcWarn < 60_000) return;
    this.lastRpcWarn = now;
    const message = error instanceof Error ? error.message : "RPC read failed";
    this.warn(`Bonding curve read failed. ${message}`);
  }

  private async pollUsd() {
    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { solana?: { usd?: number } };
      const price = payload.solana?.usd;
      if (typeof price === "number" && price > 0) this.solUsd = price;
    } catch {
      // USD is display-only. A miss leaves the last price in place.
    }
  }
}
