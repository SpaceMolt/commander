import { readFileSync } from "fs";
import { join, dirname } from "path";
import type { Context, Message } from "@mariozechner/pi-ai";
import { resolveModel } from "./model.js";
import { SpaceMoltAPI } from "./api.js";
import { SessionManager } from "./session.js";
import { localTools } from "./tools.js";
import { fetchGameTools } from "./schema.js";
import { runAgentTurn, generateSessionHandoff, type CompactionState } from "./loop.js";
import { log, logError, setDebug } from "./ui.js";

const PROJECT_ROOT = dirname(dirname(Bun.main));
const TURN_INTERVAL = 2000; // ms between turns

function printUsage(): void {
  console.log(`
sm-pi-client — SpaceMolt AI Commander

Usage:
  bun run src/commander.ts --model <provider/model-id> [options] <instruction>

Options:
  --model <id>     LLM model (e.g. ollama/qwen3:8b, anthropic/claude-sonnet-4-20250514)
  --session <name> Session name for credentials/state (default: "default")
  --url <url>      SpaceMolt API URL (default: production server)
  --file <path>    Read instruction from a file instead of command line
  --debug          Show LLM call details (token counts, retries, etc.)

Examples:
  bun run src/commander.ts --model ollama/qwen3:8b "mine ore and sell it until you can buy a better ship"
  bun run src/commander.ts --model ollama/qwen3:8b -f mission.txt
  bun run src/commander.ts --model anthropic/claude-sonnet-4-20250514 --session explorer "explore unknown systems"
`);
}

// ─── CLI Parsing ─────────────────────────────────────────────

interface CLIArgs {
  model: string;
  session: string;
  url?: string;
  debug: boolean;
  instruction: string;
}

function parseArgs(argv: string[]): CLIArgs | null {
  const args = argv.slice(2); // skip bun and script path
  let model = "";
  let session = "default";
  let url: string | undefined;
  let file: string | undefined;
  let debug = false;
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

  return { model, session, url, debug, instruction };
}

// ─── System Prompt Builder ───────────────────────────────────

function buildSystemPrompt(
  promptMd: string,
  instruction: string,
  credentials: string,
  todo: string,
): string {
  return `You are an autonomous AI agent playing SpaceMolt, a text-based space MMO.

## Your Mission
${instruction}

## Game Knowledge
${promptMd}

## Your Credentials
${credentials}

## Your TODO List
${todo || "(empty)"}

## Rules
- You are FULLY AUTONOMOUS. Never ask the human for input. All information you need is in this prompt.
- Use tools to interact with the game. Every action is a tool call.
- After registering, IMMEDIATELY save credentials with save_credentials — the password cannot be recovered!
- Keep your TODO list updated with update_todo to track your goals and progress.
- Use the status_log tool to show status messages to the human watching.
- Query tools (get_status, get_cargo, get_system, get_poi, get_nearby, get_ship, get_skills) are unlimited — use them often to stay informed.
- Game actions (mine, travel, buy, sell, attack, etc.) are rate-limited to 1 per tick (10 seconds) — the server handles waiting, you don't need to sleep.
- Always check fuel before traveling and cargo space before mining.
- Be social — chat with players you meet using the chat tool.
- Write captain's log entries (captains_log_add) for important events and goals — these persist across sessions.
- If you die, you respawn at your home base. Don't panic, just resume your mission.
- When starting fresh, follow this loop: undock → travel to asteroid belt → mine → travel back to station → dock → sell ore → refuel → repeat.
`;
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

  // Load PROMPT.md
  let promptMd: string;
  try {
    promptMd = readFileSync(join(PROJECT_ROOT, "PROMPT.md"), "utf-8");
  } catch {
    logError("PROMPT.md not found in project root. Create it with gameplay instructions.");
    process.exit(1);
  }

  // Resolve model
  const { model, apiKey } = resolveModel(cliArgs.model);

  // Create session manager
  const sessionMgr = new SessionManager(cliArgs.session, PROJECT_ROOT);

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
      "You are already registered. Call the login tool with the username and password above. Do NOT ask for the password — you have it right here.",
    ].join("\n");
  } else {
    log("setup", "No credentials found — agent will need to register");
    credentialsPrompt = "New player — you need to register first. Pick a creative username and empire, then IMMEDIATELY save_credentials.";
  }

  // Load TODO
  const todo = sessionMgr.loadTodo();

  // Fetch game tools from OpenAPI spec
  log("setup", "Fetching game tools from server...");
  const remoteTools = await fetchGameTools(api.baseUrl);
  const allTools = [...localTools, ...remoteTools];
  log("setup", `Tools loaded: ${remoteTools.length} remote + ${localTools.length} local = ${allTools.length} total`);

  // Build initial context
  const systemPrompt = buildSystemPrompt(promptMd, cliArgs.instruction, credentialsPrompt, todo);

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

    // Add a continuation nudge so the LLM always has a user message to respond to.
    // Without this, the last message is an assistant message and many models return empty.
    context.messages.push({
      role: "user" as const,
      content: "Continue your mission. Take the next action using tools. Do NOT ask for information you already have — check the system prompt for your credentials and TODO list.",
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
    } else {
      freshCredsPrompt = credentialsPrompt;
    }
    context.systemPrompt = buildSystemPrompt(promptMd, cliArgs.instruction, freshCredsPrompt, freshTodo);
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
