import WebSocket from "ws";
import type { NewToken } from "../types.js";

const URL = "wss://pumpportal.fun/api/data";

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 64);
}

export function humanReserves(vSol: number, vTokens: number) {
  const sol = vSol > 1_000_000 ? vSol / 1e9 : vSol;
  const tokens = vTokens > 1_000_000_000_000 ? vTokens / 1e6 : vTokens;
  return { sol, tokens };
}

function toToken(raw: Record<string, unknown>): NewToken | null {
  const mint = asString(raw.mint);
  if (!mint) return null;
  const reserves = humanReserves(asNumber(raw.vSolInBondingCurve), asNumber(raw.vTokensInBondingCurve));
  const solAmount = asNumber(raw.solAmount);
  const initialBuy = asNumber(raw.initialBuy);
  const initialBuySol = solAmount > 0 ? solAmount : initialBuy > 0 && initialBuy < 100 ? initialBuy : 0;
  return {
    mint,
    name: clean(asString(raw.name)) || "unnamed",
    symbol: clean(asString(raw.symbol)) || "?",
    creator: asString(raw.traderPublicKey),
    marketCapSol: asNumber(raw.marketCapSol),
    initialBuySol,
    vSol: reserves.sol,
    vTokens: reserves.tokens,
    bondingCurve: asString(raw.bondingCurveKey),
    pool: asString(raw.pool) || "pump",
    seenAt: Date.now(),
  };
}

export class PumpFeed {
  private socket: WebSocket | null = null;
  private backoff = 1_000;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  seen = 0;
  connected = false;

  constructor(
    private readonly handlers: {
      onCreate: (token: NewToken) => void;
      onMigrate: (mint: string) => void;
      onStatus: (connected: boolean) => void;
    },
  ) {}

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect() {
    const socket = new WebSocket(URL);
    this.socket = socket;
    socket.on("open", () => {
      this.backoff = 1_000;
      this.connected = true;
      this.handlers.onStatus(true);
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    socket.on("message", (data) => {
      this.onMessage(data.toString());
    });
    socket.on("close", () => {
      this.connected = false;
      this.handlers.onStatus(false);
      if (this.stopped) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
    socket.on("error", () => {
      socket.close();
    });
  }

  private onMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    const txType = asString(message.txType);
    if (txType === "create") {
      const token = toToken(message);
      if (!token) return;
      this.seen += 1;
      this.handlers.onCreate(token);
      return;
    }
    if (txType === "migrate" || txType === "migration") {
      const mint = asString(message.mint) || asString(message.token) || asString(message.tokenAddress);
      if (mint) this.handlers.onMigrate(mint);
    }
  }
}
