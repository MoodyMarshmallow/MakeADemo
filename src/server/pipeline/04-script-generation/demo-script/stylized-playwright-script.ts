import {
  type RuntimeNetworkPolicy,
  defaultRuntimeNetworkPolicy,
} from "../../05-capture-path-validation/demo-runtime-preflight/network-isolation-policy";

export type PrepareStylizedPlaywrightScriptInput = {
  baseUrl: string;
  headed: boolean;
  mode?: "recording" | "validation";
  pauseAfterSceneMs: number;
  playwrightModuleSpecifier?: string;
  runtimeNetworkPolicy?: RuntimeNetworkPolicy;
  videoDirectory?: string;
};

const validationActionTimeoutMs = 10_000;

export function prepareStylizedPlaywrightScript(
  script: string,
  input: PrepareStylizedPlaywrightScriptInput,
) {
  const playwrightModuleSpecifier =
    input.playwrightModuleSpecifier ?? "@playwright/test";
  const demoScript = replacePlaywrightModuleSpecifier(
    removeCaptureSdkImportsFromBody(script),
    playwrightModuleSpecifier,
  );
  if ((input.mode ?? "recording") === "validation") {
    return prepareValidationPlaywrightScript(demoScript, input);
  }

  if (!demoScript.includes("chromium.launch")) {
    return wrapActionBody(
      stylizeBrowserActions(demoScript),
      input,
      playwrightModuleSpecifier,
    );
  }

  let prepared = demoScript.replaceAll("http://localhost:3000", input.baseUrl);
  prepared = prepared.replace(
    /dir:\s*(['"`])[^'"`]+?\1/,
    `dir: ${JSON.stringify(input.videoDirectory)}`,
  );

  if (input.headed) {
    prepared = prepared.replace(
      /chromium\.launch\(\s*\)/,
      "chromium.launch({ headless: false })",
    );
  }

  prepared = stylizeBrowserActions(prepared);
  prepared = injectRecordingHelpers(prepared);

  if (input.pauseAfterSceneMs > 0) {
    prepared = prepared.replace(
      /await\s+context\.close\(\);/,
      `await page.waitForTimeout(${input.pauseAfterSceneMs});\nawait context.close();`,
    );
  }

  return prepared;
}

function wrapActionBody(
  script: string,
  input: PrepareStylizedPlaywrightScriptInput,
  playwrightModuleSpecifier: string,
) {
  const launchOptions = input.headed ? "{ headless: false }" : "";
  const pauseLine =
    input.pauseAfterSceneMs > 0
      ? `await page.waitForTimeout(${input.pauseAfterSceneMs});`
      : "";

  return `import { chromium, expect } from ${JSON.stringify(playwrightModuleSpecifier)};
import { setup, scene } from "./makeademo-capture-sdk.mjs";

${interactionHelperSource()}

const baseUrl = ${JSON.stringify(input.baseUrl)};
const browser = await chromium.launch(${launchOptions});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: ${JSON.stringify(input.videoDirectory)},
    size: { width: 1280, height: 720 },
  },
});
${runtimeNetworkSource(input.runtimeNetworkPolicy)}
const page = await context.newPage();
const makeADemoCaptureStartedAt = performance.now();
const makeADemoCaptureContext = { page, baseUrl, expect };
globalThis.__makeademoCaptureSdk = { context: makeADemoCaptureContext, startedAt: makeADemoCaptureStartedAt };

try {
${indentScriptBody(script)}
  ${pauseLine}
} finally {
  await context.close();
  await browser.close();
}
void expect;
void setup;
void scene;
`;
}

function prepareValidationPlaywrightScript(
  script: string,
  input: PrepareStylizedPlaywrightScriptInput,
) {
  if (script.includes("chromium.launch")) {
    return script.replaceAll("http://localhost:3000", input.baseUrl);
  }

  const launchOptions = input.headed ? "{ headless: false }" : "";
  const validationScript = stylizeBrowserActions(script);

  return `import { chromium, expect } from ${JSON.stringify(input.playwrightModuleSpecifier ?? "@playwright/test")};
import { setup, scene } from "./makeademo-capture-sdk.mjs";

${interactionHelperSource("validation")}

const baseUrl = ${JSON.stringify(input.baseUrl)};
const browser = await chromium.launch(${launchOptions});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
${runtimeNetworkSource(input.runtimeNetworkPolicy)}
const page = await context.newPage();
const makeADemoCaptureStartedAt = performance.now();
const makeADemoCaptureContext = { page, baseUrl, expect };
globalThis.__makeademoCaptureSdk = {
  actionTimeoutMs: ${validationActionTimeoutMs},
  context: makeADemoCaptureContext,
  startedAt: makeADemoCaptureStartedAt,
};
const makeADemoFailureScreenshotPath = new URL(
  "./makeademo-validation-failure.png",
  import.meta.url,
).pathname;

try {
  // Generated protocol: parent validation parses these stdout/stderr markers; keep non-Pino.
  console.log("[makeademo:validation] script started", JSON.stringify({ baseUrl }));
${indentScriptBody(validationScript)}
  console.log("[makeademo:validation] script succeeded", JSON.stringify({ title: await page.title(), url: page.url() }));
} catch (error) {
  let screenshotPath;
  try {
    await page.screenshot({ fullPage: true, path: makeADemoFailureScreenshotPath });
    screenshotPath = makeADemoFailureScreenshotPath;
  } catch {}
  console.error("[makeademo:validation] script failed", JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    title: await page.title().catch(() => ""),
    url: page.url(),
  }));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
void expect;
void setup;
void scene;
`;
}

function runtimeNetworkSource(policy = defaultRuntimeNetworkPolicy) {
  if (policy === "unrestricted-public") return "";
  return `const makeADemoAllowedRuntimeOrigin = new URL(baseUrl).origin;
const makeADemoOriginalFetch = globalThis.fetch?.bind(globalThis);
if (makeADemoOriginalFetch !== undefined) {
  globalThis.fetch = async (resource, init) => {
    const requestUrl = typeof resource === "string" || resource instanceof URL
      ? new URL(resource, baseUrl).toString()
      : new URL(resource.url, baseUrl).toString();
    if (!isMakeADemoAllowedRuntimeRequest(requestUrl)) {
      // Generated protocol: parent validation/capture parses blocked-network markers from stderr.
      console.error("[makeademo:network-blocked]", JSON.stringify({
        direction: "outbound",
        host: new URL(requestUrl).host,
        phase: "runtime",
        resourceType: "fetch",
        url: requestUrl,
      }));
      throw new Error(\`MakeADemo blocked runtime network access to \${requestUrl}\`);
    }

    return await makeADemoOriginalFetch(resource, init);
  };
}

await context.route("**/*", async (route) => {
  const request = route.request();
  const requestUrl = request.url();
  if (isMakeADemoAllowedRuntimeRequest(requestUrl)) {
    await route.continue();
    return;
  }

  // Generated protocol: parent validation/capture parses blocked-network markers from stderr.
  console.error("[makeademo:network-blocked]", JSON.stringify({
    direction: "outbound",
    host: new URL(requestUrl).host,
    phase: "runtime",
    resourceType: request.resourceType(),
    url: requestUrl,
  }));
  await route.abort("blockedbyclient");
});

function isMakeADemoAllowedRuntimeRequest(requestUrl) {
  const parsedUrl = new URL(requestUrl);
  if (parsedUrl.protocol === "about:" || parsedUrl.protocol === "blob:" || parsedUrl.protocol === "data:") {
    return true;
  }

  return parsedUrl.origin === makeADemoAllowedRuntimeOrigin;
}
`;
}

function removeCaptureSdkImportsFromBody(script: string) {
  return script
    .split("\n")
    .filter((line) => !/from\s+['"].*makeademo-capture-sdk['"]/.test(line))
    .join("\n");
}

function replacePlaywrightModuleSpecifier(
  script: string,
  playwrightModuleSpecifier: string,
) {
  return script.replaceAll(
    /from\s+(["'])@playwright\/test\1/g,
    `from ${JSON.stringify(playwrightModuleSpecifier)}`,
  );
}

function injectRecordingHelpers(script: string) {
  if (script.includes("async function animatedClick(page, locator)")) {
    return script;
  }

  const importMatch = script.match(/^import .*?;\n+/m);
  if (!importMatch?.[0]) {
    return `${interactionHelperSource()}\n${script}`;
  }

  return script.replace(
    importMatch[0],
    `${importMatch[0]}${interactionHelperSource()}\n`,
  );
}

function stylizeBrowserActions(script: string) {
  return script
    .split("\n")
    .map((line) => stylizeBrowserActionLine(line))
    .join("\n");
}

function stylizeBrowserActionLine(line: string) {
  const scrollToBottomMatch = line.match(
    /^(\s*)await\s+(.+)\.evaluate\(\(element\)\s*=>\s*\{\s*element\.scrollTop\s*=\s*element\.scrollHeight;\s*\}\);(\s*)$/,
  );
  if (scrollToBottomMatch?.[1] !== undefined && scrollToBottomMatch[2]) {
    return `${scrollToBottomMatch[1]}await animatedScrollTo(page, ${scrollToBottomMatch[2]}, "bottom");${scrollToBottomMatch[3] ?? ""}`;
  }

  const scrollToTopMatch = line.match(
    /^(\s*)await\s+(.+)\.evaluate\(\(element\)\s*=>\s*\{\s*element\.scrollTop\s*=\s*0;\s*\}\);(\s*)$/,
  );
  if (scrollToTopMatch?.[1] !== undefined && scrollToTopMatch[2]) {
    return `${scrollToTopMatch[1]}await animatedScrollTo(page, ${scrollToTopMatch[2]}, "top");${scrollToTopMatch[3] ?? ""}`;
  }

  const clickMatch = line.match(/^(\s*)await\s+(.+)\.click\(\);(\s*)$/);
  if (clickMatch?.[1] !== undefined && clickMatch[2]) {
    return `${clickMatch[1]}await animatedClick(page, ${clickMatch[2]});${clickMatch[3] ?? ""}`;
  }

  const hoverMatch = line.match(/^(\s*)await\s+(.+)\.hover\(\);(\s*)$/);
  if (hoverMatch?.[1] !== undefined && hoverMatch[2]) {
    return `${hoverMatch[1]}await animatedHover(page, ${hoverMatch[2]});${hoverMatch[3] ?? ""}`;
  }

  const fillMatch = line.match(/^(\s*)await\s+(.+)\.fill\((.*)\);(\s*)$/);
  if (fillMatch?.[1] !== undefined && fillMatch[2] && fillMatch[3]) {
    return `${fillMatch[1]}await humanType(page, ${fillMatch[2]}, ${fillMatch[3]});${fillMatch[4] ?? ""}`;
  }

  return line;
}

function interactionHelperSource(
  timingProfile: "recording" | "validation" = "recording",
) {
  const validationTiming = timingProfile === "validation";

  return `const humanTypingDelayMs = ${validationTiming ? 0 : 100};
const pointerAnimationDurationMs = ${validationTiming ? 0 : 520};
const pointerMoveSteps = ${validationTiming ? 1 : 18};
const pointerPulseDownMs = ${validationTiming ? 0 : 90};
const pointerPulseUpMs = ${validationTiming ? 0 : 120};
const hoverPauseMs = ${validationTiming ? 0 : 450};
const scrollAnimationDurationMs = ${validationTiming ? 0 : 760};
const presentationCuesEnabled = ${validationTiming ? "false" : "true"};

async function animatedClick(page, locator) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();

  if (!box) {
    await target.click();
    return;
  }

  const targetPoint = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };

  await showRecordingPointer(page, targetPoint);
  await target.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await pulseRecordingPointer(page);
}

async function animatedHover(page, locator) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();

  if (!box) {
    return;
  }

  const targetPoint = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };

  await showRecordingPointer(page, targetPoint);
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: pointerMoveSteps });
  if (hoverPauseMs > 0) {
    await page.waitForTimeout(hoverPauseMs);
  }
}

async function humanType(page, locator, text) {
  const target = locator.first();
  await animatedClick(page, target);
  await target.fill("");
  await target.pressSequentially(String(text), { delay: humanTypingDelayMs });
}

async function animatedScrollTo(page, locator, position) {
  const target = locator.first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();

  if (box) {
    await showRecordingPointer(page, {
      x: box.x + box.width - 18,
      y: box.y + box.height / 2,
    });
    if (presentationCuesEnabled) {
      await showScrollCue(page, box, position);
    }
  }

  try {
    await target.evaluate(async (element, { durationMs, position }) => {
      const start = element.scrollTop;
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const end = position === "bottom" ? maxScrollTop : 0;
      if (durationMs === 0) {
        element.scrollTop = end;
        return;
      }
      const startedAt = performance.now();

      await new Promise((resolve) => {
        function animate(now) {
          const progress = Math.min(1, (now - startedAt) / durationMs);
          const eased = 1 - (1 - progress) ** 3;
          element.scrollTop = start + (end - start) * eased;

          if (progress < 1) {
            requestAnimationFrame(animate);
            return;
          }

          element.scrollTop = end;
          resolve(undefined);
        }

        requestAnimationFrame(animate);
      });
    }, { durationMs: scrollAnimationDurationMs, position });
  } finally {
    if (box && presentationCuesEnabled) {
      await hideScrollCue(page);
    }
  }
}

async function showScrollCue(page, box, position) {
  await page.evaluate(async ({ box, position }) => {
    const cueId = "makeademo-scroll-cue";
    const existingCue = document.getElementById(cueId);
    existingCue?.remove();

    const cue = document.createElement("div");
    const top = Math.max(16, Math.min(window.innerHeight - 96, box.y + box.height / 2 - 36));
    const left = Math.max(16, Math.min(window.innerWidth - 64, box.x + box.width - 48));
    const direction = position === "bottom" ? 1 : -1;

    cue.id = cueId;
    cue.style.position = "fixed";
    cue.style.left = \`\${left}px\`;
    cue.style.top = \`\${top}px\`;
    cue.style.width = "34px";
    cue.style.height = "72px";
    cue.style.zIndex = "2147483646";
    cue.style.pointerEvents = "none";
    cue.style.opacity = "0";
    cue.style.display = "grid";
    cue.style.placeItems = "center";
    cue.style.gap = "2px";
    cue.style.borderRadius = "999px";
    cue.style.background = "rgba(17, 17, 17, 0.16)";
    cue.style.backdropFilter = "blur(2px)";
    cue.style.transition = "opacity 160ms ease";

    for (let index = 0; index < 3; index += 1) {
      const arrow = document.createElement("div");
      arrow.style.width = "10px";
      arrow.style.height = "10px";
      arrow.style.borderRight = "2px solid rgba(255, 255, 255, 0.92)";
      arrow.style.borderBottom = "2px solid rgba(255, 255, 255, 0.92)";
      arrow.style.transform = position === "bottom" ? "rotate(45deg)" : "rotate(225deg)";
      arrow.style.animation = \`makeademo-scroll-cue 720ms ease-in-out \${index * 120}ms infinite\`;
      cue.append(arrow);
    }

    const style = document.createElement("style");
    style.textContent = \`
      @keyframes makeademo-scroll-cue {
        0% { opacity: 0.24; translate: 0 \${-6 * direction}px; }
        45% { opacity: 0.92; }
        100% { opacity: 0.24; translate: 0 \${8 * direction}px; }
      }
    \`;
    cue.append(style);
    document.documentElement.append(cue);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    cue.style.opacity = "1";
  }, { box, position });
}

async function hideScrollCue(page) {
  await page.evaluate(async () => {
    const cue = document.getElementById("makeademo-scroll-cue");
    if (!cue) {
      return;
    }

    cue.style.opacity = "0";
    await new Promise((resolve) => setTimeout(resolve, 180));
    cue.remove();
  });
}

async function showRecordingPointer(page, targetPoint) {
  await page.evaluate(async ({ durationMs, targetPoint }) => {
    const pointerId = "makeademo-recording-pointer";
    const existingPointer = document.getElementById(pointerId);
    const pointer = existingPointer ?? document.createElement("div");

    if (!existingPointer) {
      pointer.id = pointerId;
      pointer.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path d="M5 3l17 12-8 2 5 7-4 2-5-7-5 6V3z" fill="white" stroke="black" stroke-width="2" stroke-linejoin="round"/></svg>';
      pointer.style.position = "fixed";
      pointer.style.left = "0";
      pointer.style.top = "0";
      pointer.style.zIndex = "2147483647";
      pointer.style.pointerEvents = "none";
      pointer.style.filter = "drop-shadow(0 3px 5px rgba(0, 0, 0, 0.35))";
      pointer.style.transform = \`translate(\${window.innerWidth / 2}px, \${window.innerHeight / 2}px)\`;
      document.documentElement.append(pointer);
    }

    const stateKey = "__makeADemoRecordingPointer";
    const pointerState = window[stateKey] ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    window[stateKey] = pointerState;

    const start = { x: pointerState.x, y: pointerState.y };
    if (durationMs === 0) {
      pointer.style.transform = \`translate(\${targetPoint.x}px, \${targetPoint.y}px)\`;
      pointerState.x = targetPoint.x;
      pointerState.y = targetPoint.y;
      return;
    }
    const startedAt = performance.now();

    await new Promise((resolve) => {
      function animate(now) {
        const progress = Math.min(1, (now - startedAt) / durationMs);
        const eased = 1 - (1 - progress) ** 3;
        const x = start.x + (targetPoint.x - start.x) * eased;
        const y = start.y + (targetPoint.y - start.y) * eased;
        pointer.style.transform = \`translate(\${x}px, \${y}px)\`;

        if (progress < 1) {
          requestAnimationFrame(animate);
          return;
        }

        pointerState.x = targetPoint.x;
        pointerState.y = targetPoint.y;
        resolve(undefined);
      }

      requestAnimationFrame(animate);
    });
  }, { durationMs: pointerAnimationDurationMs, targetPoint });
}

async function pulseRecordingPointer(page) {
  await page.evaluate(async ({ downMs, upMs }) => {
    const pointer = document.getElementById("makeademo-recording-pointer");
    if (!pointer || (downMs === 0 && upMs === 0)) {
      return;
    }

    pointer.style.transition = "transform 80ms ease, opacity 80ms ease";
    pointer.style.opacity = "0.75";
    await new Promise((resolve) => setTimeout(resolve, downMs));
    pointer.style.opacity = "1";
    await new Promise((resolve) => setTimeout(resolve, upMs));
    pointer.style.transition = "";
  }, { downMs: pointerPulseDownMs, upMs: pointerPulseUpMs });
}`;
}

function indentScriptBody(script: string) {
  return script
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
