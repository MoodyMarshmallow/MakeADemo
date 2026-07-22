import type {
  BrowserAction,
  BrowserInspectionKind,
} from "./browser-tool-controller.interface";

const browserActionKinds = [
  "click",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "select",
  "hover",
] as const;

/** Runtime validation for model-supplied browser tool arguments. */
export function parseBrowserAction(
  value: Record<string, unknown>,
): BrowserAction {
  const kind = readEnum(value.kind, browserActionKinds, "Browser action kind");
  switch (kind) {
    case "click":
    case "check":
    case "hover":
    case "uncheck": {
      assertAbsent(value, ["key", "text", "value"], kind);
      return {
        kind,
        ref: readBoundedNonEmptyString(value.ref, "Browser action ref", 256),
      };
    }
    case "fill":
      assertAbsent(value, ["key", "value"], kind);
      return {
        kind,
        ref: readBoundedNonEmptyString(value.ref, "Browser action ref", 256),
        text: readBoundedString(value.text, "Browser action text", 4_096),
      };
    case "press":
      assertAbsent(value, ["ref", "text", "value"], kind);
      return {
        kind,
        key: readBoundedNonEmptyString(value.key, "Browser action key", 64),
      };
    case "select":
      assertAbsent(value, ["key", "text"], kind);
      return {
        kind,
        ref: readBoundedNonEmptyString(value.ref, "Browser action ref", 256),
        value: readBoundedString(value.value, "Browser action value", 1_024),
      };
    case "type":
      assertAbsent(value, ["key", "ref", "value"], kind);
      return {
        kind,
        text: readBoundedString(value.text, "Browser action text", 4_096),
      };
  }
}

export function parseBrowserInspectionKind(
  value: Record<string, unknown>,
): BrowserInspectionKind {
  return readEnum(
    value.kind,
    ["snapshot", "console", "requests"] as const,
    "Browser inspection kind",
  );
}

export function parseBrowserNavigationPath(
  value: Record<string, unknown>,
): string {
  const path = readNonEmptyString(value.path, "Browser navigation path");
  if (path.length > 2_048) {
    throw new Error("Browser navigation path must be at most 2048 characters.");
  }
  if (
    path.startsWith("//") ||
    path.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    throw new Error(
      "Browser navigation path must be relative to the prepared app.",
    );
  }
  return path;
}

export function parseBrowserScreenshotOptions(value: Record<string, unknown>): {
  fullPage?: boolean;
  target?: string;
} {
  const fullPage = value.fullPage;
  if (fullPage !== undefined && fullPage !== "true" && fullPage !== "false") {
    throw new Error("Browser screenshot fullPage must be true or false.");
  }
  const target = value.target;
  if (target !== undefined && typeof target !== "string") {
    throw new Error("Browser screenshot target must be a string.");
  }
  if (typeof target === "string" && target.length > 256) {
    throw new Error(
      "Browser screenshot target must be at most 256 characters.",
    );
  }
  if (target !== undefined && fullPage === "true") {
    throw new Error("Browser screenshot cannot combine target and fullPage.");
  }
  return {
    ...(fullPage === "true" ? { fullPage: true } : {}),
    ...(target === undefined ? {} : { target }),
  };
}

function assertAbsent(
  value: Record<string, unknown>,
  names: readonly string[],
  kind: string,
): void {
  const supplied = names.find((name) => value[name] !== undefined);
  if (supplied !== undefined) {
    throw new Error(`Browser action ${kind} does not accept ${supplied}.`);
  }
}

function readEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as T[number];
}

function readNonEmptyString(value: unknown, name: string): string {
  const result = readString(value, name);
  if (result.length === 0) throw new Error(`${name} must not be empty.`);
  return result;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function readBoundedString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  const result = readString(value, name);
  if (result.length > maximumLength) {
    throw new Error(`${name} must be at most ${maximumLength} characters.`);
  }
  return result;
}

function readBoundedNonEmptyString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  const result = readBoundedString(value, name, maximumLength);
  if (result.length === 0) throw new Error(`${name} must not be empty.`);
  return result;
}
