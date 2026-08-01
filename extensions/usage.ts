import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { hasOllamaKey, resolveOllamaCredential, type OllamaCredential } from "./auth";
import {
  COMMAND_HELP,
  isOllamaCloudProvider,
  OLLAMA_USAGE_URL,
  PACKAGE_VERSION,
  STATUS_KEY,
  USAGE_MAX_JSON_ARRAY_ITEMS,
  USAGE_MAX_JSON_DEPTH,
  USAGE_MAX_JSON_NODES,
  USAGE_MAX_JSON_OBJECT_KEYS,
  USAGE_MAX_MODEL_BREAKDOWN,
  USAGE_MAX_RESPONSE_BYTES,
  USAGE_STATUS_MIN_REFRESH_MS,
  USAGE_TIMEOUT_MS,
  USER_AGENT,
} from "./constants";

export interface UsageModelBreakdown {
  name?: string;
  requestCount?: number;
}

export interface UsageWindow {
  /** Quota fraction used: 0.98 = 98%. Absent when the window is not reported. */
  usageFraction?: number;
  models: UsageModelBreakdown[];
}

export interface UsagePeriod {
  type?: string;
  startingAt?: string;
  endingAt?: string;
}

export interface UsageSnapshot {
  cost?: string;
  period?: UsagePeriod;
  session: UsageWindow;
  weekly: UsageWindow;
}

type UsageErrorCode =
  | "auth"
  | "cancelled"
  | "http"
  | "invalid"
  | "oversize"
  | "timeout"
  | "transport";

export class UsageError extends Error {
  readonly code: UsageErrorCode;
  readonly status?: number;

  constructor(code: UsageErrorCode, message: string, status?: number) {
    super(message);
    this.name = "UsageError";
    this.code = code;
    this.status = status;
  }
}

const MAX_LABEL_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_COST_LENGTH = 32;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

interface JsonBudget {
  nodes: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertBoundedJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0 }): void {
  if (depth > USAGE_MAX_JSON_DEPTH || ++budget.nodes > USAGE_MAX_JSON_NODES) {
    throw new UsageError("invalid", "Ollama usage returned an over-complex response.");
  }
  if (Array.isArray(value)) {
    if (value.length > USAGE_MAX_JSON_ARRAY_ITEMS) {
      throw new UsageError("invalid", "Ollama usage returned too many response entries.");
    }
    for (const item of value) assertBoundedJson(item, depth + 1, budget);
    return;
  }
  const obj = objectValue(value);
  if (!obj) return;
  const values = Object.values(obj);
  if (values.length > USAGE_MAX_JSON_OBJECT_KEYS) {
    throw new UsageError("invalid", "Ollama usage returned too many response fields.");
  }
  for (const item of values) assertBoundedJson(item, depth + 1, budget);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/.test(label)
    ? label
    : undefined;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = value.match(RFC3339_PATTERN);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

/**
 * The API reports usage as a fraction (0.98 = 98%). Tolerate a defensive
 * percent-style value (98) as well, in case the contract shifts.
 */
function boundedUsageFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
  return value <= 1 ? value : value / 100;
}

function boundedRequestCount(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function modelBreakdown(value: unknown): UsageModelBreakdown | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: UsageModelBreakdown = {};
  const name = boundedLabel(obj.name);
  const requestCount = boundedRequestCount(obj.request_count);
  if (name) result.name = name;
  if (requestCount !== undefined) result.requestCount = requestCount;
  return Object.keys(result).length > 0 ? result : undefined;
}

function usageWindow(value: unknown): UsageWindow | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: UsageWindow = { models: [] };
  const usage = boundedUsageFraction(obj.usage);
  if (usage !== undefined) result.usageFraction = usage;
  const models = obj.models;
  if (models !== undefined && !Array.isArray(models)) {
    throw new UsageError("invalid", "Ollama usage returned an invalid limits window.");
  }
  if (Array.isArray(models)) {
    if (models.length > USAGE_MAX_MODEL_BREAKDOWN) {
      throw new UsageError("invalid", "Ollama usage returned too many model entries.");
    }
    result.models = models
      .map(modelBreakdown)
      .filter((entry): entry is UsageModelBreakdown => entry !== undefined);
  }
  return Object.keys(result).length > 0 || result.models.length > 0 ? result : undefined;
}

