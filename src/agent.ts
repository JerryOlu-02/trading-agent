import type { Settings } from "./config.js";
import { startOfUtcDay, Store } from "./db/schema.js";
import { executeTrade, TradeError } from "./exec/trade.js";
import { loadWallet, solBalance, type Wallet } from "./exec/wallet.js";
import { PriceBook, quoteBuy, quoteSell } from "./feeds/prices.js";
import { PumpFeed } from "./feeds/pumpportal.js";
import { decide, type ModelDecision } from "./llm/openrouter.js";
import { reviewBuy } from "./risk/guard.js";
import { exitSignal } from "./strategy/exit.js";
import { screen } from "./strategy/filters.js";
import type {
  CandidateView,
  LastDecision,
  Mark,
  Mode,
  NewToken,
  Position,
  PositionView,
  RiskLimits,
  Snapshot,
  StrategySettings,
} from "./types.js";

const LOOK_MS = 12_000;
const STALE_MS = 20_000;

function failureText(error: unknown) {
  return error instanceof Error ? error.message : "Trade failed";
}

function failureSignature(error: unknown) {
  return error instanceof TradeError ? error.signature : null;
}

export function presentPosition(
  position: Position,
  mark: Mark | null,
): PositionView {
  let pnlSol: number | null = null;
  let multiple: number | null = null;
  const markPrice = mark?.price ?? null;

  if (position.status === "closed" && position.exitSol != null) {
    pnlSol = position.exitSol - position.entrySol;

    multiple =
      position.entrySol > 0 ? position.exitSol / position.entrySol : null;
  } else if (position.status === "open" && markPrice != null) {
    pnlSol = position.tokens * markPrice - position.entrySol;

    multiple = position.entryPrice > 0 ? markPrice / position.entryPrice : null;
  }

  return {
    id: position.id,
    mint: position.mint,
    symbol: position.symbol,
    name: position.name,
    status: position.status,
    entrySol: position.entrySol,
    entryPrice: position.entryPrice,
    markPrice,
    tokens: position.tokens,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    exitSol: position.exitSol,
    exitReason: position.exitReason,
    pnlSol,
    multiple,
    tpMultiple: position.tpMultiple,
    slMultiple: position.slMultiple,
    maxHoldMinutes: Math.round(position.maxHoldMs / 60_000),
    thesis: position.thesis,
    dryRun: position.dryRun,
    signature: position.signature,
    error: position.error,
  };
}

export function validateStrategy(
  input: StrategySettings,
  maxBuy: number,
): string | null {
  if (!(input.buySizeSol > 0) || input.buySizeSol > maxBuy + 1e-12) {
    return `Buy size has to be above 0 and at most ${maxBuy} SOL.`;
  }
  if (
    !(input.maxMarketCapSol > input.minMarketCapSol) ||
    input.minMarketCapSol < 0
  ) {
    return "Market cap ceiling has to sit above the floor.";
  }
  if (
    !(input.maxInitialBuySol > input.minInitialBuySol) ||
    input.minInitialBuySol < 0
  ) {
    return "Creator-buy ceiling has to sit above the floor.";
  }
  if (input.minConfidence < 0.5 || input.minConfidence > 0.95) {
    return "Confidence floor stays between 0.50 and 0.95.";
  }
  if (input.takeProfitMultiple < 1.15 || input.takeProfitMultiple > 5) {
    return "Take-profit stays between 1.15× and 5×.";
  }
  if (input.stopLossMultiple < 0.3 || input.stopLossMultiple > 0.9) {
    return "Stop-loss stays between 0.30× and 0.90×.";
  }
  if (input.maxHoldMinutes < 2 || input.maxHoldMinutes > 60) {
    return "Hold time stays between 2 and 60 minutes.";
  }
  if (input.slippagePercent < 1 || input.slippagePercent > 25) {
    return "Slippage stays between 1% and 25%.";
  }
  if (input.priorityFeeSol < 0 || input.priorityFeeSol > 0.001) {
    return "Priority fee stays between 0 and 0.001 SOL.";
  }
  return null;
}

