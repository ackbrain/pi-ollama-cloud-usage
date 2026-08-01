import packageMetadata from "../package.json";

/** Ollama Cloud quota surface: authenticated GET /api/usage (Bearer API key). */
export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";

/** Provider id registered by pi-ollama-cloud for Ollama Cloud models. */
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud" as const;
export type OllamaCloudProviderId = typeof OLLAMA_CLOUD_PROVIDER_ID;

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

export const USAGE_TIMEOUT_MS = 15_000;
export const USAGE_MAX_RESPONSE_BYTES = 64 * 1024;
export const USAGE_MAX_JSON_DEPTH = 12;
export const USAGE_MAX_JSON_ARRAY_ITEMS = 128;
export const USAGE_MAX_JSON_OBJECT_KEYS = 64;
export const USAGE_MAX_JSON_NODES = 4096;
export const USAGE_MAX_MODEL_BREAKDOWN = 64;
export const USAGE_STATUS_MIN_REFRESH_MS = 60_000;

/** Sorts near pi-grok-usage in Pi's alphabetical status line. */
export const STATUS_KEY = "pi-ollama-cloud-usage";
export const COMMAND_HELP = "Usage: /ollama-usage [status [on|off]]";

export function isOllamaCloudProvider(provider: unknown): provider is OllamaCloudProviderId {
  return provider === OLLAMA_CLOUD_PROVIDER_ID;
}
