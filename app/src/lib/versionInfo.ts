export interface RunmeVersionInfo {
  buildDate: string | null
  webRepo: string | null
  webBranch: string | null
  webCommit: string | null
  codexRepo: string | null
  codexBranch: string | null
  codexCommit: string | null
  bucket: string | null
}

const VERSION_YAML_KEYS: Array<keyof RunmeVersionInfo> = [
  'buildDate',
  'webRepo',
  'webBranch',
  'webCommit',
  'codexRepo',
  'codexBranch',
  'codexCommit',
  'bucket',
]

function normalizeVersionValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function normalizeRunmeVersionInfo(
  env: Record<string, unknown>
): RunmeVersionInfo {
  return {
    buildDate: normalizeVersionValue(env.VITE_RUNME_VERSION_BUILD_DATE),
    webRepo: normalizeVersionValue(env.VITE_RUNME_VERSION_WEB_REPO),
    webBranch: normalizeVersionValue(env.VITE_RUNME_VERSION_WEB_BRANCH),
    webCommit: normalizeVersionValue(env.VITE_RUNME_VERSION_WEB_COMMIT),
    codexRepo: normalizeVersionValue(env.VITE_RUNME_VERSION_CODEX_REPO),
    codexBranch: normalizeVersionValue(env.VITE_RUNME_VERSION_CODEX_BRANCH),
    codexCommit: normalizeVersionValue(env.VITE_RUNME_VERSION_CODEX_COMMIT),
    bucket: normalizeVersionValue(env.VITE_RUNME_VERSION_BUCKET),
  }
}

export const runmeVersionInfo = normalizeRunmeVersionInfo(import.meta.env)

export function hasRunmeVersionInfo(info: RunmeVersionInfo): boolean {
  return VERSION_YAML_KEYS.some((key) => Boolean(info[key]))
}

export function formatRunmeVersionYaml(info: RunmeVersionInfo): string {
  return VERSION_YAML_KEYS.map((key) => `${key}: ${info[key] ?? ''}`).join('\n')
}
