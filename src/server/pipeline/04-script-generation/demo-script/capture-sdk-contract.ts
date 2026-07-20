import type { DemoScript } from "./demo-script.schema";

const SDK_IMPORT_PATTERN =
  /import\s+\{\s*(?:scene\s*,\s*setup|setup\s*,\s*scene)\s*\}\s+from\s+['"]\.\/makeademo-capture-sdk['"];?/;

const forbiddenCaptureControlPatterns: Array<[RegExp, string]> = [
  [/\brecordVideo\b/, "Playwright recordVideo is owned by MakeADemo"],
  [/\bchromium\.launch\b/, "browser launch is owned by MakeADemo"],
  [/\bbrowser\.newContext\b/, "browser context creation is owned by MakeADemo"],
  [
    /\[makeademo:scene\]/,
    "Scene marker emission is owned by the MakeADemo Capture SDK",
  ],
  [/\belapsedMs\b/, "marker timing is owned by MakeADemo"],
];

const forbiddenRuntimeNetworkPatterns: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "Generated Demo Scripts must not call fetch"],
  [
    /\bXMLHttpRequest\b/,
    "Generated Demo Scripts must not create XMLHttpRequest calls",
  ],
  [/\bWebSocket\b/, "Generated Demo Scripts must not create WebSocket clients"],
  [
    /\bEventSource\b/,
    "Generated Demo Scripts must not create EventSource clients",
  ],
  [
    /\bnavigator\s*\.\s*sendBeacon\s*\(/,
    "Generated Demo Scripts must not call navigator.sendBeacon",
  ],
  [
    /\bpage\s*\.\s*(?:waitForRequest|waitForResponse|route|unroute)\s*\(/,
    "Generated Demo Scripts must not wait on network requests or install request routes",
  ],
  [
    /\bpage\s*\.\s*request\b/,
    "Generated Demo Scripts must not use page.request",
  ],
];

const forbiddenNetworkImportPatterns: Array<[RegExp, string]> = [
  [
    /\b(?:import\s+(?:[^'"]+\s+from\s+)?|require\s*\(\s*)['"](?:node:)?(?:http|https|net|dns)['"]\s*\)?/,
    "Generated Demo Scripts must not import Node network modules",
  ],
];

const forbiddenAppBypassPatterns: Array<[RegExp, string]> = [
  [
    /\bpage\s*\.\s*(?:evaluate|evaluateHandle|waitForFunction)\s*\(/,
    "Generated Demo Scripts must not execute arbitrary page JavaScript",
  ],
  [
    /\bpage\s*\.\s*(?:addScriptTag|addInitScript|exposeFunction|exposeBinding)\s*\(/,
    "Generated Demo Scripts must not inject scripts into the prepared app",
  ],
];

/** Validates that generated Demo Scripts use the Capture SDK without owning capture controls. */
export function assertDemoScriptCaptureSdkContract(script: DemoScript): void {
  if (!SDK_IMPORT_PATTERN.test(script.demoPlaywrightScript)) {
    throw new Error(
      "Demo Script must import { setup, scene } from './makeademo-capture-sdk'.",
    );
  }
  for (const [pattern, reason] of forbiddenCaptureControlPatterns) {
    if (pattern.test(script.demoPlaywrightScript))
      throw new Error(
        `Demo Script violates the Capture SDK Contract: ${reason}.`,
      );
  }
  const networkSource = stripCommentsAndStringLiterals(
    script.demoPlaywrightScript,
  );
  for (const [pattern, reason] of forbiddenRuntimeNetworkPatterns) {
    if (pattern.test(networkSource))
      throw new Error(
        `Demo Script violates the Capture SDK Contract: ${reason}.`,
      );
  }
  for (const [pattern, reason] of forbiddenNetworkImportPatterns) {
    if (pattern.test(script.demoPlaywrightScript))
      throw new Error(
        `Demo Script violates the Capture SDK Contract: ${reason}.`,
      );
  }
  const bypassSource = stripCommentsAndStringLiterals(
    script.demoPlaywrightScript,
  );
  for (const [pattern, reason] of forbiddenAppBypassPatterns) {
    if (pattern.test(bypassSource))
      throw new Error(
        `Demo Script violates the Capture SDK Contract: ${reason}.`,
      );
  }
  for (const scene of script.scenes) {
    const sceneBody = readSceneCallbackSource(
      script.demoPlaywrightScript,
      scene.id,
    );
    if (sceneBody === undefined)
      throw new Error(
        `Demo Script must call scene(${JSON.stringify(scene.id)}, ...).`,
      );
    if (!hasVisiblePlaywrightAssertion(sceneBody))
      throw new Error(
        `Scene ${scene.id} must include a visible Playwright assertion before it ends.`,
      );
  }
}

function hasVisiblePlaywrightAssertion(source: string) {
  const assertionSource = stripCommentsAndStringLiterals(source);
  return /\bexpect\s*\(\s*(?:page\.|[^)]*\b(?:locator|getBy(?:Role|Text|Label|Placeholder|TestId|Title|AltText))\b)[\s\S]*?\)\s*\.\s*(?:toBeVisible|toBeInViewport|toContainText|toHaveText|toHaveURL|toHaveTitle|toHaveCount)\s*\(/.test(
    assertionSource,
  );
}

function stripCommentsAndStringLiterals(source: string) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/\/\/.*$/gm, " ")
    .replaceAll(/(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*\1/g, "''");
}

function readSceneCallbackSource(script: string, sceneId: string) {
  const marker = new RegExp(`scene\\(\\s*['"]${escapeRegExp(sceneId)}['"]`);
  const match = marker.exec(script);
  if (match === null) return undefined;
  const nextSceneIndex = script
    .slice(match.index + match[0].length)
    .search(/\bscene\s*\(/);
  if (nextSceneIndex === -1) return script.slice(match.index);
  return script.slice(
    match.index,
    match.index + match[0].length + nextSceneIndex,
  );
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
