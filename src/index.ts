import type { Plugin } from "@opencode-ai/plugin";

import { createContextGuard } from "./context-guard.js";
import { readState, resolveConfig } from "./state-reader.js";
import type { PluginConfig } from "./state-reader.js";

/**
 * OpenCode Context Guard plugin.
 *
 * Enforces context management at the hook level — STATE.md injection,
 * planning artifact awareness, git status, obligation tracking, and
 * session lifecycle management.
 */
export const ContextGuardPlugin: Plugin = async (ctx, options) => {
  const repoRoot = ctx.directory;
  const config: PluginConfig = resolveConfig(options as Partial<PluginConfig> | undefined);

  // Initial STATE.md read — warms the cache
  readState(repoRoot, config);

  // Diagnostic: log on init so --print-logs confirms plugin is loading
  void ctx.client.app.log({ body: { service: "context-guard", level: "info", message: `context-guard loaded (repoRoot: ${repoRoot})` } });

  const guard = createContextGuard(ctx, repoRoot, config);

  return {
    ...guard.hooks,
    event: guard.event,
    tool: guard.tools,
  };
};

export default ContextGuardPlugin;
