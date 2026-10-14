import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const TRADE_LOCAL = "https://pumpportal.fun/api/trade-local";

export type LiveFill = {
  signature: string;
  solDelta: number;
};

export class TradeError extends Error {
  signature: string | null;
  constructor(message: string, signature: string | null = null) {
    super(message);
    this.name = "TradeError";
    this.signature = signature;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmSignature(connection: Connection, signature: string) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new TradeError(`Transaction failed: ${JSON.stringify(status.err)}`, signature);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await sleep(800);
  }
  throw new TradeError(`Confirmation timed out for ${signature}`, signature);
}

// PumpPortal receives the public key only. The secret stays in this process.
export async function executeTrade(args: {
  connection: Connection;
  keypair: Keypair;
  action: "buy" | "sell";
  mint: string;
  amount: number | string;
  denominatedInSol: boolean;
  slippagePercent: number;
  priorityFeeSol: number;
}): Promise<LiveFill> {
  const owner = args.keypair.publicKey;
  const before = await args.connection.getBalance(owner, "confirmed");
  const response = await fetch(TRADE_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: owner.toBase58(),
      action: args.action,
      mint: args.mint,
      amount: args.amount,
      denominatedInSol: args.denominatedInSol ? "true" : "false",
      slippage: args.slippagePercent,
      priorityFee: args.priorityFeeSol,
      pool: "auto",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new TradeError(new TextDecoder().decode(bytes).slice(0, 300) || `Trade build failed (${response.status})`);
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new TradeError(new TextDecoder().decode(bytes).slice(0, 300) || "Trade build was not a transaction");
  }

  tx.sign([args.keypair]);
  const signature = await args.connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await confirmSignature(args.connection, signature);
  const after = await args.connection.getBalance(owner, "confirmed");
  return { signature, solDelta: (after - before) / 1e9 };
}
