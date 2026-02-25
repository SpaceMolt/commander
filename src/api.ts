import { log, logError } from "./ui.js";

export interface ApiSession {
  id: string;
  playerId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiResponse {
  result?: unknown;
  notifications?: unknown[];
  session?: ApiSession;
  error?: { code: string; message: string; wait_seconds?: number } | null;
}

const DEFAULT_BASE_URL = "https://game.spacemolt.com/api/v1";
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY = 5_000; // 5s, 10s, 20s, 40s, 80s, 160s
const VERSION = "0.2.11";
const USER_AGENT = `SpaceMolt-Commander/${VERSION}`;

export class SpaceMoltAPI {
  readonly baseUrl: string;
  private session: ApiSession | null = null;
  private credentials: { username: string; password: string } | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.SPACEMOLT_URL || DEFAULT_BASE_URL;
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    try {
      await this.ensureSession();
    } catch {
      return { error: { code: "connection_failed", message: "Could not connect to server" } };
    }

    let resp: ApiResponse;
    try {
      resp = await this.doRequest(command, payload);
    } catch {
      // Network error — server may have restarted mid-request
      log("system", "Connection lost, reconnecting...");
      this.session = null;
      try {
        await this.ensureSession();
        resp = await this.doRequest(command, payload);
      } catch {
        return { error: { code: "connection_failed", message: "Could not reconnect to server" } };
      }
    }

    // Handle session/auth errors by refreshing and retrying
    if (resp.error) {
      const code = resp.error.code;

      if (code === "rate_limited") {
        const secs = resp.error.wait_seconds || 10;
        log("wait", `Rate limited — sleeping ${secs}s...`);
        await sleep(Math.ceil(secs * 1000));
        return this.execute(command, payload);
      }

      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        log("system", "Session expired, refreshing...");
        this.session = null;
        await this.ensureSession();
        return this.doRequest(command, payload);
      }
    }

    // Update session info from response
    if (resp.session) {
      this.session = resp.session;
    }

    return resp;
  }

  private async ensureSession(): Promise<void> {
    if (this.session && !this.isSessionExpiring()) return;

    log("system", this.session ? "Renewing session..." : "Creating new session...");

    // Retry with backoff — server may be restarting
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${this.baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        });

        if (!resp.ok) {
          throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          this.session = data.session;
          log("system", `Session created: ${this.session.id.slice(0, 8)}...`);
        } else {
          throw new Error("No session in response");
        }

        // Re-authenticate if we have credentials
        if (this.credentials) {
          log("system", `Logging in as ${this.credentials.username}...`);
          const loginResp = await this.doRequest("login", {
            username: this.credentials.username,
            password: this.credentials.password,
          });
          if (loginResp.error) {
            logError(`Login failed: ${loginResp.error.message}`);
          } else {
            log("system", "Logged in successfully");
          }
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        log("system", `Server unreachable (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
    throw lastError || new Error("Failed to connect to server");
  }

  private isSessionExpiring(): boolean {
    if (!this.session) return true;
    const expiresAt = new Date(this.session.expiresAt).getTime();
    const now = Date.now();
    return expiresAt - now < 60_000; // Less than 60s remaining
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const url = `${this.baseUrl}/${command}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.session) {
      headers["X-Session-Id"] = this.session.id;
    }

    // fetch() only throws on network errors (DNS, connection refused, etc.)
    // Any HTTP response — even 4xx/5xx — means the server is reachable.
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    // 401 = session gone (server restarted, etc.) — return as session error
    if (resp.status === 401) {
      return {
        error: { code: "session_invalid", message: "Unauthorized — session lost" },
      };
    }

    // Try to parse JSON for any status code. If the server returned an HTTP
    // response (even an error), the connection is fine — don't throw.
    try {
      return (await resp.json()) as ApiResponse;
    } catch {
      // Non-JSON response (e.g. HTML error page, empty body)
      return {
        error: { code: "http_error", message: `HTTP ${resp.status}: ${resp.statusText}` },
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
