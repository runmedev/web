import { describe, expect, it } from "vitest";
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
  isAppKernelRunnerName,
  isSandboxAppKernelRunnerName,
  resolveAppKernelRunnerMode,
} from "./appKernel";

describe("appKernel runner helpers", () => {
  it("detects browser and sandbox appkernel runner names", () => {
    expect(isAppKernelRunnerName(APPKERNEL_RUNNER_NAME)).toBe(true);
    expect(isAppKernelRunnerName(APPKERNEL_SANDBOX_RUNNER_NAME)).toBe(true);
    expect(isAppKernelRunnerName("custom-runner")).toBe(false);
  });

  it("identifies sandbox runner name", () => {
    expect(isSandboxAppKernelRunnerName(APPKERNEL_SANDBOX_RUNNER_NAME)).toBe(true);
    expect(isSandboxAppKernelRunnerName(APPKERNEL_RUNNER_NAME)).toBe(false);
  });

  it("defaults to browser mode unless runner is sandbox", () => {
    expect(resolveAppKernelRunnerMode(APPKERNEL_SANDBOX_RUNNER_NAME)).toBe(
      "sandbox",
    );
    expect(resolveAppKernelRunnerMode(APPKERNEL_RUNNER_NAME)).toBe("browser");
    expect(resolveAppKernelRunnerMode("")).toBe("browser");
  });
});
