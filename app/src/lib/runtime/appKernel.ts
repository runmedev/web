export const APPKERNEL_RUNNER_NAME = "appkernel-js";
export const APPKERNEL_RUNNER_LABEL = "AppKernel (browser JS)";
export const APPKERNEL_SANDBOX_RUNNER_NAME = "appkernel-js-sandbox";
export const APPKERNEL_SANDBOX_RUNNER_LABEL = "AppKernel (sandbox JS)";

export type AppKernelRunnerMode = "browser" | "sandbox";

export function isAppKernelRunnerName(name: string | null | undefined): boolean {
  const normalized = (name ?? "").trim();
  return (
    normalized === APPKERNEL_RUNNER_NAME ||
    normalized === APPKERNEL_SANDBOX_RUNNER_NAME
  );
}

export function isSandboxAppKernelRunnerName(
  name: string | null | undefined,
): boolean {
  return (name ?? "").trim() === APPKERNEL_SANDBOX_RUNNER_NAME;
}

export function resolveAppKernelRunnerMode(
  name: string | null | undefined,
): AppKernelRunnerMode {
  return isSandboxAppKernelRunnerName(name) ? "sandbox" : "browser";
}
