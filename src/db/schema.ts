import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CandidateView,
  LogView,
  NewToken,
  Position,
  PositionStatus,
  RiskLimits,
  StrategySettings,
  TradeView,
} from "../types.js";
import { defaultStrategy } from "../types.js";

type PositionRow = {
  id: number;
  mint: string;
  name: string;
  symbol: string;
  status: PositionStatus;
  entry_sol: number;
  entry_price: number;
  tokens: number;
  v_sol: number;
  v_tokens: number;
  bonding_curve: string;
  opened_at: number;
  closed_at: number | null;
  exit_sol: number | null;
  exit_reason: string | null;
  tp_multiple: number;
  sl_multiple: number;
  max_hold_ms: number;
  signature: string | null;
  dry_run: number;
  thesis: string;
  error: string | null;
};

export type OpenInput = {
  mint: string;
  name: string;
  symbol: string;
  entrySol: number;
  entryPrice: number;
  tokens: number;
  vSol: number;
  vTokens: number;
  bondingCurve: string;
  tpMultiple: number;
  slMultiple: number;
  maxHoldMs: number;
  dryRun: boolean;
  thesis: string;
};

export type TradeInput = {
  positionId: number | null;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  solAmount: number;
  signature: string | null;
  dryRun: boolean;
  status: string;
  error: string | null;
};

function mapPosition(row: PositionRow): Position {
  return {
    id: row.id,
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    status: row.status,
    entrySol: row.entry_sol,
    entryPrice: row.entry_price,
    tokens: row.tokens,
    vSol: row.v_sol,
    vTokens: row.v_tokens,
    bondingCurve: row.bonding_curve,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    exitSol: row.exit_sol,
    exitReason: row.exit_reason,
    tpMultiple: row.tp_multiple,
    slMultiple: row.sl_multiple,
    maxHoldMs: row.max_hold_ms,
    signature: row.signature,
    dryRun: row.dry_run === 1,
    thesis: row.thesis,
    error: row.error,
  };
}

export class Store {
  private db: Database.Database;
  private logWrites = 0;
  private candidateWrites = 0;

