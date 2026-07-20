export type MakeADemoConfig = {
  demoCommand: string;
  url: string;
};

export function readMakeADemoConfig(value: unknown): MakeADemoConfig {
  const record = assertRecord(value, "makeademo.config.json");
  const demoCommand = readNonEmptyString(record, "demoCommand");
  const url = readNonEmptyString(record, "url");

  if (!isLocalHttpUrl(url)) {
    throw new Error("url must be a local http URL");
  }

  return { demoCommand, url };
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
