const replacement = "[redacted]";

export const validationEvidenceCaps = {
  browser: 8 * 1024,
  failureReason: 2 * 1024,
  prompt: 32 * 1024,
  server: 16 * 1024,
} as const;

export type BoundedValidationText = {
  omittedChars?: number;
  text: string;
  truncated?: true;
};

/** Redacts secret-like values and retains only a bounded diagnostic excerpt. */
export function boundValidationEvidence(
  value: string,
  maxLength: number,
): BoundedValidationText {
  const redacted = redactValidationEvidence(value);
  if (redacted.length <= maxLength) {
    return { text: redacted };
  }

  return {
    omittedChars: redacted.length - maxLength,
    text: redacted.slice(-maxLength),
    truncated: true,
  };
}

export function redactValidationEvidence(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/gi, redactEmbeddedUrl)
    .replace(
      /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      (match) => `${match.split(/\s+/)[0]} ${replacement}`,
    )
    .replace(
      /\b([a-z0-9_-]*(?:token|secret|password|api[_-]?key|authorization|auth|credential)[a-z0-9_-]*)["']?\s*[:=]\s*["']?([^\s,;}"']+)/gi,
      `$1=${replacement}`,
    )
    .replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, `$1=${replacement}`)
    .replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, "//");
}

function redactEmbeddedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    ) {
      return value;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, replacement);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function boundValidationLogs(logs: string[]): string[] {
  return logs.map(
    (log) => boundValidationEvidence(log, validationEvidenceCaps.browser).text,
  );
}
