export const APPKERNEL_RUNNER_NAME = "appkernel-js";
export const APPKERNEL_RUNNER_LABEL = "AppKernel (browser JS)";

export function isAppKernelRunnerName(name: string | null | undefined): boolean {
  return (name ?? "").trim() === APPKERNEL_RUNNER_NAME;
}
