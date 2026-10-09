import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibrateCeilings, readCeilings } from "../extensions/ceiling";
import {
  formatTokenCount,
  readLocalTokenUsage,
  resetLocalUsageCache,
  type LocalUsage,
} from "../extensions/local-usage";
import { renderUsageStatus, type UsageSnapshot } from "../extensions/usage";

const NOW_MS = Date.parse("2026-10-07T08:00:00.000Z");
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("readLocalTokenUsage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-ollama-local-usage-"));
    resetLocalUsageCache();
  });

  afterEach(async () => {
    resetLocalUsageCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sums totalTokens and cost over the 5h and 7d windows", async () => {
    const sessionsDir = join(tmpDir, "sessions");
    const file = join(sessionsDir, "home", "session.jsonl");
    await mkdir(join(sessionsDir, "home"), { recursive: true });
    await writeFile(file, fixtureSession());
    await utimes(file, new Date(NOW_MS), new Date(NOW_MS));

    const result = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS, force: true });

    expect(result.session5hTokens).toBe(1100 + 2200 + 6600);
    expect(result.weekly7dTokens).toBe(1100 + 2200 + 3300 + 4400 + 6600);
    expect(result.session5hCost).toBe(0.03);
    expect(result.weekly7dCost).toBe(0.03);
  });

  it("respects the 5-hour boundary", async () => {
    const sessionsDir = join(tmpDir, "sessions");
    const file = join(sessionsDir, "session.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    const inside = NOW_MS - FIVE_HOURS_MS;
    const outside = NOW_MS - FIVE_HOURS_MS - 1;
    await writeFile(
      file,
      lines(
        assistantMessage(inside, 1000),
        assistantMessage(outside, 2000),
      ),
    );
    await utimes(file, new Date(NOW_MS), new Date(NOW_MS));

    const result = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS, force: true });
    expect(result.session5hTokens).toBe(1000);
    expect(result.weekly7dTokens).toBe(3000);
  });

  it("respects the 7-day boundary", async () => {
    const sessionsDir = join(tmpDir, "sessions");
    const file = join(sessionsDir, "session.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    const inside = NOW_MS - SEVEN_DAYS_MS;
    const outside = NOW_MS - SEVEN_DAYS_MS - 1;
    await writeFile(
      file,
      lines(
        assistantMessage(inside, 1000),
        assistantMessage(outside, 2000),
      ),
    );
    await utimes(file, new Date(NOW_MS), new Date(NOW_MS));

    const result = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS, force: true });
    expect(result.session5hTokens).toBe(0);
    expect(result.weekly7dTokens).toBe(1000);
  });

  it("skips files with mtime older than 7 days", async () => {
    const sessionsDir = join(tmpDir, "sessions");
    const file = join(sessionsDir, "session.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(file, lines(assistantMessage(NOW_MS - 1, 1234)));
    await utimes(file, new Date(NOW_MS - SEVEN_DAYS_MS - 1), new Date(NOW_MS - SEVEN_DAYS_MS - 1));

    const result = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS, force: true });
    expect(result.session5hTokens).toBe(0);
    expect(result.weekly7dTokens).toBe(0);
  });

  it("caches results for 60 seconds", async () => {
    const sessionsDir = join(tmpDir, "sessions");
    const file = join(sessionsDir, "session.jsonl");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(file, lines(assistantMessage(NOW_MS - 1, 500)));
    await utimes(file, new Date(NOW_MS), new Date(NOW_MS));

    const first = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS, force: true });
    expect(first.session5hTokens).toBe(500);

    await writeFile(file, lines(assistantMessage(NOW_MS - 1, 9999)));
    const cached = await readLocalTokenUsage({ sessionsDir, nowMs: NOW_MS + 30_000 });
    expect(cached.session5hTokens).toBe(500);

    const refreshed = await readLocalTokenUsage({
      sessionsDir,
      nowMs: NOW_MS + 70_000,
      force: true,
    });
    expect(refreshed.session5hTokens).toBe(9999);
  });
});

