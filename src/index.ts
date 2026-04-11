import type { Plugin } from "@opencode-ai/plugin";

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

  return {
    // Hooks, tools, and events will be added in later units:
    // - Unit 2: system prompt injection (experimental.chat.system.transform)
    // - Unit 3: git integration
    // - Unit 4: session tracking + obligations (tool.execute.after, event)
    // - Unit 5: custom tools (context_checkpoint, context_load, context_discover)
    // - Unit 6: session lifecycle (experimental.session.compacting, event)
  };
};

export default ContextGuardPlugin;
