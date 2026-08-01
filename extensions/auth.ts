import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OLLAMA_CLOUD_PROVIDER_ID } from "./constants";

export interface OllamaCredential {
  kind: "api-key";
  key: string;
}

function extractApiKey(authLike: unknown): string | null {
  if (!authLike || typeof authLike !== "object") return null;
  const payload = authLike as { apiKey?: unknown; headers?: Record<string, string> };
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) return payload.apiKey.trim();
  const authorization =
    typeof payload.headers?.Authorization === "string" ? payload.headers.Authorization : "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim() || null
    : null;
}

/**
 * Accept both Pi AuthResult `{ auth: { apiKey, headers } }` and
 * getApiKeyAndHeaders `{ ok, apiKey, headers }`.
 */
export function keyFromAuthResolution(resolution: unknown): string | null {
  if (!resolution || typeof resolution !== "object") return null;
  const value = resolution as {
    ok?: boolean;
    auth?: unknown;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  // Pi ModelRuntime / getProviderAuth AuthResult
  if (value.auth && typeof value.auth === "object") {
    return extractApiKey(value.auth);
  }
  // getApiKeyAndHeaders result
  if ("ok" in value) {
    if (value.ok !== true) return null;
    return extractApiKey(value);
  }
  return extractApiKey(value);
}

async function resolveRegistryKey(ctx: any): Promise<string | null> {
  const registry = ctx?.modelRegistry;
  const modelRuntime = ctx?.modelRuntime;

  // Simplest and most direct: provider-level key resolution.
  if (registry && typeof registry.getApiKeyForProvider === "function") {
    try {
      const key = await registry.getApiKeyForProvider(OLLAMA_CLOUD_PROVIDER_ID);
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // Fall through to other resolution paths.
    }
  }
  if (modelRuntime && typeof modelRuntime.getAuth === "function") {
    try {
      const key = keyFromAuthResolution(await modelRuntime.getAuth(OLLAMA_CLOUD_PROVIDER_ID));
      if (key) return key;
    } catch {
      // Fall through.
    }
  }
  if (registry && typeof registry.getProviderAuth === "function") {
    try {
      const key = keyFromAuthResolution(
        await registry.getProviderAuth(OLLAMA_CLOUD_PROVIDER_ID),
      );
      if (key) return key;
    } catch {
      // Fall through.
    }
  }
  if (registry && typeof registry.getApiKeyAndHeaders === "function" && ctx?.model) {
    try {
      const key = keyFromAuthResolution(await registry.getApiKeyAndHeaders(ctx.model));
      if (key) return key;
    } catch {
      // Fall through.
    }
  }
  return null;
}

function readJsonFile(path: string): any | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function agentDir(): string {
  // Prefer PI_AGENT_DIR when set (tests / custom installs); otherwise ~/.pi/agent.
  const override = process.env.PI_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

/** Read the ollama-cloud API key from Pi's auth.json (same shape pi-ollama-cloud writes). */
export function readPiStoredApiKey(): string | null {
  const data = readJsonFile(join(agentDir(), "auth.json"));
  if (!data || typeof data !== "object") return null;
  const entry = (data as Record<string, unknown>)[OLLAMA_CLOUD_PROVIDER_ID];
  if (!entry || typeof entry !== "object") return null;
  const value = entry as { key?: unknown; apiKey?: unknown };
  const key = typeof value.key === "string" ? value.key : value.apiKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/** OLLAMA_API_KEY environment variable. */
export function readEnvApiKey(): string | null {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key ? key : null;
}

/** True when an Ollama Cloud API key is available (registry, env, or auth.json). */
export function hasOllamaKey(ctx: any): boolean {
  if (readEnvApiKey() || readPiStoredApiKey()) return true;
  try {
    const status = ctx?.modelRegistry?.getProviderAuthStatus?.(OLLAMA_CLOUD_PROVIDER_ID);
    return status?.configured === true;
  } catch {
    return false;
  }
}

/**
 * Resolve an Ollama Cloud API key for the usage surface.
 * Prefers pi's registry/runtime resolution, then OLLAMA_API_KEY, then auth.json.
 */
export async function resolveOllamaCredential(ctx: any): Promise<OllamaCredential | null> {
  const fromRegistry = await resolveRegistryKey(ctx);
  if (fromRegistry) return { kind: "api-key", key: fromRegistry };

  const fromEnv = readEnvApiKey();
  if (fromEnv) return { kind: "api-key", key: fromEnv };

  const fromFile = readPiStoredApiKey();
  if (fromFile) return { kind: "api-key", key: fromFile };

  return null;
}
