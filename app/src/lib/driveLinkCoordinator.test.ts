import { describe, expect, it } from "vitest";

import { isDriveAuthError } from "./driveLinkCoordinator";

describe("isDriveAuthError", () => {
  it("treats popup blocked auth failures as auth errors", () => {
    expect(
      isDriveAuthError(
        new Error("Popup blocked while requesting Google OAuth token"),
      ),
    ).toBe(true);
  });

  it("does not treat generic Drive API failures as auth errors", () => {
    expect(
      isDriveAuthError(
        new Error("Drive request failed (404 Not Found): file missing"),
      ),
    ).toBe(false);
  });
});
