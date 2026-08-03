import { describe, expect, it } from "vitest";

import {
  parseSubmittedRuntimeLaunchIdentity,
  submittedRuntimeIdentityMarker,
} from "./submitted-runtime-launch-identity";

describe("submitted runtime launch identity", () => {
  it("accepts a nonce-bound session leader with matching PID, PGID, and SID", () => {
    expect(
      parseSubmittedRuntimeLaunchIdentity(
        `${submittedRuntimeIdentityMarker}:token.123:4242:4242:4242:9001\n`,
        "token.123",
      ),
    ).toEqual({
      processGroupId: 4242,
      processId: 4242,
      processStartTimeTicks: 9001,
      sessionId: 4242,
    });
  });

  it("rejects forged nonces and identities that are not session leaders", () => {
    expect(
      parseSubmittedRuntimeLaunchIdentity(
        `${submittedRuntimeIdentityMarker}:forged:4242:4242:4242:9001\n`,
        "trusted",
      ),
    ).toBeUndefined();
    expect(
      parseSubmittedRuntimeLaunchIdentity(
        `${submittedRuntimeIdentityMarker}:trusted:4242:5151:4242:9001\n`,
        "trusted",
      ),
    ).toBeUndefined();
  });
});
