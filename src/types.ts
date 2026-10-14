export type Mode = "paper" | "live";

export type StrategySettings = {
  buySizeSol: number;
  minMarketCapSol: number;
  maxMarketCapSol: number;
  minInitialBuySol: number;
  maxInitialBuySol: number;
  minConfidence: number;
  takeProfitMultiple: number;
  stopLossMultiple: number;
  maxHoldMinutes: number;
  slippagePercent: number;
  priorityFeeSol: number;
};

export type RiskLimits = {
  maxSolPerTrade: number;
  maxOpenPositions: number;
  dailyLossLimitSol: number;
};

export type RiskSettings = RiskLimits & {
  ceilings: RiskLimits;
};

export const defaultStrategy: StrategySettings = {
  buySizeSol: 0.02,
  minMarketCapSol: 18,
  maxMarketCapSol: 80,
  minInitialBuySol: 0.2,
  maxInitialBuySol: 3,
  minConfidence: 0.72,
  takeProfitMultiple: 1.8,
  stopLossMultiple: 0.65,
  maxHoldMinutes: 12,
  slippagePercent: 15,
  priorityFeeSol: 0.00005,
};

export type NewToken = {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  marketCapSol: number;
  initialBuySol: number;
  vSol: number;
  vTokens: number;
  bondingCurve: string;
  pool: string;
  seenAt: number;
};

export type Mark = {
  price: number;
  complete: boolean;
  at: number;
  vSol: number;
  vTokens: number;
};

export type PositionStatus = "pending" | "open" | "closed" | "failed";

export type Position = {
  id: number;
  mint: string;
  name: string;
  symbol: string;
  status: PositionStatus;
  entrySol: number;
  entryPrice: number;
  tokens: number;
  vSol: number;
  vTokens: number;
  bondingCurve: string;
  openedAt: number;
  closedAt: number | null;
  exitSol: number | null;
  exitReason: string | null;
  tpMultiple: number;
  slMultiple: number;
  maxHoldMs: number;
  signature: string | null;
  dryRun: boolean;
  thesis: string;
  error: string | null;
};

export type LastDecision = {
  at: number;
  mint: string;
  symbol: string;
  name: string;
  action: "buy" | "pass" | "skip";
  thesis: string;
};

export type PositionView = {
  id: number;
  mint: string;
  symbol: string;
  name: string;
  status: PositionStatus;
  entrySol: number;
  entryPrice: number;
  markPrice: number | null;
  tokens: number;
  openedAt: number;
  closedAt: number | null;
  exitSol: number | null;
  exitReason: string | null;
  pnlSol: number | null;
  multiple: number | null;
  tpMultiple: number;
  slMultiple: number;
  maxHoldMinutes: number;
  thesis: string;
  dryRun: boolean;
  signature: string | null;
  error: string | null;
};

export type CandidateView = {
  mint: string;
  symbol: string;
  name: string;
  action: "buy" | "pass" | "skip";
  thesis: string;
  marketCapSol: number;
  initialBuySol: number;
  at: number;
};

export type TradeView = {
  id: number;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  solAmount: number;
  signature: string | null;
  dryRun: boolean;
  status: string;
  createdAt: number;
  error: string | null;
};

export type LogView = {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: number;
};

export type Snapshot = {
  mode: Mode;
  halted: boolean;
  model: string;
  hasModelKey: boolean;
  wallet: { publicKey: string | null; sol: number | null };
  solUsd: number | null;
  startedAt: number;
  lastDecision: LastDecision | null;
  positions: PositionView[];
  candidates: CandidateView[];
  pnl: { daySol: number; openSol: number };
  risk: RiskSettings;
  strategy: StrategySettings;
  usage: { openPositions: number; dayLossSol: number };
  feed: { connected: boolean; seen: number; queued: number };
  now: number;
};
