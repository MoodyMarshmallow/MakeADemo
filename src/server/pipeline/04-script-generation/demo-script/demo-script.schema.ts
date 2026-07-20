export type SceneDescription = {
  id: string;
  humanReadableDescription: string;
  expectedVisibleOutcome: string;
};

export type DemoScript = {
  demoPlaywrightScript: string;
  format: string;
  presentation: DemoScriptPresentation;
  scenes: SceneDescription[];
  scriptId: string;
  title: string;
  version: number;
};

type DemoScriptPresentation = {
  music: DemoScriptMusicIntent;
  textOverlays: DemoScriptTextOverlay[];
  transitions: DemoScriptTransition[];
};

type DemoScriptMusicIntent =
  | { enabled: false }
  | { enabled: true; trackId: ApprovedMusicTrackId };

type DemoScriptTextOverlay = {
  content: string;
  font: ApprovedFontFamily;
  position: "bottom-left" | "center" | "top-left";
  sceneId: string;
  size: "large" | "medium" | "small";
};

type DemoScriptTransition = {
  durationSeconds: number;
  fromSceneId: string;
  style: "cut" | "fade";
  toSceneId: string;
};

type ApprovedFontFamily = (typeof approvedFontFamilies)[number];
type ApprovedMusicTrackId = (typeof approvedMusicTrackIds)[number];

const approvedFontFamilies = [
  "Bricolage Grotesque",
  "Fraunces",
  "IBM Plex Sans",
  "Inter",
  "JetBrains Mono",
  "Nunito",
  "Playfair Display",
  "Space Grotesk",
] as const;

const approvedMusicTrackIds = [
  "clean",
  "focus",
  "pulse",
  "upbeat",
  "vision",
] as const;

export function parseDemoScript(value: unknown): DemoScript {
  const scriptRecord = assertRecord(value, "Demo Script");
  const demoPlaywrightScript = readNonEmptyString(
    scriptRecord,
    "demoPlaywrightScript",
  );
  const scenes = readScenes(scriptRecord);
  const sceneIds = new Set(scenes.map((scene) => scene.id));

  const demoScript: DemoScript = {
    demoPlaywrightScript,
    format: readSupportedFormat(scriptRecord),
    presentation: readPresentation(scriptRecord, sceneIds),
    scenes,
    scriptId: readNonEmptyString(scriptRecord, "scriptId"),
    title: readNonEmptyString(scriptRecord, "title"),
    version: readPositiveNumber(scriptRecord, "version"),
  };

  return demoScript;
}

function readScenes(scriptRecord: Record<string, unknown>) {
  const scenes = scriptRecord.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("scenes must be a non-empty array");
  }

  const seenSceneIds = new Set<string>();

  return scenes.map((scene, sceneIndex): SceneDescription => {
    const path = `scenes[${sceneIndex}]`;
    const sceneRecord = assertRecord(scene, path);
    if ("durationSeconds" in sceneRecord) {
      throw new Error(`${path}.durationSeconds is not allowed`);
    }
    const id = readNonEmptyString(sceneRecord, "id", path);
    if (seenSceneIds.has(id)) {
      throw new Error(`${path}.id must be unique`);
    }
    seenSceneIds.add(id);

    return {
      expectedVisibleOutcome: readNonEmptyString(
        sceneRecord,
        "expectedVisibleOutcome",
        path,
      ),
      humanReadableDescription: readNonEmptyString(
        sceneRecord,
        "humanReadableDescription",
        path,
      ),
      id,
    };
  });
}

function readPresentation(
  scriptRecord: Record<string, unknown>,
  sceneIds: Set<string>,
): DemoScriptPresentation {
  const presentationRecord = assertRecord(
    scriptRecord.presentation,
    "presentation",
  );

  return {
    music: readMusicIntent(presentationRecord.music),
    textOverlays: readTextOverlays(presentationRecord.textOverlays, sceneIds),
    transitions: readTransitions(presentationRecord.transitions, sceneIds),
  };
}

function readMusicIntent(value: unknown): DemoScriptMusicIntent {
  const musicRecord = assertRecord(value, "presentation.music");
  const enabled = readBoolean(musicRecord, "enabled", "presentation.music");

  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    trackId: readApprovedMusicTrackId(
      musicRecord,
      "trackId",
      "presentation.music",
    ),
  };
}

function readTextOverlays(value: unknown, sceneIds: Set<string>) {
  if (!Array.isArray(value)) {
    throw new Error("presentation.textOverlays must be an array");
  }

  return value.map((overlay, overlayIndex): DemoScriptTextOverlay => {
    const path = `presentation.textOverlays[${overlayIndex}]`;
    const overlayRecord = assertRecord(overlay, path);
    const sceneId = readNonEmptyString(overlayRecord, "sceneId", path);
    assertKnownSceneId(sceneIds, sceneId, `${path}.sceneId`);

    return {
      content: readNonEmptyString(overlayRecord, "content", path),
      font: readApprovedFontFamily(overlayRecord, "font", path),
      position: readEnum(
        overlayRecord,
        "position",
        ["bottom-left", "center", "top-left"],
        path,
      ),
      sceneId,
      size: readEnum(overlayRecord, "size", ["large", "medium", "small"], path),
    };
  });
}

function readTransitions(value: unknown, sceneIds: Set<string>) {
  if (!Array.isArray(value)) {
    throw new Error("presentation.transitions must be an array");
  }

  return value.map((transition, transitionIndex): DemoScriptTransition => {
    const path = `presentation.transitions[${transitionIndex}]`;
    const transitionRecord = assertRecord(transition, path);
    const fromSceneId = readNonEmptyString(
      transitionRecord,
      "fromSceneId",
      path,
    );
    const toSceneId = readNonEmptyString(transitionRecord, "toSceneId", path);
    assertKnownSceneId(sceneIds, fromSceneId, `${path}.fromSceneId`);
    assertKnownSceneId(sceneIds, toSceneId, `${path}.toSceneId`);

    return {
      durationSeconds: readPositiveNumber(
        transitionRecord,
        "durationSeconds",
        path,
      ),
      fromSceneId,
      style: readEnum(transitionRecord, "style", ["cut", "fade"], path),
      toSceneId,
    };
  });
}

function assertKnownSceneId(
  sceneIds: Set<string>,
  sceneId: string,
  path: string,
): void {
  if (!sceneIds.has(sceneId)) {
    throw new Error(`${path} must reference a declared Scene`);
  }
}

function readSupportedFormat(record: Record<string, unknown>): "16:9" {
  const format = readNonEmptyString(record, "format");
  if (format !== "16:9") {
    throw new Error("format must be 16:9");
  }
  return format;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }

  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }

  return value;
}

function readApprovedFontFamily(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  return readEnum(record, key, approvedFontFamilies, parentPath);
}

function readApprovedMusicTrackId(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  return readEnum(record, key, approvedMusicTrackIds, parentPath);
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowedValues: T,
  parentPath: string,
): T[number] {
  const path = `${parentPath}.${key}`;
  const value = record[key];

  if (
    typeof value !== "string" ||
    !allowedValues.includes(value as T[number])
  ) {
    throw new Error(`${path} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}
