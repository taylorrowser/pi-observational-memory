import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, validateSettings } from "../src/settings.js";

describe("observational-memory settings", () => {
  it("applies documented defaults and accepts bounded overrides", () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.debugLogging).toBe(false);
    expect(DEFAULT_SETTINGS.messageTokensStartObservation).toBe(80_000);
    expect(DEFAULT_SETTINGS.hardHeadroomTokens).toBe(200_000);
    expect(
      validateSettings({
        enabled: false,
        debugLogging: true,
        messageTokensTarget: 10_000,
        messageTokensStartObservation: 30_000,
        hardHeadroomTokens: 180_000,
      }),
    ).toMatchObject({
      enabled: false,
      debugLogging: true,
      messageTokensTarget: 10_000,
      messageTokensStartObservation: 30_000,
      hardHeadroomTokens: 180_000,
    });
  });

  it("rejects inverted thresholds", () => {
    expect(() =>
      validateSettings({
        messageTokensTarget: 40_000,
        messageTokensStartObservation: 20_000,
      }),
    ).toThrow("messageTokensTarget must be less than messageTokensStartObservation");
    expect(() =>
      validateSettings({
        observationTokensTarget: 40_000,
        observationTokensStartReflection: 20_000,
      }),
    ).toThrow(
      "observationTokensTarget must be less than observationTokensStartReflection",
    );
  });
});
