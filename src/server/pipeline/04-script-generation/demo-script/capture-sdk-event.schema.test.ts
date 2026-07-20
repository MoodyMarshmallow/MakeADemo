import { describe, expect, it } from "vitest";
import {
  parseCaptureSdkSceneEvents,
  reduceCaptureSdkSceneEvents,
} from "./capture-sdk-event.schema";

describe("Capture SDK event schema", () => {
  it("parses Scene events and reduces a declared sequence into marker ranges", () => {
    const events = parseCaptureSdkSceneEvents(
      [
        '[makeademo:scene] {"elapsedMs":12,"event":"started","sceneId":"intro"}',
        '[makeademo:scene] {"elapsedMs":48,"event":"succeeded","sceneId":"intro"}',
      ].join("\n"),
    );

    expect(reduceCaptureSdkSceneEvents(events, ["intro"])).toEqual({
      status: "succeeded",
      ranges: new Map([["intro", { endedAtMs: 48, startedAtMs: 12 }]]),
    });
  });

  it("returns a structured failure for malformed Scene event JSON", () => {
    expect(() =>
      parseCaptureSdkSceneEvents("[makeademo:scene] not-json"),
    ).toThrow("Malformed MakeADemo scene marker");
  });
});
