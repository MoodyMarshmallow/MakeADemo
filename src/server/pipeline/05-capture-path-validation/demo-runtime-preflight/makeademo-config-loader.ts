import {
  type MakeADemoConfig,
  readMakeADemoConfig,
} from "./makeademo-config.schema";

export function parseMakeADemoConfig(contents: string): MakeADemoConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("makeademo.config.json must be valid JSON");
  }

  return readMakeADemoConfig(parsed);
}
