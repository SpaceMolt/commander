// Benchmark event emission — writes JSONL to stdout for smbench to collect.

let enabled = false;
let tick = 0;
let cumulativeTokensIn = 0;
let cumulativeTokensOut = 0;

export function setBenchmarkMode(on: boolean): void {
  enabled = on;
}

export function isBenchmarkMode(): boolean {
  return enabled;
}

export function emitEvent(event: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const line = JSON.stringify({
    event,
    tick: tick++,
    ts: new Date().toISOString(),
    ...data,
  });
  process.stdout.write(line + "\n");
}

export function trackTokens(tokensIn: number, tokensOut: number): void {
  cumulativeTokensIn += tokensIn;
  cumulativeTokensOut += tokensOut;
}

export function getCumulativeTokens(): { totalTokensIn: number; totalTokensOut: number } {
  return { totalTokensIn: cumulativeTokensIn, totalTokensOut: cumulativeTokensOut };
}
