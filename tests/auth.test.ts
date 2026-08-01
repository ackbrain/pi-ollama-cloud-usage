import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasOllamaKey,
  keyFromAuthResolution,
  readEnvApiKey,
  readPiStoredApiKey,
  resolveOllamaCredential,
} from "../extensions/auth";

const cleanupDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ollama-usage-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PI_AGENT_DIR;
  delete process.env.OLLAMA_API_KEY;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("keyFromAuthResolution", () => {
  it("parses getApiKeyAndHeaders shape", () => {
    expect(keyFromAuthResolution({ ok: true, apiKey: "ok-key" })).toBe("ok-key");
    expect(keyFromAuthResolution({ ok: false, apiKey: "ok-key" })).toBeNull();
    expect(
      keyFromAuthResolution({
        ok: true,
        headers: { Authorization: "Bearer header-key" },
      }),
    ).toBe("header-key");
  });

  it("parses Pi AuthResult shape", () => {
    expect(keyFromAuthResolution({ auth: { apiKey: "auth-key" } })).toBe("auth-key");
    expect(
      keyFromAuthResolution({
        auth: { headers: { Authorization: "Bearer header-key-2" } },
      }),
    ).toBe("header-key-2");
  });
});

describe("file-based API key", () => {
  it("reads ollama-cloud key from Pi auth.json", () => {
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "ollama-cloud": { type: "api_key", key: "ollama-key" } }),
    );
    expect(readPiStoredApiKey()).toBe("ollama-key");
  });

  it("returns null when auth.json has no ollama-cloud entry", () => {
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk" } }));
    expect(readPiStoredApiKey()).toBeNull();
  });
});

describe("environment API key", () => {
  it("reads OLLAMA_API_KEY", () => {
    process.env.OLLAMA_API_KEY = "env-key";
    expect(readEnvApiKey()).toBe("env-key");
    expect(hasOllamaKey({})).toBe(true);
  });

  it("is null when unset", () => {
    expect(readEnvApiKey()).toBeNull();
  });
});

describe("hasOllamaKey", () => {
  it("honors registry auth status", () => {
    const ctx = {
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      },
    };
    expect(hasOllamaKey(ctx)).toBe(true);
  });

  it("is false when the registry reports no configured auth", () => {
    // Isolate from any real machine key in ~/.pi/agent/auth.json.
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(join(dir, "auth.json"), "{}");
    const ctx = {
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: false }),
      },
    };
    expect(hasOllamaKey(ctx)).toBe(false);
  });
});

describe("resolveOllamaCredential", () => {
  it("prefers registry getApiKeyForProvider", async () => {
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: async () => "registry-key",
      },
    };
    await expect(resolveOllamaCredential(ctx)).resolves.toEqual({
      kind: "api-key",
      key: "registry-key",
    });
  });

  it("falls back to modelRuntime.getAuth AuthResult", async () => {
    const ctx = {
      modelRuntime: {
        getAuth: async () => ({ auth: { apiKey: "runtime-key" } }),
      },
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    };
    await expect(resolveOllamaCredential(ctx)).resolves.toEqual({
      kind: "api-key",
      key: "runtime-key",
    });
  });

  it("falls back to auth.json when registry returns nothing", async () => {
    const dir = tempDir();
    process.env.PI_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "ollama-cloud": { type: "api_key", key: "file-key" } }),
    );
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    };
    await expect(resolveOllamaCredential(ctx)).resolves.toEqual({
      kind: "api-key",
      key: "file-key",
    });
    expect(hasOllamaKey(ctx)).toBe(true);
  });

  it("returns null when nothing is configured", async () => {
    process.env.PI_AGENT_DIR = tempDir();
    writeFileSync(join(process.env.PI_AGENT_DIR, "auth.json"), "{}");
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    };
    await expect(resolveOllamaCredential(ctx)).resolves.toBeNull();
    expect(hasOllamaKey(ctx)).toBe(false);
  });
});
