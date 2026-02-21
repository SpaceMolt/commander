import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Context, Message } from "@mariozechner/pi-ai";
import { resolveModel } from "./model.js";
import { SpaceMoltAPI } from "./api.js";
import { SessionManager } from "./session.js";
import { allTools } from "./tools.js";
import { fetchGameCommands, formatCommandList } from "./schema.js";
import { runAgentTurn, generateSessionHandoff, type CompactionState } from "./loop.js";
import { log, logError, setDebug, logNotifications, formatNotifications } from "./ui.js";
import { resolveProjectRoot } from "./paths.js";
import DEFAULT_PROMPT from "../prompt.md" with { type: "text" };

// Resolve project root safely. In compiled binaries on Windows, Bun.main may
// return a virtual path like "/" which breaks path resolution. resolveProjectRoot
// handles this by preferring process.execPath and falling back to process.cwd().
const PROJECT_ROOT = resolveProjectRoot(Bun.main, process.execPath, process.cwd());
const TURN_INTERVAL = 2000; // ms between turns

function printUsage(): void {
  console.log(`
SpaceMolt AI Commander

Usage:
  ./commander --model <provider/model-id> [options] <instruction>

Options:
  --model <id>     LLM model (e.g. ollama/qwen3:8b, anthropic/claude-sonnet-4-20250514)
  --session <name> Session name for credentials/state (default: "default")
  --url <url>      SpaceMolt API URL (default: production server)
  --file <path>    Read instruction from a file instead of command line
  --force-credentials  Allow overwriting existing credentials in this session
  --debug          Show LLM call details (token counts, retries, etc.)

Examples:
  ./commander --model ollama/qwen3:8b "mine ore and sell it until you can buy a better ship"
  ./commander --model ollama/qwen3:8b -f mission.txt
  ./commander --model anthropic/claude-sonnet-4-20250514 --session explorer "explore unknown systems"

Free via OpenRouter (no credits needed):
  OPENROUTER_API_KEY=sk-or-... ./commander --model openrouter/free "mine ore"

Custom OpenAI-compatible endpoint:
  OPENAI_COMPAT_BASE_URL=https://my-server/v1 OPENAI_COMPAT_API_KEY=sk-... \\
    ./commander --model custom/my-model "mine ore"

Running from source (requires Bun):
  bun run src/commander.ts --model ollama/qwen3:8b "mine ore and sell it"
`);
}

// ─── CLI Parsing ─────────────────────────────────────────────

interface CLIArgs {
  model: string;
  session: string;
  url?: string;
  debug: boolean;
  forceCredentials: boolean;
  instruction: string;
}

function parseArgs(argv: string[]): CLIArgs | null {
  const args = argv.slice(2); // skip bun and script path
  let model = "";
  let session = "default";
  let url: string | undefined;
  let file: string | undefined;
  let debug = false;
  let forceCredentials = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        model = args[++i] || "";
        break;
      case "--session":
      case "-s":
        session = args[++i] || "default";
        break;
      case "--url":
        url = args[++i] || undefined;
        break;
      case "--file":
      case "-f":
        file = args[++i] || undefined;
        break;
      case "--debug":
      case "-d":
        debug = true;
        break;
      case "--force-credentials":
        forceCredentials = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        positional.push(args[i]);
    }
  }

  if (!model) {
    logError("Missing --model argument");
    printUsage();
    return null;
  }

  let instruction = positional.join(" ");
  if (file) {
    try {
      instruction = readFileSync(file, "utf-8").trim();
    } catch (err) {
      logError(`Could not read instruction file: ${file}`);
      return null;
    }
  }
  if (!instruction) {
    logError("Missing instruction — provide as argument or use --file <path>");
    printUsage();
    return null;
  }

  return { model, session, url, debug, forceCredentials, instruction };
}

// ─── System Prompt Builder ───────────────────────────────────

