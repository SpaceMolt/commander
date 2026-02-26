const COLORS: Record<string, string> = {
  setup: "\x1b[34m",    // blue
  mining: "\x1b[32m",   // green
  travel: "\x1b[36m",   // cyan
  combat: "\x1b[31m",   // red
  trade: "\x1b[33m",    // yellow
  chat: "\x1b[35m",     // magenta
  error: "\x1b[91m",    // bright red
  wait: "\x1b[33m",     // yellow
  info: "\x1b[37m",     // white
  tool: "\x1b[90m",     // gray
  agent: "\x1b[96m",    // bright cyan
  system: "\x1b[34m",   // blue
  craft: "\x1b[32m",    // green
  faction: "\x1b[35m",  // magenta
  mission: "\x1b[36m",  // cyan
  broadcast: "\x1b[91m", // bright red (admin broadcasts)
  dm: "\x1b[95m",        // bright magenta (private messages)
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let debugEnabled = false;
let sanitizeEnabled = true;
const sensitiveValues = new Set<string>();

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function setSanitize(enabled: boolean): void {
  sanitizeEnabled = enabled;
}

export function addSensitiveValue(value: string): void {
  if (value && value.length >= 8) {
    sensitiveValues.add(value);
  }
}

function sanitize(text: string): string {
  if (!sanitizeEnabled) return text;
  let result = text;
  for (const value of sensitiveValues) {
    result = result.replaceAll(value, "[REDACTED]");
  }
  // Catch any 64-char hex strings (256-bit passwords/tokens)
  result = result.replace(/\b[0-9a-f]{64}\b/gi, "[REDACTED]");
  return result;
}

/** Sanitization-aware console.log wrapper. */
function out(...args: unknown[]): void {
  const sanitized = args.map(a => typeof a === "string" ? sanitize(a) : a);
  console.log(...sanitized);
}

export function log(category: string, message: string): void {
  const color = COLORS[category] || COLORS.info;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  out(`${DIM}${timestamp}${RESET} ${color}[${category}]${RESET} ${message}`);
}

export function isDebug(): boolean {
  return debugEnabled;
}

export function logDebug(message: string): void {
  if (!debugEnabled) return;
  log("system", message);
}

// ─── Debug colors & separators ──────────────────────────────

const C = {
  yellow:  "\x1b[93m",  // bright yellow
  cyan:    "\x1b[96m",  // bright cyan
  green:   "\x1b[92m",  // bright green
  magenta: "\x1b[95m",  // bright magenta
  blue:    "\x1b[94m",  // bright blue
  red:     "\x1b[91m",  // bright red
  white:   "\x1b[97m",  // bright white
  gray:    "\x1b[90m",  // gray
};

const SEP_HEAVY = "━".repeat(100);
const SEP_LIGHT = "─".repeat(100);
const SEP_DOT   = "┄".repeat(100);

function debugHeader(color: string, icon: string, title: string, subtitle?: string): void {
  out(`\n${color}${SEP_HEAVY}${RESET}`);
  out(`${color}${BOLD}  ${icon}  ${title}${RESET}${subtitle ? `  ${DIM}${subtitle}${RESET}` : ""}`);
  out(`${color}${SEP_HEAVY}${RESET}`);
}

function debugSection(color: string, label: string, meta?: string): void {
  out(`\n${color}${SEP_LIGHT}${RESET}`);
  out(`${color}${BOLD}  ${label}${RESET}${meta ? `  ${DIM}${meta}${RESET}` : ""}`);
  out(`${color}${SEP_LIGHT}${RESET}`);
}

function debugSub(color: string, label: string, meta?: string): void {
  out(`${color}${SEP_DOT}${RESET}`);
  out(`${color}  ${label}${RESET}${meta ? `  ${DIM}${meta}${RESET}` : ""}`);
  out(`${color}${SEP_DOT}${RESET}`);
}

function debugFooter(color: string): void {
  out(`${color}${SEP_HEAVY}${RESET}\n`);
}

// ─── LLM payload (raw outgoing request body) ────────────────

export function logLLMPayload(payload: unknown): void {
  if (!debugEnabled) return;
  debugSection(C.gray, "RAW REQUEST PAYLOAD");
  out(JSON.stringify(payload, null, 2));
}

// ─── LLM input (system prompt + messages) ───────────────────

export function logLLMInput(systemPrompt: string | undefined, messages: Array<{ role: string; content: unknown }>): void {
  if (!debugEnabled) return;

  const totalChars = (systemPrompt?.length || 0) + messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if ("text" in b) sum += ((b as any).text || "").length;
        if ("thinking" in b) sum += ((b as any).thinking || "").length;
        if ("name" in b) sum += JSON.stringify((b as any).arguments || {}).length;
      }
    }
    return sum;
  }, 0);

  debugHeader(C.yellow, "▶", "LLM INPUT", `${messages.length} messages, ~${totalChars} chars`);

  // System prompt — full, no truncation
  const sp = systemPrompt || "(none)";
  debugSection(C.blue, "SYSTEM PROMPT", `${sp.length} chars`);
  out(sp);

  // Messages — each gets its own sub-separator
  debugSection(C.cyan, "MESSAGES", `${messages.length} total`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role.toUpperCase();
    const roleColor = role === "USER" ? C.green : role === "ASSISTANT" ? C.magenta : C.gray;

    if (typeof msg.content === "string") {
      debugSub(roleColor, `[${i}] ${role}`, `${msg.content.length} chars`);
      out(msg.content);
    } else if (Array.isArray(msg.content)) {
      debugSub(roleColor, `[${i}] ${role}`, `${msg.content.length} blocks`);
      for (const block of msg.content) {
        if ("text" in block && (block as any).text) {
          const text = (block as any).text;
          out(`\n  ${BOLD}[text]${RESET} ${DIM}(${text.length} chars)${RESET}`);
          out(text);
        } else if ("name" in block) {
          const args = JSON.stringify((block as any).arguments, null, 2);
          out(`\n  ${BOLD}[toolCall]${RESET} ${(block as any).name}`);
          out(args);
        } else if ("thinking" in block && (block as any).thinking) {
          const thinking = (block as any).thinking;
          out(`\n  ${BOLD}[thinking]${RESET} ${DIM}(${thinking.length} chars)${RESET}`);
          out(thinking);
        }
      }
    }
  }

  debugFooter(C.yellow);
}