  constructor() {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, "pit.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        mint TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market_cap_sol REAL NOT NULL,
        initial_buy_sol REAL NOT NULL,
        action TEXT NOT NULL,
        thesis TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_sol REAL NOT NULL,
        entry_price REAL NOT NULL,
        tokens REAL NOT NULL,
        v_sol REAL NOT NULL,
        v_tokens REAL NOT NULL,
        bonding_curve TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        exit_sol REAL,
        exit_reason TEXT,
        tp_multiple REAL NOT NULL,
        sl_multiple REAL NOT NULL,
        max_hold_ms INTEGER NOT NULL,
        signature TEXT,
        dry_run INTEGER NOT NULL,
        thesis TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        signature TEXT,
        dry_run INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  log(level: "info" | "warn" | "error", message: string) {
    const line = `[pit] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    this.db
      .prepare("INSERT INTO logs (level, message, created_at) VALUES (?, ?, ?)")
      .run(level, message, Date.now());
    this.logWrites += 1;
    if (this.logWrites % 40 === 0) {
      this.db
        .prepare(
          `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 1000)`,
        )
        .run();
    }
  }

  readStrategy(ceilings: RiskLimits): StrategySettings {
    const raw = this.readJson<Partial<StrategySettings>>("strategy");
    const merged = { ...defaultStrategy, ...raw };
    return clampStrategy(merged, ceilings.maxSolPerTrade);
  }

  writeStrategy(strategy: StrategySettings) {
    this.writeJson("strategy", strategy);
  }

  readRisk(ceilings: RiskLimits): RiskLimits {
    const raw = this.readJson<Partial<RiskLimits>>("risk");
    return {
      maxSolPerTrade: Math.min(raw?.maxSolPerTrade ?? ceilings.maxSolPerTrade, ceilings.maxSolPerTrade),
      maxOpenPositions: Math.min(
        Math.floor(raw?.maxOpenPositions ?? ceilings.maxOpenPositions),
        ceilings.maxOpenPositions,
      ),
      dailyLossLimitSol: Math.min(
        raw?.dailyLossLimitSol ?? ceilings.dailyLossLimitSol,
        ceilings.dailyLossLimitSol,
      ),
    };
  }

  writeRisk(risk: RiskLimits) {
    this.writeJson("risk", risk);
  }

  noteCandidate(token: NewToken, action: CandidateView["action"], thesis: string) {
    this.db
      .prepare(
        `INSERT INTO candidates (mint, name, symbol, market_cap_sol, initial_buy_sol, action, thesis, seen_at)
         VALUES (@mint, @name, @symbol, @marketCapSol, @initialBuySol, @action, @thesis, @seenAt)
         ON CONFLICT(mint) DO UPDATE SET
           action = excluded.action,
           thesis = excluded.thesis,
           seen_at = excluded.seen_at,
           market_cap_sol = excluded.market_cap_sol`,
      )
      .run({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        marketCapSol: token.marketCapSol,
        initialBuySol: token.initialBuySol,
        action,
        thesis,
        seenAt: Date.now(),
      });
    this.candidateWrites += 1;
    if (this.candidateWrites % 25 === 0) {
      this.db
        .prepare(
          `DELETE FROM candidates WHERE mint NOT IN (
             SELECT mint FROM candidates ORDER BY seen_at DESC LIMIT 300
           )`,
        )
        .run();
    }
  }

  candidates(limit = 25): CandidateView[] {
    const rows = this.db
      .prepare(
        `SELECT mint, name, symbol, market_cap_sol, initial_buy_sol, action, thesis, seen_at
         FROM candidates ORDER BY seen_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      mint: string;
      name: string;
      symbol: string;
      market_cap_sol: number;
      initial_buy_sol: number;
      action: CandidateView["action"];
      thesis: string;
      seen_at: number;
    }>;
    return rows.map((row) => ({
      mint: row.mint,
      name: row.name,
      symbol: row.symbol,
      marketCapSol: row.market_cap_sol,
      initialBuySol: row.initial_buy_sol,
      action: row.action,
      thesis: row.thesis,
      at: row.seen_at,
    }));
  }

  latestCandidate(): CandidateView | null {
    return this.candidates(1)[0] ?? null;
  }

  insertPosition(input: OpenInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO positions (
           mint, name, symbol, status, entry_sol, entry_price, tokens, v_sol, v_tokens,
           bonding_curve, opened_at, tp_multiple, sl_multiple, max_hold_ms, dry_run, thesis
         ) VALUES (
           @mint, @name, @symbol, 'pending', @entrySol, @entryPrice, @tokens, @vSol, @vTokens,
           @bondingCurve, @openedAt, @tpMultiple, @slMultiple, @maxHoldMs, @dryRun, @thesis
         )`,
      )
      .run({ ...input, openedAt: Date.now(), dryRun: input.dryRun ? 1 : 0 });
    return Number(result.lastInsertRowid);
  }

  markOpen(id: number, patch: { signature: string | null; entrySol: number; entryPrice: number; tokens: number }) {
    this.db
      .prepare(
        `UPDATE positions
         SET status = 'open', signature = ?, entry_sol = ?, entry_price = ?, tokens = ?, error = NULL
         WHERE id = ?`,
      )
      .run(patch.signature, patch.entrySol, patch.entryPrice, patch.tokens, id);
  }

  markFailed(id: number, error: string, signature: string | null) {
    this.db
      .prepare(
        `UPDATE positions SET status = 'failed', error = ?, signature = COALESCE(?, signature), closed_at = ? WHERE id = ?`,
      )
      .run(error, signature, Date.now(), id);
  }

  closePosition(id: number, exitSol: number, reason: string, signature: string | null) {
    this.db
      .prepare(
        `UPDATE positions
         SET status = 'closed', exit_sol = ?, exit_reason = ?, closed_at = ?, signature = COALESCE(?, signature)
         WHERE id = ?`,
      )
      .run(exitSol, reason, Date.now(), signature, id);
  }

  attachSignature(id: number, signature: string) {
    this.db.prepare("UPDATE positions SET signature = ? WHERE id = ?").run(signature, id);
  }

  position(id: number): Position | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined;
    return row ? mapPosition(row) : null;
  }

  openPositions(): Position[] {
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE status IN ('open', 'pending') ORDER BY opened_at ASC`)
      .all() as PositionRow[];
    return rows.map(mapPosition);
  }

  openByMint(mint: string): Position | null {
    const row = this.db
      .prepare(`SELECT * FROM positions WHERE mint = ? AND status IN ('open', 'pending') ORDER BY id DESC LIMIT 1`)
      .get(mint) as PositionRow | undefined;
    return row ? mapPosition(row) : null;
  }

  closedPositions(limit = 40): Position[] {
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`)
      .all(limit) as PositionRow[];
    return rows.map(mapPosition);
  }

  realizedSince(since: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(exit_sol - entry_sol), 0) AS pnl
         FROM positions WHERE status = 'closed' AND closed_at >= ?`,
      )
      .get(since) as { pnl: number };
    return row.pnl;
  }

  expirePending(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    this.db
      .prepare(
        `UPDATE positions
         SET status = 'failed', error = COALESCE(error, 'Buy did not finish'), closed_at = ?
         WHERE status = 'pending' AND opened_at < ?`,
      )
      .run(Date.now(), cutoff);
  }

  insertTrade(input: TradeInput) {
    this.db
      .prepare(
        `INSERT INTO trades (position_id, mint, symbol, side, sol_amount, signature, dry_run, status, error, created_at)
         VALUES (@positionId, @mint, @symbol, @side, @solAmount, @signature, @dryRun, @status, @error, @createdAt)`,
      )
      .run({
        ...input,
        dryRun: input.dryRun ? 1 : 0,
        createdAt: Date.now(),
      });
  }

  trades(limit = 80): TradeView[] {
    const rows = this.db
      .prepare(
        `SELECT id, mint, symbol, side, sol_amount, signature, dry_run, status, error, created_at
         FROM trades ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      mint: string;
      symbol: string;
      side: "buy" | "sell";
      sol_amount: number;
      signature: string | null;
      dry_run: number;
      status: string;
      error: string | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      mint: row.mint,
      symbol: row.symbol,
      side: row.side,
      solAmount: row.sol_amount,
      signature: row.signature,
      dryRun: row.dry_run === 1,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
    }));
  }

  logs(limit = 200): LogView[] {
    const rows = this.db
      .prepare(`SELECT id, level, message, created_at FROM logs ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ id: number; level: string; message: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      level: row.level === "warn" || row.level === "error" ? row.level : "info",
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  close() {
    this.db.close();
  }

  private readJson<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private writeJson(key: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }
}

export function clampStrategy(input: StrategySettings, maxBuy: number): StrategySettings {
  return {
    ...input,
    buySizeSol: Math.min(input.buySizeSol, maxBuy),
  };
}

export function startOfUtcDay(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
