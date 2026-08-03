import { readSupportingDocumentUpload } from "./supporting-documents";

type ProjectRepoVisibility = "private" | "public";

type SupportingFileSubmission = {
  fileName: string;
  mimeType: string;
  r2Key: string;
  r2Url: string;
  sizeBytes: number;
};

export type ContextGatheringSubmission = {
  contact: {
    email: string;
    name: string;
  };
  githubInstallationId?: string;
  repoUrl: string;
  repoVisibility: ProjectRepoVisibility;
  structuredContext: {
    importantFeatures: string;
    productSummary: string;
    requestedDurationSeconds: number;
    targetUsers: string;
  };
  supportingFiles: SupportingFileSubmission[];
};

type ContextGatheringProjectContext = {
  importantFeatures: string;
  productSummary: string;
  requestedDurationSeconds: number;
  targetUsers: string;
};

export type ContextGatheringStoreInput = {
  project: {
    commitSha: string;
    context: ContextGatheringProjectContext;
    githubInstallationId?: string;
    repoUrl: string;
    repoVisibility: ProjectRepoVisibility;
    supportingFiles: string[];
  };
  user: {
    email: string;
    name: string;
  };
};

export type ContextGatheringSubmitResult = {
  demoRequestId: string;
  projectId: string;
  status: "queued";
};

/**
 * Persists Context Gathering intake and places the Project on the demo queue.
 * Implementations must perform the user, Project, and Demo Request writes in one
 * durable transaction and store queue status only on the Project.
 */
export interface ContextGatheringStore {
  createQueuedProject(
    input: ContextGatheringStoreInput,
  ): Promise<ContextGatheringSubmitResult>;
}

/** Resolves the immutable source revision selected during Project Intake. */
export interface RepositoryRevisionResolver {
  resolve(input: {
    githubInstallationId?: string;
    repoUrl: string;
  }): Promise<string>;
}

export async function submitContextGathering(
  input: ContextGatheringSubmission,
  dependencies: {
    revisionResolver: RepositoryRevisionResolver;
    store: ContextGatheringStore;
  },
): Promise<ContextGatheringSubmitResult> {
  validateSubmission(input);
  const supportingFiles = input.supportingFiles.map(serializeSupportingFile);
  const commitSha = readCommitSha(
    await dependencies.revisionResolver.resolve({
      repoUrl: input.repoUrl,
      ...(input.githubInstallationId === undefined
        ? {}
        : { githubInstallationId: input.githubInstallationId }),
    }),
  );

  return dependencies.store.createQueuedProject({
    project: {
      commitSha,
      context: createProjectContext(input.structuredContext),
      repoUrl: input.repoUrl,
      repoVisibility: input.repoVisibility,
      supportingFiles,
      ...(input.githubInstallationId === undefined
        ? {}
        : { githubInstallationId: input.githubInstallationId }),
    },
    user: {
      email: input.contact.email,
      name: input.contact.name,
    },
  });
}

function readCommitSha(value: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("repository revision must resolve to a full commit SHA");
  }
  return value.toLowerCase();
}

function createProjectContext(
  input: ContextGatheringSubmission["structuredContext"],
): ContextGatheringProjectContext {
  return {
    importantFeatures: input.importantFeatures,
    productSummary: input.productSummary,
    requestedDurationSeconds: input.requestedDurationSeconds,
    targetUsers: input.targetUsers,
  };
}

function serializeSupportingFile(file: SupportingFileSubmission) {
  const upload = readSupportingDocumentUpload({
    artifactId: readNonEmptyString(file.r2Url, "r2Url"),
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  });

  return JSON.stringify({
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    r2Key: readNonEmptyString(file.r2Key, "r2Key"),
    r2Url: upload.artifactId,
    sizeBytes: upload.sizeBytes,
  });
}

function validateSubmission(input: ContextGatheringSubmission) {
  if (!input.repoUrl.startsWith("https://github.com/")) {
    throw new Error("repoUrl must be a GitHub HTTPS URL");
  }

  if (input.repoVisibility === "private" && !input.githubInstallationId) {
    throw new Error("githubInstallationId is required for private repos");
  }

  if (!input.contact.email.includes("@")) {
    throw new Error("email must be valid");
  }

  if (input.contact.name.trim().length === 0) {
    throw new Error("name is required");
  }

  if (!Array.isArray(input.supportingFiles)) {
    throw new Error("supportingFiles must be an array");
  }

  const duration = input.structuredContext.requestedDurationSeconds;
  if (!Number.isFinite(duration) || duration < 30 || duration > 180) {
    throw new Error("requestedDurationSeconds must be between 30 and 180");
  }
}

function readNonEmptyString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}