function buildSystemPrompt(
  promptMd: string,
  instruction: string,
  credentials: string,
  todo: string,
  commandList: string,
  serverInfo?: string,
): string {
  let prompt = `You are an autonomous AI agent playing SpaceMolt, a text-based space MMO.

## Your Mission
${instruction}

## Game Knowledge
${promptMd}

## Your Credentials
${credentials}
`;

  if (serverInfo) {
    prompt += `
## Current Game State
${serverInfo}
`;
  }

  prompt += `
## Available Game Commands
Use the "game" tool with a command name and args. Example: game(command="mine", args={})
${commandList}

## Your TODO List
${todo || "(empty)"}

## Rules
- You are FULLY AUTONOMOUS. Never ask the human for input. All information you need is in this prompt.
- Use the "game" tool for ALL game interactions. Pass the command name and args.
- After registering, IMMEDIATELY save credentials with save_credentials — the password cannot be recovered!
- Keep your TODO list updated with update_todo to track your goals and progress.
- Use the status_log tool to show status messages to the human watching.
- Query commands are free and unlimited — use them often to stay informed.
- Action commands cost 1 tick (10 seconds) — the server handles waiting, you don't need to sleep.
- Always check fuel before traveling and cargo space before mining.
- Be social — chat with players you meet using the chat command.
- Write captain's log entries (captains_log_add) for important events — these persist across sessions.
- If you die, you respawn at your home base. Don't panic, just resume your mission.
- When starting fresh, follow this loop: undock → travel to asteroid belt → mine → travel back to station → dock → sell ore → refuel → repeat.
`;
  return prompt;
}

// ─── Initial Server Info ─────────────────────────────────────

