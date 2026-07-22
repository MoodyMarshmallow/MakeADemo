import type { AgentToolDefinition } from "../../agent-session-runner.interface";
import type { BrowserToolController } from "./browser-tool-controller.interface";
import {
  parseBrowserAction,
  parseBrowserInspectionKind,
  parseBrowserNavigationPath,
  parseBrowserScreenshotOptions,
} from "./browser-tool.schema";

const actionKinds = [
  "click",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "select",
  "hover",
] as const;

/** Creates the only model-facing browser tools MakeADemo authorizes. */
export function createBrowserStageTools(
  controller: BrowserToolController,
): readonly AgentToolDefinition[] {
  return [
    {
      args: {
        path: {
          description:
            "Relative path, query, or fragment within the prepared app.",
          type: "string",
        },
      },
      description: "Navigate only within the authorized prepared-app origin.",
      async execute(args) {
        return JSON.stringify(
          await controller.navigate({ path: parseBrowserNavigationPath(args) }),
        );
      },
      name: "makeademo_browser_navigate",
    },
    {
      args: {
        kind: {
          description: "The bounded browser diagnostic to inspect.",
          type: "enum",
          values: ["snapshot", "console", "requests"],
        },
      },
      description:
        "Inspect a bounded accessibility snapshot, console log, or network requests.",
      async execute(args) {
        return JSON.stringify(
          await controller.inspect({ kind: parseBrowserInspectionKind(args) }),
        );
      },
      name: "makeademo_browser_inspect",
    },
    {
      args: {
        key: {
          description: "Keyboard key for press actions.",
          optional: true,
          type: "string",
        },
        kind: {
          description: "A fixed safe browser action.",
          type: "enum",
          values: actionKinds,
        },
        ref: {
          description: "Accessibility reference from a recent snapshot.",
          optional: true,
          type: "string",
        },
        text: {
          description: "Text for fill or type actions.",
          optional: true,
          type: "string",
        },
        value: {
          description: "Option value for select actions.",
          optional: true,
          type: "string",
        },
      },
      description:
        "Perform one fixed interaction against a snapshot reference; arbitrary JavaScript is unavailable.",
      async execute(args) {
        return JSON.stringify(await controller.act(parseBrowserAction(args)));
      },
      name: "makeademo_browser_act",
    },
    {
      args: {
        fullPage: {
          description: "Whether to capture the whole page.",
          optional: true,
          type: "enum",
          values: ["true", "false"],
        },
        target: {
          description: "Optional accessibility reference to capture.",
          optional: true,
          type: "string",
        },
      },
      description:
        "Capture a validated PNG and expose it at the agent-readable screenshot path.",
      async execute(args) {
        return JSON.stringify(
          await controller.screenshot(parseBrowserScreenshotOptions(args)),
        );
      },
      name: "makeademo_browser_screenshot",
    },
    {
      args: {},
      description:
        "Close the retained browser session and discard its in-memory state.",
      async execute() {
        await controller.reset();
        return "Browser session reset.";
      },
      name: "makeademo_browser_reset",
    },
  ];
}
