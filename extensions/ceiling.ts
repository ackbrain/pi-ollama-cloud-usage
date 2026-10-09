import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./auth";
import type { LocalUsage } from "./local-usage";

export interface TokenCeilings {
  session?: number;
  weekly?: number;
}

function ceilingPath(): string {
  return join(agentDir(), "state", "pi-ollama-cloud-usage", "ceilings.json");
}

function safeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Number.isInteger(value) ? value : Math.ceil(value);
}

function parseCeilingText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Number.isInteger(num) ? num : Math.ceil(num);
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read configured token ceilings. Environment variables take precedence over
 * the persisted calibration file so the captain can override the auto-detected
 * ceiling without deleting state.
 *
 *   OLLAMA_CLOUD_SESSION_CEILING_TOKENS
 *   OLLAMA_CLOUD_WEEKLY_CEILING_TOKENS
 */
export function readCeilings(): TokenCeilings {
  const file = objectValue(readJsonFile(ceilingPath()));
  const ceilings: TokenCeilings = {};
  const envSession = parseCeilingText(process.env.OLLAMA_CLOUD_SESSION_CEILING_TOKENS);
  const envWeekly = parseCeilingText(process.env.OLLAMA_CLOUD_WEEKLY_CEILING_TOKENS);

  if (envSession !== undefined) {
    ceilings.session = envSession;
  } else {
    const storedSession = safeInt(file?.session);
    if (storedSession !== undefined) ceilings.session = storedSession;
  }

  if (envWeekly !== undefined) {
    ceilings.weekly = envWeekly;
  } else {
    const storedWeekly = safeInt(file?.weekly);
    if (storedWeekly !== undefined) ceilings.weekly = storedWeekly;
  }

  return ceilings;
}

/**
 * Record the current local usage as the calibrated ceiling. This is called
 * when a 429/session-usage-limit response is observed, under the assumption
 * that consumption at the moment of rejection is at or very near the actual
 * ceiling. Once set, calibration is only raised (never lowered) unless the
 * captain overrides it via environment variables.
 */
export function calibrateCeilings(usage: LocalUsage): void {
  const current = readCeilings();
  let changed = false;

  if (
    usage.session5hTokens > 0
    && (current.session === undefined || usage.session5hTokens > current.session)
  ) {
    current.session = Math.ceil(usage.session5hTokens);
    changed = true;
  }
  if (
    usage.weekly7dTokens > 0
    && (current.weekly === undefined || usage.weekly7dTokens > current.weekly)
  ) {
    current.weekly = Math.ceil(usage.weekly7dTokens);
    changed = true;
  }

  if (!changed) return;

  const path = ceilingPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2), "utf8");
}
