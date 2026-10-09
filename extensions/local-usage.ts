import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentDir } from "./auth";

export interface LocalUsage {
  /** Sum of assistant-message totalTokens in the rolling 5-hour window. */
  session5hTokens: number;
  /** Sum of assistant-message totalTokens in the rolling 7-day window. */
  weekly7dTokens: number;
  /** Sum of assistant-message cost.total in the rolling 5-hour window. */
  session5hCost: number;
  /** Sum of assistant-message cost.total in the rolling 7-day window. */
  weekly7dCost: number;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  atMs: number;
  value: LocalUsage;
}

let cache: CacheEntry | undefined;

function defaultSessionsDir(): string {
  return join(agentDir(), "sessions");
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function addUsage(accum: LocalUsage, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const totalTokens = safeNumber(u.totalTokens);
  const cost = u.cost && typeof u.cost === "object"
    ? (u.cost as Record<string, unknown>).total
    : undefined;
  const costTotal = safeNumber(cost);
  if (totalTokens !== undefined) {
    accum.session5hTokens += totalTokens;
    accum.weekly7dTokens += totalTokens;
  }
  if (costTotal !== undefined) {
    accum.session5hCost += costTotal;
    accum.weekly7dCost += costTotal;
  }
}

async function parseSessionFile(
  filePath: string,
  nowMs: number,
  accum: LocalUsage,
): Promise<void> {
  const sessionStartMs = nowMs - FIVE_HOURS_MS;
  const weeklyStartMs = nowMs - SEVEN_DAYS_MS;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.includes('"role":"assistant"')) continue;

    let entry: Record<string, unknown> | undefined;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!entry || entry.type !== "message") continue;

    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (msg.role !== "assistant") continue;

    const ts = parseTimestamp(entry.timestamp);
    if (ts === undefined || ts > nowMs || ts < weeklyStartMs) continue;

    if (ts >= sessionStartMs) {
      addUsage(accum, msg.usage);
    } else {
      // Within 7d but outside 5h: count toward weekly only.
      const weeklyOnly: LocalUsage = {
        session5hTokens: 0,
        weekly7dTokens: 0,
        session5hCost: 0,
        weekly7dCost: 0,
      };
      addUsage(weeklyOnly, msg.usage);
      accum.weekly7dTokens += weeklyOnly.weekly7dTokens;
      accum.weekly7dCost += weeklyOnly.weekly7dCost;
    }
  }
}

async function scanSessionsDir(
  sessionsDir: string,
  nowMs: number,
  accum: LocalUsage,
): Promise<void> {
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const stack: string[] = [];
  for (const entry of entries) {
    stack.push(join(sessionsDir, entry.name));
  }

  while (stack.length > 0) {
    const path = stack.pop()!;
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;

    if (info.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        stack.push(join(path, child.name));
      }
      continue;
    }

    if (!info.isFile() || !path.endsWith(".jsonl")) continue;
    if (nowMs - info.mtimeMs >= SEVEN_DAYS_MS) continue;

    await parseSessionFile(path, nowMs, accum);
  }
}

/**
 * Sum assistant-message usage from all Pi session files under the configured
 * sessions directory. Only files modified in the last 7 days are scanned, and
 * each file is parsed line-by-line so large session files are never loaded
 * whole. Results are cached for 60 seconds by default.
 */
export async function readLocalTokenUsage(
  options: { sessionsDir?: string; nowMs?: number; force?: boolean } = {},
): Promise<LocalUsage> {
  const nowMs = options.nowMs ?? Date.now();

  if (!options.force && cache && nowMs - cache.atMs < CACHE_TTL_MS) {
    return cache.value;
  }

  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const result: LocalUsage = {
    session5hTokens: 0,
    weekly7dTokens: 0,
    session5hCost: 0,
    weekly7dCost: 0,
  };

  try {
    await scanSessionsDir(sessionsDir, nowMs, result);
  } catch {
    // Missing or unreadable sessions directory is not an error; the footer
    // simply shows no local data until sessions are available.
  }

  cache = { atMs: nowMs, value: result };
  return result;
}

/** Format a token count for the footer, e.g. 1_200_000 -> "1.2M". */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}K`;
  }
  return `${value}`;
}

/** Reset the in-memory cache (useful in tests). */
export function resetLocalUsageCache(): void {
  cache = undefined;
}
