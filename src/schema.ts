import { log, logError } from "./ui.js";

export interface GameCommandInfo {
  name: string;
  description: string;
  isMutation: boolean;
}

/**
 * Fetch the OpenAPI spec from the gameserver and extract command names
 * and short descriptions. Returns a compact summary instead of full
 * tool schemas to save tokens.
 */
export async function fetchGameCommands(baseUrl: string): Promise<GameCommandInfo[]> {
  // baseUrl is like https://game.spacemolt.com/api/v2
  // OpenAPI spec is at   https://game.spacemolt.com/api/v2/openapi.json
  const specUrl = baseUrl.replace(/\/?$/, "/openapi.json");

  let spec: any;
  try {
    const resp = await fetch(specUrl, { headers: { 'User-Agent': 'SpaceMolt-Commander' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    spec = await resp.json();
  } catch (err) {
    logError(`Failed to fetch OpenAPI spec from ${specUrl}: ${err instanceof Error ? err.message : err}`);
    log("system", "Falling back to empty command list — agent can use get_commands at runtime");
    return [];
  }

  const paths: Record<string, any> = spec.paths ?? {};
  const commands: GameCommandInfo[] = [];
  // v2 base prefix to strip from paths (e.g. "/api/v2")
  const v2Prefix = new URL(baseUrl).pathname.replace(/\/?$/, "");

  for (const [path, methods] of Object.entries(paths)) {
    const op = methods?.post;
    if (!op) continue;

    // Skip session, notifications, agentlogs — handled internally
    if (path.endsWith("/session") || path.endsWith("/notifications") || path.endsWith("/agentlogs")) continue;

    // Extract the tool/action path relative to the v2 base
    // e.g. "/api/v2/spacemolt/mine" → "spacemolt/mine"
    const relPath = path.startsWith(v2Prefix) ? path.slice(v2Prefix.length + 1) : path;
    if (!relPath) continue;

    const isMutation = !!op["x-is-mutation"];
    const description = op.summary || relPath;

    commands.push({ name: relPath, description, isMutation });
  }

  log("system", `Loaded ${commands.length} game commands from v2 OpenAPI spec`);
  return commands;
}

/**
 * Format commands as a compact pipe-separated list for the system prompt.
 * Queries and mutations are separated for clarity.
 */
export function formatCommandList(commands: GameCommandInfo[]): string {
  const queries = commands.filter(c => !c.isMutation).map(c => c.name);
  const mutations = commands.filter(c => c.isMutation).map(c => c.name);

  const lines: string[] = [];
  if (queries.length > 0) {
    lines.push(`Query commands (free, no tick cost): ${queries.join("|")}`);
  }
  if (mutations.length > 0) {
    lines.push(`Action commands (costs 1 tick): ${mutations.join("|")}`);
  }
  return lines.join("\n");
}
