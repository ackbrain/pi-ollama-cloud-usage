import { describe, expect, it } from "vitest";
import {
  parseUsage,
  renderUsage,
  renderUsageStatus,
  remainingPercent,
  UsageError,
  usedPercent,
} from "../extensions/usage";
import usageFixture from "./fixtures/usage.json";

describe("parseUsage", () => {
  it("parses the real /api/usage payload", () => {
    const usage = parseUsage(usageFixture);
    expect(usage.cost).toBe("0.00000");
    expect(usage.period?.type).toBe("last_4_weeks");
    expect(usage.period?.startingAt).toBe("2026-07-06T00:00:00Z");
    expect(usedPercent(usage.session)).toBeCloseTo(98);
    expect(usedPercent(usage.weekly)).toBeCloseTo(98.3, 1);
    expect(usage.session.models).toHaveLength(2);
    expect(usage.session.models[0]).toEqual({ name: "glm-5.2", requestCount: 350 });
    expect(usage.weekly.models).toHaveLength(4);
  });

  it("treats usage as a fraction (0.98 = 98%)", () => {
    const usage = parseUsage({
      limits: { session: { usage: 0.25 }, weekly: { usage: 1 } },
    });
    expect(usedPercent(usage.session)).toBe(25);
    expect(remainingPercent(usage.session)).toBe(75);
    expect(usedPercent(usage.weekly)).toBe(100);
  });

  it("tolerates a defensive percent-style usage value", () => {
    const usage = parseUsage({ limits: { session: { usage: 42.5 } } });
    expect(usedPercent(usage.session)).toBe(42.5);
  });

  it("handles a missing limits section", () => {
    const usage = parseUsage({ activity: { cost: "0.00000" } });
    expect(usage.cost).toBe("0.00000");
    expect(usedPercent(usage.session)).toBeUndefined();
    expect(usedPercent(usage.weekly)).toBeUndefined();
    expect(usage.session.models).toEqual([]);
  });

  it("rejects invalid usage values", () => {
    const usage = parseUsage({ limits: { session: { usage: -1 } } });
    expect(usedPercent(usage.session)).toBeUndefined();
    expect(usage.session.models).toEqual([]);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseUsage(null)).toThrow(UsageError);
    expect(() => parseUsage("nope")).toThrow(UsageError);
    expect(() => parseUsage([])).toThrow(UsageError);
  });
});

describe("renderUsageStatus", () => {
  it("shows session and weekly usage", () => {
    const usage = parseUsage(usageFixture);
    expect(renderUsageStatus(usage)).toBe("Ollama 5h:98% Wk:98.3%");
  });

  it("shows only the reported window", () => {
    const usage = parseUsage({ limits: { session: { usage: 0.5 } } });
    expect(renderUsageStatus(usage)).toBe("Ollama 5h:50%");
  });

  it("falls back to cost when no windows are reported", () => {
    const usage = parseUsage({ activity: { cost: "1.25" } });
    expect(renderUsageStatus(usage)).toBe("Ollama $1.25");
  });

  it("falls back to ok when nothing is present", () => {
    expect(renderUsageStatus(parseUsage({}))).toBe("Ollama ok");
  });
});

describe("renderUsage", () => {
  it("renders a full readable report", () => {
    const text = renderUsage(parseUsage(usageFixture));
    expect(text).toContain("Ollama Cloud usage:");
    expect(text).toContain("Session window (5h): 98% used");
    expect(text).toContain("Session remaining: 2%");
    expect(text).toContain("Weekly window (7d): 98.3% used");
    expect(text).toContain("Weekly remaining: 1.7%");
    expect(text).toContain("  glm-5.2 (350 requests)");
    expect(text).toContain("  deepseek-v4-flash (337 requests)");
    expect(text).toContain("  web fetch (4 requests)");
    expect(text).toContain("Activity cost (last_4_weeks): $0.00000");
    expect(text).toMatch(/Period start: /);
    expect(text).not.toMatch(/Period start: \d{4}-\d{2}-\d{2}T/);
  });

  it("reports when no supported fields are returned", () => {
    expect(renderUsage(parseUsage({}))).toBe(
      "Ollama Cloud usage:\nNo supported usage fields were returned.",
    );
  });
});
