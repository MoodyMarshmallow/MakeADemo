import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolves the official installed Context7 Pi extension directory.
 *
 * The harness can pass this explicit path to Pi's resource loader. This does
 * not scan the submitted workspace and does not opt into project extensions.
 */
export function resolveContext7ExtensionPath(): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@upstash/context7-pi/package.json");
  } catch (error) {
    throw new Error(
      "The official @upstash/context7-pi package is not installed.",
      { cause: error },
    );
  }
  return join(dirname(packageJsonPath), "extensions", "context7.ts");
}
