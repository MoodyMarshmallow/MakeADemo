import { describe, expect, it } from "vitest";

import { parseDemoScript } from "./demo-script/demo-script.schema";
import { generateDemoScript } from "./script-generation-orchestrator";

describe("generateDemoScript", () => {
  it("preserves feature order and creates a continuous event-marked Demo Script", async () => {
    const demoScript = await generateDemoScript(
      {
        demoBrief: { keyProductFeatures: ["repo validation"] },
        normalizedSupportingDocuments: [],
        preparationManifest: manifest(),
        repoUrl: "https://github.com/example/app",
      },
      {},
    );

    expect(parseDemoScript(demoScript).scriptId).toBe(
      "generated-makeademo-script",
    );
    expect(demoScript.demoPlaywrightScript).toContain("await setup");
    expect(demoScript.demoPlaywrightScript).toContain("await scene");
    expect(demoScript.scenes).toEqual([
      expect.objectContaining({ id: "scene-repo-validation" }),
    ]);
  });

  it("keeps duplicate feature scene IDs unique without agent-authored durations", async () => {
    const demoScript = await generateDemoScript(
      {
        demoBrief: { keyProductFeatures: ["Inbox", "Inbox"] },
        normalizedSupportingDocuments: [],
        preparationManifest: manifest(),
        repoUrl: "https://github.com/example/app",
      },
      {},
    );

    expect(demoScript.scenes.map((scene) => scene.id)).toEqual([
      "scene-inbox",
      "scene-inbox-2",
    ]);
    expect(
      demoScript.scenes.every(
        (scene) => !Object.hasOwn(scene, "durationSeconds"),
      ),
    ).toBe(true);
  });
});

function manifest() {
  return {
    assumptions: ["single page app"],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockingPlan: {
      boundaries: [],
      fixturePaths: [],
      loadedPlaybooks: [],
      nativeUiRoots: ["src/App.tsx"],
      plannedPresentationChanges: [],
    },
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}