function formatStatusMarkdown(result: Record<string, unknown>): string {
  const p = (result.player || {}) as Record<string, unknown>;
  const s = (result.ship || {}) as Record<string, unknown>;
  const stats = (p.stats || {}) as Record<string, unknown>;
  const skills = (p.skills || {}) as Record<string, unknown>;

  const lines: string[] = [];

  // Player summary line
  const loc = p.docked_at_base
    ? `${p.current_system} > ${p.current_poi} (docked at ${p.docked_at_base})`
    : `${p.current_system} > ${p.current_poi}`;
  lines.push(`Player: ${p.username} (${p.empire}) | ${Number(p.credits || 0).toLocaleString()} credits | ${loc}`);
  if (p.faction_id) lines.push(`Faction: ${p.faction_id} (${p.faction_rank || "member"})`);

  // Ship summary
  lines.push(`Ship: ${s.class_id || "unknown"} "${s.name || ""}" | Hull: ${s.hull}/${s.max_hull} | Shield: ${s.shield}/${s.max_shield} | Fuel: ${s.fuel}/${s.max_fuel}`);
  lines.push(`Cargo: ${s.cargo_used}/${s.cargo_capacity} | CPU: ${s.cpu_used}/${s.cpu_capacity} | Power: ${s.power_used}/${s.power_capacity}`);

  // Modules
  const modules = s.modules as string[] | undefined;
  if (modules && modules.length > 0) {
    lines.push(`Modules: ${modules.join(", ")}`);
  }

  // Cargo items
  const cargo = s.cargo as Array<{ item_id: string; quantity: number }> | undefined;
  if (cargo && cargo.length > 0) {
    lines.push(`Cargo items: ${cargo.map(c => `${c.item_id}: ${c.quantity}`).join(", ")}`);
  }

  // Skills (compact)
  const skillEntries = Object.entries(skills);
  if (skillEntries.length > 0) {
    lines.push(`Skills: ${skillEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  // Stats (compact, only non-zero)
  const statEntries = Object.entries(stats).filter(([, v]) => v && v !== 0);
  if (statEntries.length > 0) {
    lines.push(`Stats: ${statEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  return lines.join("\n");
}

async function fetchInitialServerInfo(api: SpaceMoltAPI): Promise<string> {
  const parts: string[] = [];

  // Fetch status (triggers session creation + auto-login)
  try {
    const statusResp = await api.execute("get_status");
    if (!statusResp.error && statusResp.result) {
      parts.push("Ship Status:\n" + formatStatusMarkdown(statusResp.result as Record<string, unknown>));
    }
  } catch {
    // Non-fatal — agent can query status itself
  }

  // Fetch most recent captain's log entry only
  try {
    const logResp = await api.execute("captains_log_get", { index: 0 });
    if (!logResp.error && logResp.result) {
      const entry = logResp.result as Record<string, unknown>;
      if (entry.entry) {
        parts.push(`Last Captain's Log (${entry.created_at || "unknown date"}):\n${entry.entry}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Fetch version/release notes
  try {
    const versionResp = await api.execute("get_version");
    if (!versionResp.error && versionResp.result) {
      const v = versionResp.result as Record<string, unknown>;
      const notes = Array.isArray(v.notes) ? v.notes.map((n: string) => `- ${n}`).join("\n") : "";
      parts.push(`Game v${v.version || "?"} (${v.release_date || "?"})\n${notes}`);
    }
  } catch {
    // Non-fatal
  }

  return parts.join("\n\n");
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv);
  if (!cliArgs) process.exit(1);

  if (cliArgs.debug) setDebug(true);

  log("setup", `SpaceMolt AI Commander starting...`);
  log("setup", `Model: ${cliArgs.model}`);
  log("setup", `Session: ${cliArgs.session}`);
  log("setup", `Instruction: ${cliArgs.instruction}`);

  // Load prompt: try external file first (for user customization), then use built-in default
  let promptMd: string;
  const promptPath = join(PROJECT_ROOT, "prompt.md");
  if (existsSync(promptPath)) {
    promptMd = readFileSync(promptPath, "utf-8");
    log("setup", "Loaded custom prompt.md");
  } else {
    promptMd = DEFAULT_PROMPT;
  }

  // Resolve model
  const { model, apiKey } = resolveModel(cliArgs.model);

  // Create session manager
  const sessionMgr = new SessionManager(cliArgs.session, PROJECT_ROOT, cliArgs.forceCredentials);

  // Create API client
  const api = new SpaceMoltAPI(cliArgs.url);

  // Load credentials if they exist
  const creds = sessionMgr.loadCredentials();
  let credentialsPrompt: string;
  if (creds) {
    log("setup", `Found credentials for ${creds.username} (${creds.empire})`);
    api.setCredentials(creds.username, creds.password);
    credentialsPrompt = [
      `- Username: ${creds.username}`,
      `- Password: ${creds.password}`,
      `- Empire: ${creds.empire}`,
      `- Player ID: ${creds.playerId}`,
      "",
      "You are already logged in. Do NOT call the login tool — the session is already active. Start playing immediately.",
    ].join("\n");
  } else {
    log("setup", "No credentials found — agent will need to register");
    credentialsPrompt = "New player — you need to register first. You'll need a registration code from spacemolt.com/dashboard. Pick a creative username and empire, pass your registration_code, then IMMEDIATELY save_credentials.";
  }

  // Load TODO
  const todo = sessionMgr.loadTodo();

  // Fetch game command list from OpenAPI spec
  log("setup", "Fetching game commands from server...");
  const gameCommands = await fetchGameCommands(api.baseUrl);
  const commandList = formatCommandList(gameCommands);
  log("setup", `${gameCommands.length} game commands loaded (${allTools.length} tools: game + ${allTools.length - 1} local)`);

  // Fetch initial server state (ship status, release notes) if we have credentials
  let serverInfo = "";
  if (creds) {
    log("setup", "Fetching initial game state from server...");
    serverInfo = await fetchInitialServerInfo(api);
    if (serverInfo) {
      log("setup", "Game state loaded into agent prompt");
    }
  }

  // Build initial context
  const systemPrompt = buildSystemPrompt(promptMd, cliArgs.instruction, credentialsPrompt, todo, commandList, serverInfo);

  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: `Begin your mission: ${cliArgs.instruction}`,
        timestamp: Date.now(),
      },
    ],
    tools: allTools,
  };

  // Ctrl+C handler
  let running = true;
  const abortController = new AbortController();

  process.on("SIGINT", () => {
    if (!running) {
      log("system", "Force quit");
      process.exit(1);
    }
    log("system", "Shutting down gracefully... (press Ctrl+C again to force quit)");
    running = false;
    abortController.abort();
  });

  // ─── Outer Loop ──────────────────────────────────────────

  log("system", "Agent loop starting...");

  const compaction: CompactionState = { summary: "" };

  while (running) {
    try {
      await runAgentTurn(model, context, api, sessionMgr, {
        signal: abortController.signal,
        apiKey,
      }, compaction);
    } catch (err) {
      if (abortController.signal.aborted) break;
      logError(`Turn error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!running) break;

    // Brief pause between turns
    await sleep(TURN_INTERVAL);

    // Poll for pending server events (chats, combat, broadcasts, etc.) that
    // arrived while the LLM was thinking.  get_status is an unlimited query
    // and always returns piggybacked notifications.
    let pendingEvents = "";
    try {
      const pollResp = await api.execute("get_status");
      if (pollResp.notifications && Array.isArray(pollResp.notifications) && pollResp.notifications.length > 0) {
        logNotifications(pollResp.notifications);
        pendingEvents = formatNotifications(pollResp.notifications);
      }
    } catch {
      // Polling is best-effort; don't break the loop
    }

    // Add a continuation nudge so the LLM always has a user message to respond to.
    // Without this, the last message is an assistant message and many models return empty.
    const nudgeParts: string[] = [];
    if (pendingEvents) {
      nudgeParts.push("## Events Since Last Action\n" + pendingEvents + "\n");
    }
    nudgeParts.push("Continue your mission. Take the next action using tools. Do NOT ask for information you already have — check the system prompt for your credentials and TODO list.");
    context.messages.push({
      role: "user" as const,
      content: nudgeParts.join("\n"),
      timestamp: Date.now(),
    });

    // Refresh system prompt with latest credentials/todo
    const freshCreds = sessionMgr.loadCredentials();
    const freshTodo = sessionMgr.loadTodo();
    let freshCredsPrompt: string;
    if (freshCreds) {
      freshCredsPrompt = [
        `- Username: ${freshCreds.username}`,
        `- Empire: ${freshCreds.empire}`,
        `- Player ID: ${freshCreds.playerId}`,
        "",
        "You are logged in.",
      ].join("\n");

      // Lazy-fetch server info if a new player just registered
      if (!serverInfo) {
        api.setCredentials(freshCreds.username, freshCreds.password);
        serverInfo = await fetchInitialServerInfo(api);
      }
    } else {
      freshCredsPrompt = credentialsPrompt;
    }
    context.systemPrompt = buildSystemPrompt(promptMd, cliArgs.instruction, freshCredsPrompt, freshTodo, commandList, serverInfo);
  }

  // ─── Session Handoff ────────────────────────────────────────
  log("system", "Generating session handoff...");
  try {
    const handoff = await generateSessionHandoff(model, context, { apiKey });
    if (handoff) {
      log("info", `Handoff note:\n${handoff}`);

      // Persist to captain's log (server-side, survives across sessions)
      try {
        await api.execute("captains_log_add", {
          entry: `[Session Handoff] ${handoff}`,
        });
        log("system", "Handoff saved to captain's log");
      } catch {
        logError("Failed to save handoff to captain's log");
      }

      // Prepend to TODO (local, read at next startup)
      const existingTodo = sessionMgr.loadTodo();
      const todoHandoff = `## Session Handoff (${new Date().toISOString()})\n${handoff}\n\n---\n${existingTodo}`;
      sessionMgr.saveTodo(todoHandoff);
      log("system", "Handoff prepended to TODO");
    } else {
      log("system", "No handoff generated (session too short)");
    }
  } catch (err) {
    logError(`Handoff failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  log("system", "Agent stopped.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logError(`Fatal: ${err.message || err}`);
  process.exit(1);
});