// ─── LLM output (full response + metadata) ──────────────────

export function logLLMOutput(response: {
  content: Array<any>;
  stopReason?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
  provider?: string;
  model?: string;
  api?: string;
  errorMessage?: string;
  timestamp?: number;
}): void {
  if (!debugEnabled) return;

  debugHeader(C.green, "◀", "LLM OUTPUT", `stop=${response.stopReason || "?"}`);

  // Metadata
  debugSection(C.blue, "METADATA");
  const meta: string[] = [];
  if (response.provider) meta.push(`  provider:  ${response.provider}`);
  if (response.model)    meta.push(`  model:     ${response.model}`);
  if (response.api)      meta.push(`  api:       ${response.api}`);
  meta.push(`  stop:      ${response.stopReason || "?"}`);
  if (response.errorMessage) meta.push(`  ${C.red}error:     ${response.errorMessage}${RESET}`);
  if (response.timestamp) meta.push(`  timestamp: ${new Date(response.timestamp).toISOString()}`);
  out(meta.join("\n"));

  // Usage / tokens
  if (response.usage) {
    const u = response.usage;
    debugSection(C.magenta, "TOKEN USAGE");
    const lines = [
      `  input:       ${u.input.toLocaleString()} tokens`,
      `  output:      ${u.output.toLocaleString()} tokens`,
      `  cache read:  ${u.cacheRead.toLocaleString()} tokens`,
      `  cache write: ${u.cacheWrite.toLocaleString()} tokens`,
      `  ${BOLD}total:       ${u.totalTokens.toLocaleString()} tokens${RESET}`,
    ];
    if (u.cost) {
      lines.push("");
      lines.push(`  cost input:       $${u.cost.input.toFixed(6)}`);
      lines.push(`  cost output:      $${u.cost.output.toFixed(6)}`);
      lines.push(`  cost cache read:  $${u.cost.cacheRead.toFixed(6)}`);
      lines.push(`  cost cache write: $${u.cost.cacheWrite.toFixed(6)}`);
      lines.push(`  ${BOLD}cost total:         $${u.cost.total.toFixed(6)}${RESET}`);
    }
    out(lines.join("\n"));
  }

  // Content blocks — full, no truncation
  debugSection(C.cyan, "CONTENT", `${response.content.length} blocks`);

  for (let i = 0; i < response.content.length; i++) {
    const block = response.content[i];

    if ("text" in block && block.text) {
      debugSub(C.white, `[${i}] text`, `${block.text.length} chars`);
      out(block.text);
    } else if ("name" in block) {
      const argsStr = JSON.stringify(block.arguments, null, 2);
      debugSub(C.yellow, `[${i}] toolCall: ${block.name}`, `id=${block.id || "?"}`);
      out(argsStr);
    } else if ("thinking" in block && block.thinking) {
      debugSub(C.gray, `[${i}] thinking`, `${block.thinking.length} chars`);
      out(block.thinking);
    }
  }

  debugFooter(C.green);
}

