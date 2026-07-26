export type SubmittedCodeNodeFamily = 18 | 20 | 22 | 24;

type SubmittedCodeNodeRelease = Readonly<{
  family: SubmittedCodeNodeFamily;
  version: string;
}>;

export type SubmittedCodeNodeReleaseSnapshot = Readonly<{
  releases: readonly SubmittedCodeNodeRelease[];
  source: "https://nodejs.org/dist/index.json" | "test-fixture";
}>;

/**
 * Supplies one immutable, bounded view of trusted Node.js releases for a
 * Pipeline Job. Implementations must return the same frozen snapshot for every
 * load call and must never derive releases from submitted repository data.
 */
export interface SubmittedCodeNodeReleaseCatalog {
  load(): Promise<SubmittedCodeNodeReleaseSnapshot>;
}

export type SubmittedCodeNodeReleaseCatalogErrorCode =
  | "fetch_failed"
  | "invalid_response"
  | "response_too_large"
  | "timed_out"
  | "too_many_releases";

/** A trusted-catalog infrastructure failure that callers must preserve. */
export class SubmittedCodeNodeReleaseCatalogError extends Error {
  constructor(
    readonly code: SubmittedCodeNodeReleaseCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubmittedCodeNodeReleaseCatalogError";
  }
}

export const submittedCodeNodeCompatibility = Object.freeze({
  18: Object.freeze({
    compatibilityMinimum: "18.18.0",
    knownGoodFloor: "18.20.8",
    lifecycle: "legacy-eol" as const,
  }),
  20: Object.freeze({
    compatibilityMinimum: "20.19.0",
    knownGoodFloor: "20.19.5",
    lifecycle: "legacy-eol" as const,
  }),
  22: Object.freeze({
    compatibilityMinimum: "22.12.0",
    knownGoodFloor: "22.23.1",
    lifecycle: "supported" as const,
  }),
  24: Object.freeze({
    compatibilityMinimum: "24.0.0",
    knownGoodFloor: "24.0.0",
    lifecycle: "supported" as const,
  }),
});

export const submittedCodeKnownGoodNodeReleaseSnapshot: SubmittedCodeNodeReleaseSnapshot =
  deepFreezeSnapshot({
    releases: Object.entries(submittedCodeNodeCompatibility).map(
      ([family, policy]) => ({
        family: Number(family) as SubmittedCodeNodeFamily,
        version: policy.knownGoodFloor,
      }),
    ),
    source: "test-fixture",
  });

export const submittedCodeKnownGoodNodeReleaseCatalog: SubmittedCodeNodeReleaseCatalog =
  Object.freeze({
    async load() {
      return submittedCodeKnownGoodNodeReleaseSnapshot;
    },
  });

export function deepFreezeSnapshot(
  snapshot: SubmittedCodeNodeReleaseSnapshot,
): SubmittedCodeNodeReleaseSnapshot {
  const releases = snapshot.releases.map((release) =>
    Object.freeze({ ...release }),
  );
  return Object.freeze({
    releases: Object.freeze(releases),
    source: snapshot.source,
  });
}
