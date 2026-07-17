import {
  type BenchmarkRepo,
  buildBenchmarkPipelineArgs,
  readBenchmarkManifest,
} from "./benchmark-manifest";

export const benchmarkSuite = readBenchmarkManifest({
  defaults: {
    provider: "openai",
    repetitions: 1,
  },
  repos: [
    {
      categories: [
        "finance",
        "fullstack",
        "nextjs",
        "react",
        "monorepo",
        "database",
        "auth",
        "external-services",
        "production",
      ],
      commitSha: "e27b7040efdea2b3d1cca2553a4def7aaf11a053",
      expectedLevel: "L6",
      features: [
        "Open the financial overview and explain the cash flow, revenue, and expense metrics",
        "Browse and filter transactions, then inspect one transaction and its categorization",
        "Create an invoice for a customer and preview its line items and payment details",
      ],
      id: "midday",
      repoUrl: "https://github.com/midday-ai/midday",
    },
    {
      categories: [
        "scheduling",
        "fullstack",
        "nextjs",
        "monorepo",
        "database",
        "auth",
        "external-services",
        "production",
      ],
      commitSha: "1c193cca8682b33b9866c792186033f7ef886682",
      expectedLevel: "L6",
      features: [
        "Show the event type dashboard and open a public scheduling link",
        "Choose an available time and complete a booking with attendee details",
        "Configure weekly availability and the duration of an event type",
      ],
      id: "calcom",
      repoUrl: "https://github.com/calcom/cal.diy",
    },
    {
      categories: [
        "cms",
        "fullstack",
        "vue",
        "monorepo",
        "database",
        "auth",
        "production",
      ],
      commitSha: "083bf1e1a56cf775eb726a6ebd1764cf9d919115",
      expectedLevel: "L6",
      features: [
        "Create a collection with text and status fields in the data model",
        "Add and edit an item through the visual content studio",
        "Show how collection permissions or API access are configured",
      ],
      id: "directus",
      repoUrl: "https://github.com/directus/directus",
    },
    {
      categories: [
        "collaboration",
        "fullstack",
        "react",
        "go",
        "monorepo",
        "database",
        "auth",
        "large",
        "production",
      ],
      commitSha: "583461af10fc9b2aef2871c722fc4376db695832",
      expectedLevel: "L6",
      features: [
        "Sign in to a team workspace and browse channels with their recent messages",
        "Post a message, reply in a thread, and add an emoji reaction",
        "Search messages across channels and open a matching result in context",
      ],
      id: "mattermost",
      repoUrl: "https://github.com/mattermost/mattermost",
    },
    {
      categories: [
        "publishing",
        "fullstack",
        "ember",
        "nodejs",
        "database",
        "auth",
        "production",
      ],
      commitSha: "fe231002ca5c9c938e0e719727b483f14ebd5d00",
      expectedLevel: "L6",
      features: [
        "Open the admin dashboard and browse published posts and drafts",
        "Create a draft post with formatted content and preview the public article",
        "Configure publication branding, navigation, or membership settings",
      ],
      id: "ghost",
      repoUrl: "https://github.com/TryGhost/Ghost",
    },
    {
      categories: [
        "finance",
        "fullstack",
        "angular",
        "nestjs",
        "monorepo",
        "database",
        "auth",
        "external-services",
        "production",
      ],
      commitSha: "92c663874e87dbd72f05e2a24af9f82ca7406622",
      expectedLevel: "L6",
      features: [
        "Show the portfolio overview with current value, performance, and allocation charts",
        "Add or import an investment transaction into an account",
        "Inspect portfolio analysis such as holdings, allocation, or risk insights",
      ],
      id: "ghostfolio",
      repoUrl: "https://github.com/ghostfolio/ghostfolio",
    },
    {
      categories: [
        "knowledge-base",
        "fullstack",
        "react",
        "koa",
        "typescript",
        "database",
        "auth",
        "production",
      ],
      commitSha: "8170639085963919945138328bc4d199b11fd781",
      expectedLevel: "L6",
      features: [
        "Browse a collection and open a document from the workspace sidebar",
        "Create a document with headings, formatted text, and a checklist",
        "Search the knowledge base and show a document's sharing or revision controls",
      ],
      id: "outline",
      repoUrl: "https://github.com/outline/outline",
    },
    {
      categories: [
        "crm",
        "fullstack",
        "react",
        "nestjs",
        "monorepo",
        "database",
        "auth",
        "large",
        "production",
      ],
      commitSha: "c6f03800707d77429a6f8f9b7765a3ae9f268b3e",
      expectedLevel: "L6",
      features: [
        "Browse companies and people, then inspect a CRM record and its activity timeline",
        "Create an opportunity and move it through a pipeline or kanban view",
        "Customize an object view by filtering, sorting, or selecting visible fields",
      ],
      id: "twenty",
      repoUrl: "https://github.com/twentyhq/twenty",
    },
    {
      categories: [
        "whiteboard",
        "frontend",
        "react",
        "typescript",
        "canvas",
        "local-first",
        "production",
      ],
      commitSha: "a2ec2889babf7d2295469c6d90ebe77fae57df84",
      expectedLevel: "L6",
      features: [
        "Draw and label several shapes, then connect them with arrows to make a diagram",
        "Select and rearrange diagram elements while demonstrating undo and redo",
        "Switch the canvas theme and export the finished drawing as an image",
      ],
      id: "excalidraw",
      repoUrl: "https://github.com/excalidraw/excalidraw",
    },
    {
      categories: [
        "developer-tools",
        "frontend",
        "javascript",
        "webpack",
        "local-first",
        "production",
      ],
      commitSha: "d358d82cbcb269d764a2deb598a37043bd054f45",
      expectedLevel: "L6",
      features: [
        "Paste sample input, add an encoding operation to the recipe, and inspect the transformed output",
        "Chain multiple recipe operations and reorder or disable one to show the output updating",
        "Use Magic or operation search to identify and decode an encoded sample",
      ],
      id: "cyberchef",
      repoUrl: "https://github.com/gchq/CyberChef",
    },
  ],
  version: 1,
});

export const benchmarkRepos = benchmarkSuite.repos;

/** Selects requested benchmark repos while preserving suite importance order. */
export function selectBenchmarkRepos(input: {
  repoIds: readonly string[];
  repos: readonly BenchmarkRepo[];
}): BenchmarkRepo[] {
  if (input.repoIds.length === 0) {
    return [...input.repos];
  }

  const availableRepoIds = new Set(input.repos.map((repo) => repo.id));
  const unknownRepoId = input.repoIds.find(
    (repoId) => !availableRepoIds.has(repoId),
  );
  if (unknownRepoId !== undefined) {
    throw new Error(
      `Unknown benchmark repo id: ${unknownRepoId}. Available repo ids: ${input.repos.map((repo) => repo.id).join(", ")}`,
    );
  }

  const requestedRepoIds = new Set(input.repoIds);
  return input.repos.filter((repo) => requestedRepoIds.has(repo.id));
}

export { buildBenchmarkPipelineArgs };
