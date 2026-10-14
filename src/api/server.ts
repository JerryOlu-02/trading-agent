import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { Pit } from "../agent.js";

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function originAllowed(
  origin: string | undefined,
  allowed: string[],
  path: string,
): boolean {
  if (!origin) {
    if (allowed.length === 0) return true;

    return path === "/api/health";
  }

  if (allowed.length === 0) return LOCAL_ORIGIN.test(origin);
  return allowed.includes(origin);
}

const strategyBody = z.object({
  buySizeSol: z.number(),
  minMarketCapSol: z.number(),
  maxMarketCapSol: z.number(),
  minInitialBuySol: z.number(),
  maxInitialBuySol: z.number(),
  minConfidence: z.number(),
  takeProfitMultiple: z.number(),
  stopLossMultiple: z.number(),
  maxHoldMinutes: z.number(),
  slippagePercent: z.number(),
  priorityFeeSol: z.number(),
});

const riskBody = z.object({
  maxSolPerTrade: z.number(),
  maxOpenPositions: z.number(),
  dailyLossLimitSol: z.number(),
});

export function createApi(pit: Pit, allowedOrigins: string[] = []) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");

    if (!originAllowed(origin, allowedOrigins, c.req.path)) {
      return c.json(
        { error: "This site is not allowed to call the agent." },
        403,
      );
    }
    await next();
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin) =>
        originAllowed(origin, allowedOrigins, "/api/state") ? origin : null,
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept"],
    }),
  );

  app.onError((error, c) => {
    console.error("[pit]", error instanceof Error ? error.message : error);
    return c.json({ error: "The agent hit an unexpected error." }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/state", (c) => c.json(pit.snapshot()));
  app.get("/api/trades", (c) =>
    c.json({ fills: pit.trades(), closed: pit.closedPositions() }),
  );
  app.get("/api/logs", (c) => c.json({ logs: pit.logs() }));

  app.put("/api/strategy", async (c) => {
    const parsed = strategyBody.safeParse(await readJson(c.req));
    if (!parsed.success)
      return c.json({ error: "Strategy fields were not numbers." }, 400);
    const result = pit.updateStrategy(parsed.data);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(pit.snapshot());
  });

  app.put("/api/risk", async (c) => {
    const parsed = riskBody.safeParse(await readJson(c.req));
    if (!parsed.success)
      return c.json({ error: "Limit fields were not numbers." }, 400);
    const result = pit.updateRisk({
      ...parsed.data,
      maxOpenPositions: Math.floor(parsed.data.maxOpenPositions),
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(pit.snapshot());
  });

  app.post("/api/halt", async (c) => {
    const body = z
      .object({ halted: z.boolean() })
      .safeParse(await readJson(c.req));
    if (!body.success)
      return c.json({ error: "Say whether buys are halted." }, 400);
    pit.setHalted(body.data.halted);
    return c.json(pit.snapshot());
  });

  app.post("/api/mode", async (c) => {
    const body = z
      .object({
        mode: z.enum(["paper", "live"]),
        confirm: z.string().optional(),
      })
      .safeParse(await readJson(c.req));
    if (!body.success)
      return c.json({ error: "Mode must be paper or live." }, 400);
    if (body.data.mode === "live" && body.data.confirm !== "LIVE") {
      return c.json({ error: "Type LIVE to arm real buys." }, 400);
    }
    const result = pit.setMode(body.data.mode);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(pit.snapshot());
  });

  app.post("/api/flatten", async (c) => {
    await pit.flatten();
    return c.json(pit.snapshot());
  });

  app.post("/api/positions/:id/sell", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Unknown ticket." }, 400);
    const result = await pit.sell(id, "manual", true);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(pit.snapshot());
  });

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsubscribe = pit.subscribe((snapshot) => {
        stream
          .writeSSE({ event: "state", data: JSON.stringify(snapshot) })
          .catch(() => stream.abort());
      });
      stream.onAbort(() => {
        unsubscribe();
      });
      await stream.writeSSE({
        event: "state",
        data: JSON.stringify(pit.snapshot()),
      });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(15_000);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
      unsubscribe();
    });
  });

  return app;
}

async function readJson(req: { json: () => Promise<unknown> }) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
