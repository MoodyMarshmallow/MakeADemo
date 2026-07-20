import type { DemoScript } from "./demo-script/demo-script.schema";

export type SaveGeneratedScriptInput = {
  demoRequestId: string;
  script: DemoScript;
};

/**
 * Persists the generated Demo Script for a Demo Request.
 * Implementations must update only the identified Demo Request and must store
 * the complete package that downstream review and audit flows need.
 */
export interface DemoRequestScriptStore {
  saveGeneratedScript(input: SaveGeneratedScriptInput): Promise<void>;
}