// ─── Tool result debug logging ──────────────────────────────

export function logToolResultDebug(toolName: string, toolCallId: string, result: string, isError: boolean): void {
  if (!debugEnabled) return;
  const color = isError ? C.red : C.gray;
  debugSub(color, `TOOL RESULT: ${toolName}`, `id=${toolCallId}, ${result.length} chars${isError ? " [ERROR]" : ""}`);
  out(result);
}

export function logError(message: string): void {
  log("error", message);
}

export function logTool(name: string, args?: Record<string, unknown>, reason?: string): void {
  const color = COLORS.tool;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const argsStr = args ? ` ${formatArgs(args)}` : "";
  const toolPart = `${DIM}\x1b[37m${name}${argsStr}${RESET}`;
  if (reason) {
    out(`${DIM}${timestamp}${RESET} ${color}[tool]${RESET} ${reason} ${DIM}—${RESET} ${toolPart}`);
  } else {
    out(`${DIM}${timestamp}${RESET} ${color}[tool]${RESET} ${toolPart}`);
  }
}

export function logAgent(text: string): void {
  log("agent", text);
}

const REDACTED_KEYS = new Set(["password", "token", "secret", "api_key", "registration_code"]);

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (REDACTED_KEYS.has(key)) {
      parts.push(`${key}=XXX`);
      continue;
    }
    const str = typeof value === "string" ? value : JSON.stringify(value);
    const truncated = str.length > 60 ? str.slice(0, 57) + "..." : str;
    parts.push(`${key}=${truncated}`);
  }
  return parts.join(" ");
}

/** Parse a single notification into a { tag, category, text } triple. */
function parseNotification(n: unknown): { tag: string; category: string; text: string } | null {
  if (typeof n === "string") return { tag: "EVENT", category: "info", text: n };
  if (typeof n !== "object" || n === null) return null;

  const notif = n as Record<string, unknown>;
  const type = notif.type as string | undefined;
  const msgType = notif.msg_type as string | undefined;
  let data = notif.data as Record<string, unknown> | string | undefined;

  // The HTTP API stores json.RawMessage in Data — if it arrives as a string, parse it
  if (typeof data === "string") {
    try { data = JSON.parse(data) as Record<string, unknown>; } catch { /* leave as string */ }
  }

  // Chat messages
  if (msgType === "chat_message" && data && typeof data === "object") {
    const channel = data.channel as string || "?";
    const sender = data.sender as string || "Unknown";
    const content = data.content as string || "";

    if (sender === "[ADMIN]") {
      return { tag: "BROADCAST", category: "broadcast", text: content };
    } else if (channel === "private") {
      return { tag: `DM from ${sender}`, category: "dm", text: content };
    } else {
      return { tag: `CHAT ${channel.toUpperCase()}`, category: "chat", text: `${sender}: ${content}` };
    }
  }

  // System notifications
  if (type === "system" && data && typeof data === "object") {
    const message = data.message as string || JSON.stringify(data);
    return { tag: "SYSTEM", category: "broadcast", text: message };
  }

  // Tips
  if (type === "tip" && data && typeof data === "object") {
    const message = data.message as string || JSON.stringify(data);
    return { tag: "TIP", category: "system", text: message };
  }

  // Combat notifications
  if (type === "combat" && data && typeof data === "object") {
    const message = (data.message as string) || JSON.stringify(data);
    return { tag: "COMBAT", category: "combat", text: message };
  }

  // Trade notifications
  if (type === "trade" && data && typeof data === "object") {
    const message = (data.message as string) || JSON.stringify(data);
    return { tag: "TRADE", category: "trade", text: message };
  }

  // Ships / scan results
  if ((type === "scan" || type === "ships" || type === "local") && data && typeof data === "object") {
    const message = (data.message as string) || JSON.stringify(data);
    return { tag: type.toUpperCase(), category: "info", text: message };
  }

  // Catch-all: use whatever fields are available
  const tag = (type || msgType || "EVENT").toUpperCase();
  let message: string;
  if (data && typeof data === "object") {
    message = (data.message as string) || (data.content as string) || JSON.stringify(data);
  } else if (typeof data === "string") {
    message = data;
  } else {
    message = (notif.message as string) || (notif.content as string) || JSON.stringify(n);
  }
  return { tag, category: "info", text: message };
}

