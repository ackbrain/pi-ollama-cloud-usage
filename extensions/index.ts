import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUsage } from "./usage";

/**
 * Shows Ollama Cloud quota usage (5-hour session and weekly windows) in the
 * Pi status line, using the authenticated GET https://ollama.com/api/usage
 * surface with the Ollama Cloud API key (pi auth.json `ollama-cloud` entry,
 * OLLAMA_API_KEY env, or the model registry).
 *
 * Status is on by default for ollama-cloud models. Control with:
 *   /ollama-usage
 *   /ollama-usage status on|off
 */
export default function (pi: ExtensionAPI) {
  const usage = registerUsage(pi);

  pi.on("session_start", (_event, ctx) => {
    // Footer is cosmetic — never block session startup.
    void usage.syncForModel(ctx).catch(() => undefined);
  });

  pi.on("model_select", (_event, ctx) => {
    void usage.syncForModel(ctx).catch(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    // Refresh after completed turns, rate-limited inside the feature.
    void usage.refreshStatus(ctx).catch(() => undefined);
  });

  pi.on("agent_settled", (_event, ctx) => {
    void usage.refreshStatus(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    usage.reset(ctx);
  });
}
