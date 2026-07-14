/**
 * Redacts authorization header values and bearer credentials while preserving
 * the surrounding benchmark diagnostics.
 */
export function redactBenchmarkOutput(output: string): string {
  return output
    .replace(/(\bauthorization\b["']?\s*:\s*["'])[^"'\r\n]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
