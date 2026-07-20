export type RepoVisibility = "private" | "public";

type ChatPromptId =
  | "demo-duration"
  | "important-features"
  | "name-email"
  | "product-summary"
  | "target-users";

type ContextTranscriptMessage = {
  id: string;
  promptId: ChatPromptId;
  role: "assistant" | "user";
  text: string;
  timestamp: string;
};

export type SupportingFileDraft = {
  fileName: string;
  mimeType: string;
  r2Key: string;
  r2Url: string;
  sizeBytes: number;
};

export type IntakeDetailsInput = {
  email: string;
  importantFeatures: string;
  name: string;
  productSummary: string;
  requestedDurationSeconds: number;
  targetUsers: string;
};

export type ContextGatheringDraft = {
  chatStep: "details" | "repo" | "submitting" | "submitted";
  contact: {
    email: string;
    name: string;
  };
  contextTranscript: ContextTranscriptMessage[];
  draftId: string;
  githubInstallationId?: string;
  repoUrl: string;
  repoVisibility: RepoVisibility;
  structuredContext: {
    importantFeatures: string;
    productSummary: string;
    requestedDurationSeconds?: number;
    targetUsers: string;
  };
  supportingFiles: SupportingFileDraft[];
};

type Clock = {
  now?: () => string;
};

type BrowserFileLike = {
  name: string;
  size?: number;
  type: string;
};

type PendingBrowserFileLike = BrowserFileLike & {
  size: number;
};

export type PendingSupportingFileDraft<
  TFile extends PendingBrowserFileLike = PendingBrowserFileLike,
> = {
  file: TFile;
  fileName: string;
  id: string;
  mimeType: string;
  sizeBytes: number;
};

const prompts: Array<{ id: ChatPromptId; text: string }> = [
  { id: "name-email", text: "What is your name and email address" },
  {
    id: "product-summary",
    text: "Tell us about your product in a few sentences",
  },
  { id: "target-users", text: "Tell us more about your target users" },
  { id: "important-features", text: "What are the most important features" },
  {
    id: "demo-duration",
    text: "How long do you want the demo video to be? Choose between 30s-3min.",
  },
];

export function createInitialContextGatheringDraft(
  options: Clock & { createId?: () => string } = {},
): ContextGatheringDraft {
  const now = readNow(options);

  return {
    chatStep: "repo",
    contact: { email: "", name: "" },
    contextTranscript: [
      {
        id: "assistant-name-email",
        promptId: "name-email",
        role: "assistant",
        text: prompts[0]?.text ?? "",
        timestamp: now,
      },
    ],
    draftId: options.createId?.() ?? crypto.randomUUID(),
    repoUrl: "",
    repoVisibility: "public",
    structuredContext: {
      importantFeatures: "",
      productSummary: "",
      targetUsers: "",
    },
    supportingFiles: [],
  };
}

export function setRepoDetails(
  draft: ContextGatheringDraft,
  input: {
    githubInstallationId?: string;
    repoUrl: string;
    repoVisibility: RepoVisibility;
  },
): ContextGatheringDraft {
  return {
    ...draft,
    chatStep: "details",
    repoUrl: input.repoUrl.trim(),
    repoVisibility: input.repoVisibility,
    ...(input.githubInstallationId === undefined
      ? {}
      : { githubInstallationId: input.githubInstallationId }),
  };
}