function usagePeriod(value: unknown): UsagePeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: UsagePeriod = {};
  const type = boundedLabel(obj.type);
  const startingAt = boundedTimestamp(obj.starting_at);
  const endingAt = boundedTimestamp(obj.ending_at);
  if (type) result.type = type;
  if (startingAt) result.startingAt = startingAt;
  if (endingAt) result.endingAt = endingAt;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseUsage(value: unknown): UsageSnapshot {
  assertBoundedJson(value);
  const root = objectValue(value);
  if (!root) throw new UsageError("invalid", "Ollama usage returned an invalid response.");

  const snapshot: UsageSnapshot = { session: { models: [] }, weekly: { models: [] } };

  const activity = objectValue(root.activity);
  if (activity) {
    const cost = boundedLabel(activity.cost);
    if (cost && cost.length <= MAX_COST_LENGTH && /^[0-9.]{1,20}$/.test(cost)) {
      snapshot.cost = cost;
    }
    const period = usagePeriod(activity.period);
    if (period) snapshot.period = period;
  }

  const limits = objectValue(root.limits);
  if (!limits) {
    // limits may be missing entirely (e.g. API drift); windows stay empty.
    return snapshot;
  }

  const session = usageWindow(limits.session);
  const weekly = usageWindow(limits.weekly);
  if (session) snapshot.session = session;
  if (weekly) snapshot.weekly = weekly;
  return snapshot;
}

function usageHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-ollama-client-version": PACKAGE_VERSION,
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const abortError = () => new DOMException("The operation was cancelled.", "AbortError");
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(signal.reason ?? abortError());
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // best-effort
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason ?? abortError();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > USAGE_MAX_RESPONSE_BYTES) {
        cancelReader();
        throw new UsageError("oversize", "Ollama usage returned an oversized response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("invalid", "Ollama usage returned an invalid response body.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function httpError(status: number): UsageError {
  if (status === 401 || status === 403) {
    return new UsageError(
      "auth",
      "Ollama Cloud authentication was rejected. Check your API key (auth.json ollama-cloud / OLLAMA_API_KEY).",
      status,
    );
  }
  if (status === 404 || (status >= 300 && status < 400)) {
    return new UsageError("http", "The Ollama usage contract is unavailable.", status);
  }
  if (status === 429) {
    return new UsageError("http", "Ollama usage is rate limited. Try again later.", status);
  }
  return new UsageError("http", `Ollama usage request failed with status ${status}.`, status);
}

async function requestBoundedJson(
  url: string,
  credential: OllamaCredential,
  signal?: AbortSignal,
): Promise<unknown> {
  if (credential.kind !== "api-key" || !credential.key) {
    throw new UsageError(
      "auth",
      "An Ollama Cloud API key is required. Run /login ollama-cloud or set OLLAMA_API_KEY.",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, USAGE_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: usageHeaders(credential.key),
      });
    } catch {
      if (signal?.aborted) throw new UsageError("cancelled", "Ollama usage request was cancelled.");
      if (timedOut) throw new UsageError("timeout", "Ollama usage request timed out.");
      throw new UsageError("transport", "Ollama usage request failed.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    let body: string;
    try {
      body = await readBoundedBody(response, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw new UsageError("cancelled", "Ollama usage request was cancelled.");
      if (timedOut) throw new UsageError("timeout", "Ollama usage request timed out.");
      if (error instanceof UsageError) throw error;
      throw new UsageError("transport", "Ollama usage request failed.");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new UsageError("invalid", "Ollama usage returned malformed JSON.");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** GET https://ollama.com/api/usage with the resolved Ollama Cloud API key. */
export async function fetchUsage(
  credential: OllamaCredential,
  signal?: AbortSignal,
): Promise<UsageSnapshot> {
  const payload = await requestBoundedJson(OLLAMA_USAGE_URL, credential, signal);
  return parseUsage(payload);
}

function formatPercent(value: number): string {
  return `${Number((value * 100).toFixed(1))}%`;
}

/** Quota used as a percentage (0–100), when the window is reported. */
export function usedPercent(usage: UsageWindow | undefined): number | undefined {
  return usage?.usageFraction === undefined
    ? undefined
    : usage.usageFraction * 100;
}

/** Quota remaining as a percentage (0–100), when the window is reported. */
export function remainingPercent(usage: UsageWindow | undefined): number | undefined {
  const used = usedPercent(usage);
  return used === undefined ? undefined : Math.max(0, 100 - used);
}

function formatModelBreakdown(window: UsageWindow): string[] {
  return window.models.map((model) => {
    const label = model.name ?? "unknown";
    const count = model.requestCount === undefined ? "" : ` (${model.requestCount} requests)`;
    return `  ${label}${count}`;
  });
}

/** Full readable local timestamp (e.g. `Jul 6, 2026, 8:00 AM`). */
export function formatReadableLocal(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Full multi-line report for `/ollama-usage`. */
export function renderUsage(usage: UsageSnapshot): string {
  const lines = ["Ollama Cloud usage:"];

  const sessionUsed = usedPercent(usage.session);
  const sessionRemaining = remainingPercent(usage.session);
  if (sessionUsed !== undefined) {
    lines.push(`Session window (5h): ${formatPercent(sessionUsed / 100)} used`);
    if (sessionRemaining !== undefined) {
      lines.push(`Session remaining: ${formatPercent(sessionRemaining / 100)}`);
    }
  }
  lines.push(...formatModelBreakdown(usage.session));

  const weeklyUsed = usedPercent(usage.weekly);
  const weeklyRemaining = remainingPercent(usage.weekly);
  if (weeklyUsed !== undefined) {
    lines.push(`Weekly window (7d): ${formatPercent(weeklyUsed / 100)} used`);
    if (weeklyRemaining !== undefined) {
      lines.push(`Weekly remaining: ${formatPercent(weeklyRemaining / 100)}`);
    }
  }
  lines.push(...formatModelBreakdown(usage.weekly));

  if (usage.cost !== undefined) {
    lines.push(`Activity cost (${usage.period?.type ?? "last 4 weeks"}): $${usage.cost}`);
  }
  if (usage.period?.startingAt) {
    const start = formatReadableLocal(usage.period.startingAt) ?? usage.period.startingAt;
    lines.push(`Period start: ${start}`);
  }

  if (lines.length === 1) lines.push("No supported usage fields were returned.");
  return lines.join("\n");
}

/** Compact footer status: `Ollama 5h:98% Wk:98.3%`. */
export function renderUsageStatus(usage: UsageSnapshot): string {
  const parts: string[] = [];
  const sessionUsed = usedPercent(usage.session);
  const weeklyUsed = usedPercent(usage.weekly);
  if (sessionUsed !== undefined) {
    parts.push(`5h:${formatPercent(sessionUsed / 100)}`);
  }
  if (weeklyUsed !== undefined) {
    parts.push(`Wk:${formatPercent(weeklyUsed / 100)}`);
  }
  if (parts.length === 0) {
    if (usage.cost !== undefined) {
      return `Ollama $${usage.cost}`;
    }
    return "Ollama ok";
  }
  return `Ollama ${parts.join(" ")}`;
}

export interface UsageFeature {
  reset(ctx?: any): void;
  syncForModel(ctx: any): Promise<void>;
  refreshStatus(ctx: any): Promise<void>;
}

interface UsageDependencies {
  resolveCredential: typeof resolveOllamaCredential;
  fetchUsage: typeof fetchUsage;
  now: () => number;
  minimumRefreshMs: number;
  /** When true, status auto-enables on Ollama Cloud models (package default). */
  defaultStatusOn: boolean;
}

function safeUsageError(error: unknown): UsageError {
  return error instanceof UsageError
    ? error
    : new UsageError("transport", "Ollama usage request failed.");
}

/** Register `/ollama-usage` and session status lifecycle. */
export function registerUsage(
  pi: ExtensionAPI,
  overrides: Partial<UsageDependencies> = {},
): UsageFeature {
  const dependencies: UsageDependencies = {
    resolveCredential: overrides.resolveCredential ?? resolveOllamaCredential,
    fetchUsage: overrides.fetchUsage ?? fetchUsage,
    now: overrides.now ?? Date.now,
    minimumRefreshMs: overrides.minimumRefreshMs ?? USAGE_STATUS_MIN_REFRESH_MS,
    defaultStatusOn: overrides.defaultStatusOn ?? true,
  };

  let statusEnabled = dependencies.defaultStatusOn;
  let lastRefreshAt = 0;
  let generation = 0;
  let lastUi: ExtensionUIContext | undefined;
  let statusController: AbortController | undefined;
  let oneShotController: AbortController | undefined;
  let oneShotGeneration = 0;
  let refreshPromise: Promise<{ ok: boolean; error?: UsageError }> | undefined;

  const clear = (ctx?: any) => {
    const ui = ctx?.ui ?? lastUi;
    try {
      ui?.setStatus(STATUS_KEY, undefined);
    } catch {
      // cosmetic only
    }
    lastUi = ctx?.ui;
  };

  const reset = (ctx?: any, keepEnabled = false) => {
    if (!keepEnabled) statusEnabled = false;
    lastRefreshAt = 0;
    generation++;
    oneShotGeneration++;
    statusController?.abort();
    oneShotController?.abort();
    statusController = undefined;
    oneShotController = undefined;
    refreshPromise = undefined;
    clear(ctx);
  };

  const resolveUsage = async (ctx: any, signal?: AbortSignal) => {
    let credential: OllamaCredential | null;
    try {
      credential = await dependencies.resolveCredential(ctx);
    } catch {
      throw new UsageError(
        "auth",
        "An Ollama Cloud API key could not be resolved. Run /login ollama-cloud or set OLLAMA_API_KEY.",
      );
    }
    if (!credential) {
      throw new UsageError(
        "auth",
        "An Ollama Cloud API key is required. Run /login ollama-cloud or set OLLAMA_API_KEY.",
      );
    }
    return dependencies.fetchUsage(credential, signal);
  };

  const updateStatus = async (
    ctx: any,
    force: boolean,
  ): Promise<{ ok: boolean; error?: UsageError }> => {
    lastUi = ctx.ui;
    if (!statusEnabled || !isOllamaCloudProvider(ctx.model?.provider)) {
      clear(ctx);
      return { ok: false };
    }
    if (!hasOllamaKey(ctx)) {
      // Keep enabled preference, but hide status until a key is available.
      clear(ctx);
      return { ok: false };
    }
    const now = dependencies.now();
    // Rate-limit only after a successful refresh so failures can retry promptly.
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < dependencies.minimumRefreshMs) {
      return { ok: true };
    }
    if (refreshPromise) return refreshPromise;
    const refreshGeneration = generation;
    const controller = new AbortController();
    statusController = controller;
    const pending = (async () => {
      try {
        const usage = await resolveUsage(ctx, controller.signal);
        if (
          refreshGeneration === generation
          && statusEnabled
          && isOllamaCloudProvider(ctx.model?.provider)
          && !controller.signal.aborted
        ) {
          ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(usage));
          lastRefreshAt = dependencies.now();
        }
        return { ok: true };
      } catch (error) {
        const safeError = safeUsageError(error);
        if (refreshGeneration === generation) {
          clear(ctx);
        }
        return { ok: false, error: safeError };
      } finally {
        if (statusController === controller) statusController = undefined;
      }
    })();
    refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (refreshPromise === pending) refreshPromise = undefined;
    }
  };

  pi.registerCommand("ollama-usage", {
    description: "Show Ollama Cloud quota usage or manage the status-line indicator",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean).map((part) => part.toLowerCase());
      if (parts.length === 0) {
        oneShotController?.abort();
        const controller = new AbortController();
        oneShotController = controller;
        const requestGeneration = ++oneShotGeneration;
        const sessionGeneration = generation;
        const forwardAbort = () => controller.abort();
        ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
        if (ctx.signal?.aborted) controller.abort();
        try {
          const usage = await resolveUsage(ctx, controller.signal);
          if (requestGeneration === oneShotGeneration && sessionGeneration === generation) {
            ctx.ui.notify(renderUsage(usage), "info");
            if (statusEnabled && isOllamaCloudProvider(ctx.model?.provider)) {
              ctx.ui.setStatus(STATUS_KEY, renderUsageStatus(usage));
              lastRefreshAt = dependencies.now();
            }
          }
        } catch (error) {
          if (requestGeneration === oneShotGeneration && sessionGeneration === generation) {
            ctx.ui.notify(safeUsageError(error).message, "error");
          }
        } finally {
          ctx.signal?.removeEventListener("abort", forwardAbort);
          if (oneShotController === controller) oneShotController = undefined;
        }
        return;
      }
      if (
        parts[0] !== "status"
        || parts.length > 2
        || (parts[1] && !["on", "off"].includes(parts[1]))
      ) {
        ctx.ui.notify(COMMAND_HELP, "error");
        return;
      }
      if (!parts[1]) {
        ctx.ui.notify(`Ollama usage status is ${statusEnabled ? "on" : "off"}.`, "info");
        return;
      }
      if (parts[1] === "off") {
        reset(ctx, false);
        ctx.ui.notify("Ollama usage status is off.", "info");
        return;
      }
      statusEnabled = true;
      lastRefreshAt = 0;
      if (!isOllamaCloudProvider(ctx.model?.provider)) {
        clear(ctx);
        ctx.ui.notify(
          "Ollama usage status is on. Select an Ollama Cloud model to show the status line.",
          "info",
        );
        return;
      }
      const result = await updateStatus(ctx, true);
      if (result.ok) {
        ctx.ui.notify("Ollama usage status is on.", "info");
      } else {
        ctx.ui.notify(
          result.error?.message ?? "Ollama usage status could not be refreshed.",
          "error",
        );
      }
    },
  });

  return {
    reset: (ctx) => reset(ctx, false),
    async syncForModel(ctx) {
      if (!statusEnabled) {
        clear(ctx);
        return;
      }
      if (!isOllamaCloudProvider(ctx.model?.provider)) {
        clear(ctx);
        return;
      }
      lastRefreshAt = 0;
      await updateStatus(ctx, true);
    },
    async refreshStatus(ctx) {
      if (!statusEnabled) return;
      await updateStatus(ctx, false);
    },
  };
}