export function validateRisk(
  input: RiskLimits,
  ceilings: RiskLimits,
): string | null {
  if (
    !(input.maxSolPerTrade > 0) ||
    input.maxSolPerTrade > ceilings.maxSolPerTrade
  ) {
    return `Per-trade cap cannot rise above ${ceilings.maxSolPerTrade} SOL.`;
  }
  if (
    !Number.isInteger(input.maxOpenPositions) ||
    input.maxOpenPositions < 1 ||
    input.maxOpenPositions > ceilings.maxOpenPositions
  ) {
    return `Open tickets cannot rise above ${ceilings.maxOpenPositions}.`;
  }
  if (
    !(input.dailyLossLimitSol > 0) ||
    input.dailyLossLimitSol > ceilings.dailyLossLimitSol
  ) {
    return `Daily loss limit cannot rise above ${ceilings.dailyLossLimitSol} SOL.`;
  }
  return null;
}

export class Pit {
  readonly ceilings: RiskLimits;
  private readonly wallet: Wallet;
  private readonly feed: PumpFeed;
  private readonly prices: PriceBook;
  private strategy: StrategySettings;
  private risk: RiskLimits;
  private mode: Mode;
  private halted = false;
  private sol: number | null = null;
  private lastDecision: LastDecision | null = null;
  private readonly startedAt = Date.now();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private waiting: NewToken | null = null;
  private inflight = false;
  private ticking = false;
  private readonly selling = new Set<number>();
  private readonly sellAfter = new Map<number, number>();
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private broadcastTimer: NodeJS.Timeout | null = null;
  private balanceTimer: NodeJS.Timeout | null = null;
  private exitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly store: Store,
  ) {
    this.ceilings = {
      maxSolPerTrade: settings.maxSolPerTrade,
      maxOpenPositions: settings.maxOpenPositions,
      dailyLossLimitSol: settings.dailyLossLimitSol,
    };
    this.wallet = loadWallet(settings.walletSecret, settings.rpcUrl);
    this.strategy = store.readStrategy(this.ceilings);
    this.risk = store.readRisk(this.ceilings);
    this.mode = !settings.dryRun && this.wallet.keypair ? "live" : "paper";
    const latest = store.latestCandidate();
    if (latest) this.lastDecision = toDecision(latest);
    this.prices = new PriceBook(this.wallet.connection, (message) =>
      this.store.log("warn", message),
    );
    this.feed = new PumpFeed({
      onCreate: (token) => this.onCreate(token),
      onMigrate: (mint) => this.onMigrate(mint),
      onStatus: () => this.touch(),
    });
  }

  start() {
    if (this.wallet.invalidSecret) {
      this.store.log(
        "warn",
        "Wallet secret could not be read. No signer is loaded.",
      );
    }
    if (!this.settings.dryRun && !this.wallet.keypair) {
      this.store.log(
        "warn",
        "DRY_RUN is false, but no wallet loaded. Staying on paper.",
      );
    }
    if (!this.settings.hasModelKey) {
      this.store.log(
        "warn",
        "OpenRouter key is missing. The desk will watch and pass.",
      );
    }
    this.store.expirePending(90_000);
    this.prices.start();
    this.feed.start();
    void this.refreshBalance();
    this.balanceTimer = setInterval(() => void this.refreshBalance(), 15_000);
    this.exitTimer = setInterval(() => void this.tick(), 3_000);
    this.store.log(
      "info",
      `Desk is open in ${this.mode} mode on ${this.settings.openRouterModel}.`,
    );
    this.touch();
  }

  stop() {
    this.feed.stop();
    this.prices.stop();
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    if (this.exitTimer) clearInterval(this.exitTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
  }

  subscribe(listener: (snapshot: Snapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Snapshot {
    const open = this.store.openPositions();
    const pnl = this.pnl(open);
    return {
      mode: this.mode,
      halted: this.halted,
      model: this.settings.openRouterModel,
      hasModelKey: this.settings.hasModelKey,
      wallet: { publicKey: this.wallet.publicKey, sol: this.sol },
      solUsd: this.prices.solUsd,
      startedAt: this.startedAt,
      lastDecision: this.lastDecision,
      positions: open.map((position) =>
        presentPosition(position, this.prices.mark(position.mint)),
      ),
      candidates: this.store.candidates(25),
      pnl: { daySol: pnl.net, openSol: pnl.open },
      risk: { ...this.risk, ceilings: this.ceilings },
      strategy: this.strategy,
      usage: {
        openPositions: open.length,
        dayLossSol: Math.max(0, -pnl.net),
      },
      feed: {
        connected: this.feed.connected,
        seen: this.feed.seen,
        queued: this.waiting ? 1 : 0,
      },
      now: Date.now(),
    };
  }

  setHalted(halted: boolean) {
    this.halted = halted;
    this.store.log("warn", halted ? "Buys halted." : "Buys resumed.");
    this.touch();
  }

  setMode(mode: Mode): { ok: true } | { ok: false; error: string } {
    if (mode === "live" && !this.wallet.keypair) {
      return { ok: false, error: "Load a wallet before live trading." };
    }
    this.mode = mode;
    this.store.log(
      mode === "live" ? "warn" : "info",
      mode === "live"
        ? "Switched to live for this session. A restart follows DRY_RUN."
        : "Switched to paper. New buys stay simulated.",
    );
    this.touch();
    return { ok: true };
  }

  updateStrategy(
    input: StrategySettings,
  ): { ok: true } | { ok: false; error: string } {
    const error = validateStrategy(input, this.risk.maxSolPerTrade);
    if (error) return { ok: false, error };
    this.strategy = input;
    this.store.writeStrategy(input);
    this.store.log("info", "Strategy saved.");
    this.touch();
    return { ok: true };
  }

  updateRisk(input: RiskLimits): { ok: true } | { ok: false; error: string } {
    const error = validateRisk(input, this.ceilings);
    if (error) return { ok: false, error };
    this.risk = input;
    this.store.writeRisk(input);
    if (this.strategy.buySizeSol > input.maxSolPerTrade) {
      this.strategy = { ...this.strategy, buySizeSol: input.maxSolPerTrade };
      this.store.writeStrategy(this.strategy);
    }
    this.store.log("info", "Limits saved.");
    this.touch();
    return { ok: true };
  }

  async flatten() {
    const open = this.store
      .openPositions()
      .filter((position) => position.status === "open");
    for (const position of open) {
      await this.sell(position.id, "flatten", true);
    }
  }

  async sell(
    id: number,
    reason: string,
    force = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.selling.has(id))
      return { ok: false, error: "That ticket is already selling." };
    if (!force && (this.sellAfter.get(id) ?? 0) > Date.now()) {
      return {
        ok: false,
        error: "That sell is cooling down after a failed attempt.",
      };
    }
    const position = this.store.position(id);
    if (!position || position.status !== "open") {
      return { ok: false, error: "That ticket is not open." };
    }
    this.selling.add(id);
    try {
      if (position.dryRun) {
        const mark = this.prices.mark(position.mint);
        const quoted = mark
          ? quoteSell(mark.vSol, mark.vTokens, position.tokens)
          : null;
        const exitSol =
          quoted?.sol ??
          position.tokens * (mark?.price ?? position.entryPrice) * 0.99;
        this.store.closePosition(id, exitSol, reason, null);
        this.store.insertTrade({
          positionId: id,
          mint: position.mint,
          symbol: position.symbol,
          side: "sell",
          solAmount: exitSol,
          signature: null,
          dryRun: true,
          status: "paper",
          error: null,
        });
        this.store.log(
          "info",
          `Sold ${position.symbol} (${reason}) on paper for ${exitSol.toFixed(4)} SOL.`,
        );
        this.touch();
        return { ok: true };
      }
      if (!this.wallet.keypair)
        return { ok: false, error: "No wallet loaded for a live sell." };
      const fill = await executeTrade({
        connection: this.wallet.connection,
        keypair: this.wallet.keypair,
        action: "sell",
        mint: position.mint,
        amount: "100%",
        denominatedInSol: false,
        slippagePercent: this.strategy.slippagePercent,
        priorityFeeSol: this.strategy.priorityFeeSol,
      });
      const received = Math.max(0, fill.solDelta);
      this.store.closePosition(id, received, reason, fill.signature);
      this.store.insertTrade({
        positionId: id,
        mint: position.mint,
        symbol: position.symbol,
        side: "sell",
        solAmount: received,
        signature: fill.signature,
        dryRun: false,
        status: "confirmed",
        error: null,
      });
      this.store.log(
        "info",
        `Sold ${position.symbol} (${reason}). ${fill.signature}`,
      );
      void this.refreshBalance();
      this.touch();
      return { ok: true };
    } catch (error) {
      const message = failureText(error);
      this.sellAfter.set(id, Date.now() + 30_000);
      this.store.log(
        "error",
        `Sell ${position.symbol} failed (${reason}). ${message}`,
      );
      return { ok: false, error: message };
    } finally {
      this.selling.delete(id);
    }
  }

  closedPositions(): PositionView[] {
    return this.store
      .closedPositions()
      .map((position) =>
        presentPosition(position, this.prices.mark(position.mint)),
      );
  }

  trades() {
    return this.store.trades();
  }

  logs() {
    return this.store.logs();
  }

  private onCreate(token: NewToken) {
    if (!this.remember(token.mint)) return;
    this.seed(token);
    const screened = screen(token, this.strategy);
    if (!screened.ok) {
      this.note(token, "skip", screened.reason);
      return;
    }
    if (this.inflight) {
      if (this.waiting)
        this.note(this.waiting, "skip", "A newer mint took the open slot.");
      this.waiting = token;
      this.touch();
      return;
    }
    void this.run(token);
  }

  private onMigrate(mint: string) {
    const position = this.store.openByMint(mint);
    if (position?.status === "open")
      void this.sell(position.id, "migrated", true);
  }

  private async run(token: NewToken) {
    this.inflight = true;
    try {
      await this.consider(token);
    } catch (error) {
      this.store.log("error", failureText(error));
    } finally {
      this.inflight = false;
      const next = this.waiting;
      this.waiting = null;
      if (!next) return;
      if (Date.now() - next.seenAt > LOOK_MS) {
        this.note(next, "skip", "The curve moved on before the model looked.");
        return;
      }
      void this.run(next);
    }
  }

  private async consider(token: NewToken) {
    if (Date.now() - token.seenAt > LOOK_MS) {
      this.note(token, "skip", "The curve moved on before the model looked.");
      return;
    }
    const preview = Math.min(
      this.strategy.buySizeSol,
      this.risk.maxSolPerTrade,
    );
    const gate = this.gate(preview);
    if (!gate.ok) {
      this.note(token, "skip", gate.reason);
      return;
    }
    if (!this.settings.hasModelKey) {
      this.note(
        token,
        "skip",
        "No OpenRouter key, so the desk can only watch.",
      );
      return;
    }
    const decision = await decide(this.settings, token, this.strategy, preview);
    if (Date.now() - token.seenAt > STALE_MS) {
      this.note(
        token,
        "skip",
        decision.action === "buy"
          ? "Model wanted a buy, but the mint was already too old."
          : decision.thesis,
        true,
      );
      return;
    }
    if (decision.action !== "buy") {
      this.note(token, "pass", decision.thesis);
      return;
    }
    const size = Math.min(
      decision.sizeSol,
      this.strategy.buySizeSol,
      this.risk.maxSolPerTrade,
    );
    const again = this.gate(size);
    if (!again.ok) {
      this.note(token, "skip", again.reason);
      return;
    }
    if (this.store.openByMint(token.mint)) {
      this.note(token, "skip", "Already holding this mint.");
      return;
    }
    await this.buy(token, decision, size);
  }

  private async buy(token: NewToken, decision: ModelDecision, size: number) {
    const mark = this.prices.mark(token.mint);
    const quote = quoteBuy(
      mark?.vSol ?? token.vSol,
      mark?.vTokens ?? token.vTokens,
      size,
    );
    if (!quote) {
      this.note(token, "skip", "Could not price a buy on the curve.", true);
      return;
    }
    const dryRun = this.mode === "paper";
    const id = this.store.insertPosition({
      mint: token.mint,
      name: token.name,
      symbol: token.symbol,
      entrySol: size,
      entryPrice: size / quote.tokens,
      tokens: quote.tokens,
      vSol: quote.vSol,
      vTokens: quote.vTokens,
      bondingCurve: token.bondingCurve,
      tpMultiple: decision.takeProfitMultiple,
      slMultiple: decision.stopLossMultiple,
      maxHoldMs: decision.maxHoldMinutes * 60_000,
      dryRun,
      thesis: decision.thesis,
    });
    if (dryRun) {
      this.store.markOpen(id, {
        signature: null,
        entrySol: size,
        entryPrice: size / quote.tokens,
        tokens: quote.tokens,
      });
      this.store.insertTrade({
        positionId: id,
        mint: token.mint,
        symbol: token.symbol,
        side: "buy",
        solAmount: size,
        signature: null,
        dryRun: true,
        status: "paper",
        error: null,
      });
      this.prices.seed(token.mint, {
        price: quote.price,
        complete: false,
        at: Date.now(),
        vSol: quote.vSol,
        vTokens: quote.vTokens,
      });
      this.store.log(
        "info",
        `Bought ${token.symbol} on paper for ${size} SOL. ${decision.thesis}`,
      );
      this.note(token, "buy", decision.thesis);
      return;
    }

    if (!this.wallet.keypair) {
      this.store.markFailed(id, "No wallet loaded.", null);
      this.note(token, "skip", "No wallet loaded for a live buy.", true);
      return;
    }

    try {
      const fill = await executeTrade({
        connection: this.wallet.connection,
        keypair: this.wallet.keypair,
        action: "buy",
        mint: token.mint,
        amount: size,
        denominatedInSol: true,
        slippagePercent: this.strategy.slippagePercent,
        priorityFeeSol: this.strategy.priorityFeeSol,
      });
      const spent = fill.solDelta < 0 ? -fill.solDelta : size;
      const entryPrice = quote.tokens > 0 ? spent / quote.tokens : 0;
      this.store.markOpen(id, {
        signature: fill.signature,
        entrySol: spent,
        entryPrice,
        tokens: quote.tokens,
      });
      this.store.insertTrade({
        positionId: id,
        mint: token.mint,
        symbol: token.symbol,
        side: "buy",
        solAmount: spent,
        signature: fill.signature,
        dryRun: false,
        status: "confirmed",
        error: null,
      });
      this.store.log(
        "info",
        `Bought ${token.symbol} for ${spent.toFixed(4)} SOL. ${fill.signature}`,
      );
      this.note(token, "buy", decision.thesis);
      void this.refreshBalance();
    } catch (error) {
      const message = failureText(error);
      this.note(token, "skip", `Buy failed. ${message}`, true);
      this.store.markFailed(id, message, failureSignature(error));
      this.store.insertTrade({
        positionId: id,
        mint: token.mint,
        symbol: token.symbol,
        side: "buy",
        solAmount: size,
        signature: failureSignature(error),
        dryRun: false,
        status: "failed",
        error: message,
      });
      this.store.log("error", `Buy ${token.symbol} failed. ${message}`);
    }
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const open = this.store
        .openPositions()
        .filter((position) => position.status === "open");
      await this.prices.refresh(
        open.map((position) => ({
          mint: position.mint,
          bondingCurve: position.bondingCurve,
        })),
      );
      for (const position of open) {
        if (this.selling.has(position.id)) continue;
        const reason = exitSignal(
          position,
          this.prices.mark(position.mint),
          Date.now(),
        );
        if (reason) await this.sell(position.id, reason);
      }
      this.touch();
    } finally {
      this.ticking = false;
    }
  }

  private gate(sizeSol: number) {
    const pnl = this.pnl(this.store.openPositions());
    return reviewBuy({
      sizeSol,
      openCount: this.store.openPositions().length,
      dayPnlSol: pnl.net,
      mode: this.mode,
      hasWallet: Boolean(this.wallet.keypair),
      halted: this.halted,
      limits: this.risk,
    });
  }

  private pnl(open: Position[]) {
    const realized = this.store.realizedSince(startOfUtcDay());
    let unrealized = 0;
    for (const position of open) {
      if (position.status !== "open") continue;
      const mark = this.prices.mark(position.mint);
      if (!mark) continue;
      unrealized += position.tokens * mark.price - position.entrySol;
    }
    return { open: unrealized, net: realized + unrealized };
  }

  private seed(token: NewToken) {
    if (!(token.vTokens > 0) || !(token.vSol > 0)) return;
    this.prices.seed(token.mint, {
      price: token.vSol / token.vTokens,
      complete: false,
      at: token.seenAt,
      vSol: token.vSol,
      vTokens: token.vTokens,
    });
  }

  private note(
    token: NewToken,
    action: LastDecision["action"],
    thesis: string,
    stamp = action !== "skip",
  ) {
    if (stamp) {
      this.lastDecision = {
        at: Date.now(),
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        action,
        thesis,
      };
    }
    this.store.noteCandidate(token, action, thesis);
    this.touch();
  }

  private remember(mint: string) {
    if (this.seen.has(mint)) return false;
    this.seen.add(mint);
    this.seenOrder.push(mint);
    if (this.seenOrder.length > 5_000) {
      for (const old of this.seenOrder.splice(0, 1_000)) this.seen.delete(old);
    }
    return true;
  }

  private async refreshBalance() {
    if (!this.wallet.publicKey) return;
    this.sol = await solBalance(this.wallet.connection, this.wallet.publicKey);
    this.touch();
  }

  private touch() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    }, 200);
  }
}

function toDecision(candidate: CandidateView): LastDecision {
  return {
    at: candidate.at,
    mint: candidate.mint,
    symbol: candidate.symbol,
    name: candidate.name,
    action: candidate.action,
    thesis: candidate.thesis,
  };
}
