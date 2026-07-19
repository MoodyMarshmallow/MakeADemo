import type { PreCaptureCliOptions } from "./pre-capture-cli-options";

type PreCaptureCliPrompt = (question: string) => Promise<string>;

export type PreCaptureCliInteractiveIO = {
  prompt: PreCaptureCliPrompt;
  write: (message: string) => void;
};

export async function collectPreCaptureCliOptions(
  io: PreCaptureCliInteractiveIO,
): Promise<PreCaptureCliOptions> {
  io.write("MakeADemo Pre-Capture CLI");
  io.write("Press Enter to accept defaults where shown.");

  const repoUrl = await promptUntilValid(
    io,
    "GitHub repo URL: ",
    isGitHubHttpsUrl,
    "Invalid repo URL. Use a GitHub HTTPS URL like https://github.com/owner/repo.",
  );
  const features = splitCsv(
    await promptUntilValid(
      io,
      "Key product features to demo, separated by commas: ",
      (value) => splitCsv(value).length > 0,
      "Invalid features. Provide at least one feature, separated by commas.",
    ),
  );
  const docs = splitCsv(
    await io.prompt(
      "Supporting document paths, separated by commas (optional): ",
    ),
  );
  return {
    docs,
    features,
    repoUrl,
    workspaceId: createWorkspaceId(repoUrl),
  };
}

async function promptUntilValid(
  io: PreCaptureCliInteractiveIO,
  question: string,
  validate: (value: string) => boolean,
  invalidMessage: string,
): Promise<string> {
  while (true) {
    const value = (await io.prompt(question)).trim();

    if (validate(value)) {
      return value;
    }

    io.write(invalidMessage);
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isGitHubHttpsUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(value);
}

function createWorkspaceId(repoUrl: string): string {
  const slug = repoUrl
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `workspace-${slug}-${Date.now()}`;
}
