type ArtifactKind = "log" | "screenshot" | "demo-script";

export type PipelineArtifact = {
  contents: string;
  id: string;
  kind: ArtifactKind;
};

export type PipelineArtifactSummary = Pick<PipelineArtifact, "id" | "kind">;
