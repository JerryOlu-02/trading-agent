import type { Mark, Position } from "../types.js";

const GRACE_MS = 5_000;

export function exitSignal(
  position: Pick<Position, "entryPrice" | "openedAt" | "tpMultiple" | "slMultiple" | "maxHoldMs">,
  mark: Mark | null,
  now: number,
): string | null {
  if (mark?.complete) return "migrated";
  if (now - position.openedAt < GRACE_MS) return null;
  if (mark && position.entryPrice > 0) {
    const multiple = mark.price / position.entryPrice;
    if (multiple >= position.tpMultiple) return "take-profit";
    if (multiple <= position.slMultiple) return "stop-loss";
  }
  if (now - position.openedAt >= position.maxHoldMs) return "time";
  return null;
}
