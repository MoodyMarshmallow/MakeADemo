import { describe, expect, it } from "vitest";

import {
  canContinueFromRepoStep,
  collectIntakeDetails,
  connectGitHubInstallation,
  connectGitHubInstallationRepositories,
  createInitialContextGatheringDraft,
  rejectUnsupportedSupportingFile,
  removePendingSupportingFile,
  selectRepositoryForDemo,
  setRepoDetails,
  stagePendingSupportingFiles,
  startContextGatheringSubmission,
} from "./draft";

describe("Context Gathering draft", () => {
  it("collects the combined intake form into structured context and transcript", () => {
    const draft = setRepoDetails(createInitialContextGatheringDraft(), {
      repoUrl: "https://github.com/example/app",
      repoVisibility: "public",
    });

    const collected = collectIntakeDetails(
      draft,
      {
        email: "founder@example.com",
        importantFeatures: "Context gathering and video rendering.",
        name: "Anqi",
        productSummary: "MakeADemo creates demo videos from runnable apps.",
        requestedDurationSeconds: 60,
        targetUsers: "Founders and product teams.",
      },
      { now: () => "2026-06-07T17:05:00.000Z" },
    );

    expect(collected.contact).toEqual({
      email: "founder@example.com",
      name: "Anqi",
    });
    expect(collected.structuredContext).toEqual({
      importantFeatures: "Context gathering and video rendering.",
      productSummary: "MakeADemo creates demo videos from runnable apps.",
      requestedDurationSeconds: 60,
      targetUsers: "Founders and product teams.",
    });
    expect(collected.chatStep).toBe("details");
    expect(collected.contextTranscript.map((message) => message.text)).toEqual([
      "What is your name and email address",
      "Anqi, founder@example.com",
      "Tell us about your product in a few sentences",
      "MakeADemo creates demo videos from runnable apps.",
      "Tell us more about your target users",
      "Founders and product teams.",
      "What are the most important features",
      "Context gathering and video rendering.",
      "How long do you want the demo video to be? Choose between 30s-3min.",
      "1 minute",
    ]);
  });

  it("only requires name and email when collecting the combined intake form", () => {
    const draft = setRepoDetails(createInitialContextGatheringDraft(), {
      repoUrl: "https://github.com/example/app",
      repoVisibility: "public",
    });

    const collected = collectIntakeDetails(
      draft,
      {
        email: "founder@example.com",
        importantFeatures: "",
        name: "Anqi",
        productSummary: "",
        requestedDurationSeconds: 60,
        targetUsers: "",
      },
      { now: () => "2026-06-07T17:05:00.000Z" },
    );

    expect(collected.contact).toEqual({
      email: "founder@example.com",
      name: "Anqi",
    });
    expect(collected.structuredContext).toEqual({
      importantFeatures: "",
      productSummary: "",
      requestedDurationSeconds: 60,
      targetUsers: "",
    });
    expect(collected.contextTranscript.map((message) => message.text)).toEqual([
      "What is your name and email address",
      "Anqi, founder@example.com",
      "How long do you want the demo video to be? Choose between 30s-3min.",
      "1 minute",
    ]);
  });

  it("rejects a demo duration below 30 seconds", () => {
    const draft = setRepoDetails(createInitialContextGatheringDraft(), {
      repoUrl: "https://github.com/example/app",
      repoVisibility: "public",
    });

    expect(() =>
      collectIntakeDetails(draft, {
        email: "founder@example.com",
        importantFeatures: "",
        name: "Anqi",
        productSummary: "",
        requestedDurationSeconds: 29,
        targetUsers: "",
      }),
    ).toThrow("Demo duration must be between 30 seconds and 3 minutes");
  });

  it("rejects a demo duration above 180 seconds", () => {
    const draft = setRepoDetails(createInitialContextGatheringDraft(), {
      repoUrl: "https://github.com/example/app",
      repoVisibility: "public",
    });

    expect(() =>
      collectIntakeDetails(draft, {
        email: "founder@example.com",
        importantFeatures: "",
        name: "Anqi",
        productSummary: "",
        requestedDurationSeconds: 181,
        targetUsers: "",
      }),
    ).toThrow("Demo duration must be between 30 seconds and 3 minutes");
  });

  it("moves collected Project Intake to submitting before the API returns", () => {
    const draft = collectIntakeDetails(
      setRepoDetails(createInitialContextGatheringDraft(), {
        repoUrl: "https://github.com/example/app",
        repoVisibility: "public",
      }),
      {
        email: "founder@example.com",
        importantFeatures: "Repo validation.",
        name: "Anqi",
        productSummary: "MakeADemo creates demo videos.",
        requestedDurationSeconds: 60,
        targetUsers: "Builders.",
      },
      { now: () => "2026-06-07T17:05:00.000Z" },
    );

    const submitting = startContextGatheringSubmission(draft);

    expect(submitting.chatStep).toBe("submitting");
    expect(submitting.contact).toEqual(draft.contact);
    expect(submitting.structuredContext).toEqual(draft.structuredContext);
  });

  it("rejects image and video Supporting Documents", () => {
    expect(() =>
      rejectUnsupportedSupportingFile({ name: "hero.png", type: "image/png" }),
    ).toThrow("Supporting Documents cannot be videos or pictures");
    expect(() =>
      rejectUnsupportedSupportingFile({ name: "clip.mp4", type: "video/mp4" }),
    ).toThrow("Supporting Documents cannot be videos or pictures");
  });

  it("stages Supporting Documents locally and removes them before final submission", () => {
    const staged = stagePendingSupportingFiles(
      [],
      [
        { name: "Product Brief.md", size: 120, type: "text/markdown" },
        {
          name: "Pitch Deck.pptx",
          size: 240,
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ],
      { createId: () => "file-1" },
    );

    expect(staged.map((file) => file.fileName)).toEqual([
      "Product Brief.md",
      "Pitch Deck.pptx",
    ]);
    expect(removePendingSupportingFile(staged, "file-1-0")).toEqual([
      staged[1],
    ]);
  });

  it("keeps a connected GitHub installation on the repo step until one repo is selected and continued", () => {
    let draft = createInitialContextGatheringDraft();

    draft = connectGitHubInstallation(draft, "installation-123");
    expect(draft.chatStep).toBe("repo");
    expect(draft.githubInstallationId).toBe("installation-123");
    expect(draft.repoVisibility).toBe("private");

    draft = selectRepositoryForDemo(draft, {
      private: true,
      repoUrl: "https://github.com/example/private-app",
    });
    expect(draft.chatStep).toBe("repo");
    expect(draft.repoUrl).toBe("https://github.com/example/private-app");
    expect(draft.repoVisibility).toBe("private");

    draft = setRepoDetails(draft, {
      ...(draft.githubInstallationId === undefined
        ? {}
        : { githubInstallationId: draft.githubInstallationId }),
      repoUrl: draft.repoUrl,
      repoVisibility: draft.repoVisibility,
    });
    expect(draft.chatStep).toBe("details");
  });

  it("only allows the repo step to continue after a public URL is pasted or one GitHub repo is selected", () => {
    let draft = createInitialContextGatheringDraft();

    expect(canContinueFromRepoStep(draft, "")).toBe(false);
    expect(
      canContinueFromRepoStep(draft, "https://github.com/example/app"),
    ).toBe(true);

    draft = connectGitHubInstallation(draft, "installation-123");
    expect(canContinueFromRepoStep(draft, "")).toBe(false);

    draft = selectRepositoryForDemo(draft, {
      private: true,
      repoUrl: "https://github.com/example/private-app",
    });
    expect(canContinueFromRepoStep(draft, "")).toBe(true);
  });

  it("stores trimmed public repository URLs when continuing from the repo step", () => {
    const draft = setRepoDetails(createInitialContextGatheringDraft(), {
      repoUrl: " https://github.com/example/app ",
      repoVisibility: "public",
    });

    expect(draft.repoUrl).toBe("https://github.com/example/app");
  });

  it("auto-selects the first repository returned for a connected GitHub installation", () => {
    const draft = connectGitHubInstallationRepositories(
      createInitialContextGatheringDraft(),
      {
        githubInstallationId: "installation-123",
        repositories: [
          {
            private: true,
            repoUrl: "https://github.com/example/first-app",
          },
          {
            private: true,
            repoUrl: "https://github.com/example/second-app",
          },
        ],
      },
    );

    expect(draft.githubInstallationId).toBe("installation-123");
    expect(draft.repoUrl).toBe("https://github.com/example/first-app");
    expect(draft.repoVisibility).toBe("private");
    expect(canContinueFromRepoStep(draft, "")).toBe(true);
  });
});
