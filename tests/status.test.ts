import { describe, expect, it, vi } from "vitest";
import { registerUsage, type UsageSnapshot } from "../extensions/usage";

const usage: UsageSnapshot = {
  cost: "0.00000",
  session: { usageFraction: 0.25, models: [] },
  weekly: { usageFraction: 0.5, models: [] },
};

function createHarness() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const api = {
    registerCommand(name: string, def: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, def);
    },
  };
  return { api: api as any, commands };
}

function setup(model: any = { provider: "ollama-cloud", id: "glm-5.2" }) {
  const harness = createHarness();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  let now = 1_000;
  const resolveCredential = vi.fn(async () => ({ kind: "api-key" as const, key: "SECRET" }));
  const fetchUsage = vi.fn(async () => usage);
  const feature = registerUsage(harness.api, {
    resolveCredential,
    fetchUsage,
    now: () => now,
    minimumRefreshMs: 60_000,
    defaultStatusOn: true,
  });
  const ctx = {
    model,
    signal: undefined,
    modelRegistry: {
      getApiKeyForProvider: async () => "SECRET",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
  };
  const run = (args: string) => harness.commands.get("ollama-usage")!.handler(args, ctx as any);
  return {
    ctx: ctx as any,
    feature,
    fetchUsage,
    harness,
    notifications,
    resolveCredential,
    run,
    statuses,
    setNow(value: number) {
      now = value;
    },
    setModel(next: any) {
      ctx.model = next;
    },
  };
}

describe("/ollama-usage command and status lifecycle", () => {
  it("registers the command and shows a one-shot report", async () => {
    const { fetchUsage, harness, notifications, run, statuses } = setup();
    expect(harness.commands.has("ollama-usage")).toBe(true);
    await run("");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(notifications.at(-1)?.type).toBe("info");
    expect(notifications.at(-1)?.message).toContain("Session window (5h): 25% used");
    // default status on also updates footer from the one-shot
    expect(statuses.at(-1)?.key).toBe("pi-ollama-cloud-usage");
    expect(statuses.at(-1)?.text).toBe("Ollama 5h:25% Wk:50%");
  });

  it("validates arguments", async () => {
    const { notifications, run } = setup();
    await run("enable");
    expect(notifications.at(-1)?.message).toBe("Usage: /ollama-usage [status [on|off]]");
  });

  it("can disable and re-enable status", async () => {
    const state = setup();
    await state.run("status off");
    expect(state.statuses.at(-1)).toEqual({ key: "pi-ollama-cloud-usage", text: undefined });
    await state.run("status");
    expect(state.notifications.at(-1)?.message).toMatch(/status is off/);

    await state.run("status on");
    expect(state.fetchUsage).toHaveBeenCalled();
    expect(state.statuses.at(-1)?.text).toBe("Ollama 5h:25% Wk:50%");
  });

  it("clears status for non-ollama-cloud models but keeps preference", async () => {
    const state = setup();
    await state.feature.syncForModel(state.ctx);
    expect(state.statuses.at(-1)?.text).toBe("Ollama 5h:25% Wk:50%");

    state.setModel({ provider: "openrouter", id: "deepseek/deepseek-v4-flash" });
    await state.feature.syncForModel(state.ctx);
    expect(state.statuses.at(-1)).toEqual({ key: "pi-ollama-cloud-usage", text: undefined });
  });

  it("rate-limits refreshStatus after success", async () => {
    const state = setup();
    await state.feature.refreshStatus(state.ctx);
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(1);
    state.setNow(70_000);
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("retries promptly after a failed refresh", async () => {
    const state = setup();
    state.fetchUsage.mockRejectedValueOnce(new Error("timeout"));
    await state.feature.refreshStatus(state.ctx);
    expect(state.statuses.at(-1)).toEqual({ key: "pi-ollama-cloud-usage", text: undefined });
    await state.feature.refreshStatus(state.ctx);
    expect(state.fetchUsage).toHaveBeenCalledTimes(2);
    expect(state.statuses.at(-1)?.text).toBe("Ollama 5h:25% Wk:50%");
  });
});
