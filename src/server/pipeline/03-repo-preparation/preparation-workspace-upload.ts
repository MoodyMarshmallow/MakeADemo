import type {
  PreparationWorkspace,
  PreparationWorkspaceUploadFile,
} from "./preparation-workspace.interface";

export async function uploadSubmittedCodeWorkspaceFiles(input: {
  files: PreparationWorkspaceUploadFile[];
  workspace: PreparationWorkspace;
}): Promise<void> {
  const upload =
    input.workspace.uploadSubmittedCodeFiles ?? input.workspace.uploadFiles;
  await upload.call(input.workspace, input.files);
}