describe("formatTokenCount", () => {
  it("formats millions, thousands, and units", () => {
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_500)).toBe("1.5K");
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("renderUsageStatus with local accounting", () => {
  const emptySnapshot: UsageSnapshot = {
    session: { models: [] },
    weekly: { models: [] },
  };

  function snapshot(local: LocalUsage, ceilings?: { session?: number; weekly?: number }): UsageSnapshot {
    return {
      session: { models: [] },
      weekly: { models: [] },
      local,
      ceilings,
    };
  }

  it("shows token counts when no ceiling is configured", () => {
    const usage = snapshot({
      session5hTokens: 1_200_000,
      weekly7dTokens: 7_500_000,
      session5hCost: 0,
      weekly7dCost: 0,
    });
    expect(renderUsageStatus(usage)).toBe("Ollama 5h:~1.2M tok / Wk:~7.5M tok");
  });

  it("shows percentages when a ceiling is known", () => {
    const usage = snapshot(
      {
        session5hTokens: 500_000,
        weekly7dTokens: 1_000_000,
        session5hCost: 0,
        weekly7dCost: 0,
      },
      { session: 1_000_000, weekly: 4_000_000 },
    );
    expect(renderUsageStatus(usage)).toBe("Ollama 5h:50% Wk:25%");
  });

  it("falls back to API request counts when local data is absent", () => {
    const usage: UsageSnapshot = {
      ...emptySnapshot,
      sessionRequestCount: 44,
      weeklyRequestCount: 2247,
    };
    expect(renderUsageStatus(usage)).toBe("Ollama ~44 req 5h / 2247 wk");
  });

  it("falls back to ok when nothing is present", () => {
    expect(renderUsageStatus(emptySnapshot)).toBe("Ollama ok");
  });
});

describe("calibrateCeilings", () => {
  let originalAgentDir: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalAgentDir = process.env.PI_AGENT_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "pi-ollama-ceiling-"));
    process.env.PI_AGENT_DIR = tmpDir;
  });

  afterEach(async () => {
    process.env.PI_AGENT_DIR = originalAgentDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records current usage as the ceiling", () => {
    const usage: LocalUsage = {
      session5hTokens: 123_456,
      weekly7dTokens: 789_012,
      session5hCost: 0,
      weekly7dCost: 0,
    };
    calibrateCeilings(usage);
    expect(readCeilings()).toEqual({ session: 123_456, weekly: 789_012 });
  });

  it("only raises the calibrated ceiling, never lowers it", () => {
    const first: LocalUsage = {
      session5hTokens: 100_000,
      weekly7dTokens: 200_000,
      session5hCost: 0,
      weekly7dCost: 0,
    };
    const second: LocalUsage = {
      session5hTokens: 50_000,
      weekly7dTokens: 250_000,
      session5hCost: 0,
      weekly7dCost: 0,
    };
    calibrateCeilings(first);
    calibrateCeilings(second);
    expect(readCeilings()).toEqual({ session: 100_000, weekly: 250_000 });
  });

  it("lets environment variables override the persisted calibration", () => {
    const usage: LocalUsage = {
      session5hTokens: 100_000,
      weekly7dTokens: 200_000,
      session5hCost: 0,
      weekly7dCost: 0,
    };
    calibrateCeilings(usage);
    process.env.OLLAMA_CLOUD_SESSION_CEILING_TOKENS = "999999";
    process.env.OLLAMA_CLOUD_WEEKLY_CEILING_TOKENS = "888888";
    expect(readCeilings()).toEqual({ session: 999_999, weekly: 888_888 });
    delete process.env.OLLAMA_CLOUD_SESSION_CEILING_TOKENS;
    delete process.env.OLLAMA_CLOUD_WEEKLY_CEILING_TOKENS;
  });
});

function fixtureSession(): string {
  const path = join(__dirname, "fixtures", "session.jsonl");
  return new TextDecoder().decode(new Uint8Array(readFileSync(path)));
}

function assistantMessage(timestampMs: number, totalTokens: number, costTotal = 0): string {
  const iso = new Date(timestampMs).toISOString();
  return JSON.stringify({
    type: "message",
    id: `m-${timestampMs}`,
    timestamp: iso,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      usage: {
        input: Math.floor(totalTokens * 0.9),
        output: Math.ceil(totalTokens * 0.1),
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: costTotal,
        },
      },
    },
  });
}

function lines(...entries: string[]): string {
  return entries.join("\n") + "\n";
}
