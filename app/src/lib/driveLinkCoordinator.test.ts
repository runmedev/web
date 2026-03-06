import { describe, expect, it } from "vitest";

import {
  isDriveAuthError,
  isDriveMissingOrAccessDeniedError,
} from "./driveLinkCoordinator";

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

  it("treats explicit authorization-required failures as auth errors", () => {
    expect(
      isDriveAuthError(
        new Error("Google Drive authorization is required."),
      ),
    ).toBe(true);
  });
});

describe("isDriveMissingOrAccessDeniedError", () => {
  it("treats 404 drive API failures as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error("Drive request failed (404 Not Found): file missing"),
      ),
    ).toBe(true);
  });

  it("treats 403 drive API failures as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error("Drive request failed (403 Forbidden): insufficientFilePermissions"),
      ),
    ).toBe(true);
  });

  it("does not treat auth redirect handoff as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error("Redirecting to Google OAuth for Drive authorization."),
      ),
    ).toBe(false);
  });
});
