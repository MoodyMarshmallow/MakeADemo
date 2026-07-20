import { describe, expect, it } from "vitest";

import { parseMakeADemoConfig } from "./makeademo-config-loader";

describe("parseMakeADemoConfig", () => {
  it("accepts a minimal MakeADemo Config", () => {
    const config = parseMakeADemoConfig(
      JSON.stringify({
        demoCommand: "npm run demo",
        url: "http://127.0.0.1:3000",
      }),
    );

    expect(config).toEqual({
      demoCommand: "npm run demo",
      url: "http://127.0.0.1:3000",
    });
  });

  it("rejects missing fields and non-local URLs", () => {
    expect(() => parseMakeADemoConfig("{}")).toThrowError(
      "demoCommand must be a non-empty string",
    );

    expect(() =>
      parseMakeADemoConfig(
        JSON.stringify({
          demoCommand: "npm run demo",
          url: "https://example.com",
        }),
      ),
    ).toThrowError("url must be a local http URL");
  });
});