/**
 * Log chat and system notifications to stdout so the human watching can see them.
 * Called when we receive notifications from the API response.
 */
export function logNotifications(notifications: unknown[]): void {
  if (!notifications || notifications.length === 0) return;

  for (const n of notifications) {
    const parsed = parseNotification(n);
    if (!parsed) continue;
    log(parsed.category, `[${parsed.tag}] ${parsed.text}`);
  }
}

/**
 * Format notifications into readable text for inclusion in the LLM prompt.
 * Uses the same parsing as logNotifications so the agent sees properly structured events.
 */
export function formatNotifications(notifications: unknown[]): string {
  if (!notifications || notifications.length === 0) return "";
  const lines: string[] = [];
  for (const n of notifications) {
    const parsed = parseNotification(n);
    if (!parsed) continue;
    lines.push(`  > [${parsed.tag}] ${parsed.text}`);
  }
  return lines.join("\n");
}

export function formatToolResult(name: string, result: unknown, notifications?: unknown[]): string {
  const parts: string[] = [];
  if (notifications && Array.isArray(notifications) && notifications.length > 0) {
    parts.push("Notifications:");
    parts.push(formatNotifications(notifications));
    parts.push("");
  }
  if (typeof result === "string") {
    parts.push(result);
  } else {
    parts.push(jsonToYaml(result));
  }
  return parts.join("\n");
}

// ─── JSON → YAML (lightweight, no dependencies) ─────────────

export function jsonToYaml(value: unknown, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null || value === undefined) return `${pad}~`;
  if (typeof value === "boolean") return `${pad}${value}`;
  if (typeof value === "number") return `${pad}${value}`;
  if (typeof value === "string") {
    // Quote strings that could be misread as YAML special values
    if (
      value === "" ||
      value === "true" || value === "false" ||
      value === "null" || value === "~" ||
      value.includes("\n") ||
      value.includes(": ") ||
      value.startsWith("{") || value.startsWith("[") ||
      value.startsWith("'") || value.startsWith('"') ||
      value.startsWith("#") ||
      /^[\d.e+-]+$/i.test(value)
    ) {
      return `${pad}"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return `${pad}${value}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    // Compact arrays of scalars on one line
    if (value.every(v => v === null || typeof v !== "object")) {
      const items = value.map(v => {
        if (typeof v === "string") return `"${v.replace(/"/g, '\\"')}"`;
        return String(v ?? "~");
      });
      const oneLine = `${pad}[${items.join(", ")}]`;
      if (oneLine.length < 120) return oneLine;
    }
    const lines: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const nested = jsonToYaml(item, indent + 1).trimStart();
        lines.push(`${pad}- ${nested}`);
      } else {
        lines.push(`${pad}- ${jsonToYaml(item, 0).trimStart()}`);
      }
    }
    return lines.join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    const lines: string[] = [];
    for (const [key, val] of entries) {
      if (val !== null && typeof val === "object") {
        lines.push(`${pad}${key}:`);
        lines.push(jsonToYaml(val, indent + 1));
      } else {
        lines.push(`${pad}${key}: ${jsonToYaml(val, 0).trimStart()}`);
      }
    }
    return lines.join("\n");
  }

  return `${pad}${String(value)}`;
}