export function collectIntakeDetails(
  draft: ContextGatheringDraft,
  input: IntakeDetailsInput,
  options: Clock = {},
): ContextGatheringDraft {
  const name = input.name.trim();
  const email = input.email.trim();
  const productSummary = input.productSummary.trim();
  const targetUsers = input.targetUsers.trim();
  const importantFeatures = input.importantFeatures.trim();

  if (name.length === 0) {
    throw new Error("Name is required");
  }

  if (!email.includes("@")) {
    throw new Error("Email must be valid");
  }

  if (
    !Number.isFinite(input.requestedDurationSeconds) ||
    input.requestedDurationSeconds < 30 ||
    input.requestedDurationSeconds > 180
  ) {
    throw new Error("Demo duration must be between 30 seconds and 3 minutes");
  }

  const now = readNow(options);
  const promptAnswers: Array<{
    answer: string;
    prompt: { id: ChatPromptId; text: string };
  }> = [
    {
      answer: `${name}, ${email}`,
      prompt: readPrompt("name-email"),
    },
    ...(productSummary.length === 0
      ? []
      : [
          {
            answer: productSummary,
            prompt: readPrompt("product-summary"),
          },
        ]),
    ...(targetUsers.length === 0
      ? []
      : [
          {
            answer: targetUsers,
            prompt: readPrompt("target-users"),
          },
        ]),
    ...(importantFeatures.length === 0
      ? []
      : [
          {
            answer: importantFeatures,
            prompt: readPrompt("important-features"),
          },
        ]),
    {
      answer: formatDuration(input.requestedDurationSeconds),
      prompt: readPrompt("demo-duration"),
    },
  ];

  return {
    ...draft,
    chatStep: "details",
    contact: {
      email,
      name,
    },
    contextTranscript: promptAnswers.flatMap(({ answer, prompt }, index) => [
      {
        id: `assistant-${prompt.id}-${index * 2}`,
        promptId: prompt.id,
        role: "assistant" as const,
        text: prompt.text,
        timestamp: now,
      },
      {
        id: `user-${prompt.id}-${index * 2 + 1}`,
        promptId: prompt.id,
        role: "user" as const,
        text: answer,
        timestamp: now,
      },
    ]),
    structuredContext: {
      importantFeatures,
      productSummary,
      requestedDurationSeconds: input.requestedDurationSeconds,
      targetUsers,
    },
  };
}

export function startContextGatheringSubmission(
  draft: ContextGatheringDraft,
): ContextGatheringDraft {
  return {
    ...draft,
    chatStep: "submitting",
  };
}

export function connectGitHubInstallation(
  draft: ContextGatheringDraft,
  githubInstallationId: string,
): ContextGatheringDraft {
  return {
    ...draft,
    chatStep: "repo",
    githubInstallationId,
    repoVisibility: "private",
  };
}

export function connectGitHubInstallationRepositories(
  draft: ContextGatheringDraft,
  input: {
    githubInstallationId: string;
    repositories: Array<{
      private: boolean;
      repoUrl: string;
    }>;
  },
): ContextGatheringDraft {
  const connected = connectGitHubInstallation(
    draft,
    input.githubInstallationId,
  );
  const firstRepository = input.repositories[0];
  if (!firstRepository) {
    return connected;
  }

  return selectRepositoryForDemo(connected, firstRepository);
}

export function selectRepositoryForDemo(
  draft: ContextGatheringDraft,
  input: {
    private: boolean;
    repoUrl: string;
  },
): ContextGatheringDraft {
  return {
    ...draft,
    chatStep: "repo",
    repoUrl: input.repoUrl,
    repoVisibility: input.private ? "private" : "public",
  };
}

export function canContinueFromRepoStep(
  draft: ContextGatheringDraft,
  repoInput: string,
): boolean {
  if (draft.githubInstallationId) {
    return draft.repoUrl.startsWith("https://github.com/");
  }

  return repoInput.trim().startsWith("https://github.com/");
}

export function rejectUnsupportedSupportingFile(file: BrowserFileLike): void {
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
    throw new Error("Supporting Documents cannot be videos or pictures");
  }
}

export function stagePendingSupportingFiles<
  TFile extends PendingBrowserFileLike,
>(
  current: Array<PendingSupportingFileDraft<TFile>>,
  files: TFile[],
  options: { createId?: () => string } = {},
): Array<PendingSupportingFileDraft<TFile>> {
  const batchId = options.createId?.() ?? crypto.randomUUID();

  return [
    ...current,
    ...files.map((file, index) => {
      rejectUnsupportedSupportingFile(file);

      return {
        file,
        fileName: file.name,
        id: `${batchId}-${index}`,
        mimeType: file.type || "text/plain",
        sizeBytes: file.size,
      };
    }),
  ];
}

export function removePendingSupportingFile<
  TFile extends PendingBrowserFileLike,
>(
  current: Array<PendingSupportingFileDraft<TFile>>,
  fileId: string,
): Array<PendingSupportingFileDraft<TFile>> {
  return current.filter((file) => file.id !== fileId);
}

function readPrompt(promptId: ChatPromptId) {
  const prompt = prompts.find((item) => item.id === promptId);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${promptId}`);
  }

  return prompt;
}

function readNow(options: Clock) {
  return options.now?.() ?? new Date().toISOString();
}

function formatDuration(seconds: number) {
  if (seconds === 30) {
    return "30 seconds";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  }

  return `${seconds} seconds`;
}
