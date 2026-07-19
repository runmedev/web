import { ScrollArea, Text } from '@radix-ui/themes'

import {
  formatRunmeVersionYaml,
  hasRunmeVersionInfo,
  runmeVersionInfo,
  type RunmeVersionInfo,
} from '../lib/versionInfo'

const FIELD_LABELS: Array<[keyof RunmeVersionInfo, string]> = [
  ['buildDate', 'Build Date'],
  ['webRepo', 'Web Repository'],
  ['webBranch', 'Web Branch'],
  ['webCommit', 'Web Commit'],
  ['bucket', 'Bucket'],
]

function VersionValue({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-nb-text-faint">Unavailable</span>
  }
  return <span className="break-all font-mono text-xs">{value}</span>
}

export function VersionInfoTab() {
  const hasVersionInfo = hasRunmeVersionInfo(runmeVersionInfo)

  return (
    <ScrollArea
      type="auto"
      scrollbars="vertical"
      className="flex-1 p-4"
      data-testid="version-info-scroll"
    >
      <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 text-sm">
        <div className="space-y-2">
          <Text size="5" weight="bold" as="p" className="text-nb-text">
            Version Information
          </Text>
          <Text size="2" as="p" className="text-nb-text-muted">
            These values are baked into the loaded JavaScript bundle at build
            time and mirror the deployment marker served as version.yaml.
          </Text>
        </div>

        {!hasVersionInfo ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Version metadata was not provided for this build.
          </div>
        ) : null}

        <div className="rounded-lg border border-nb-border bg-white p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            Release
          </Text>
          <dl className="mt-4 grid grid-cols-[minmax(120px,180px)_1fr] gap-x-4 gap-y-3">
            {FIELD_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-xs font-semibold uppercase tracking-wide text-nb-text-faint">
                  {label}
                </dt>
                <dd className="min-w-0 text-nb-text">
                  <VersionValue value={runmeVersionInfo[key]} />
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-lg border border-nb-border bg-nb-surface-2 p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            version.yaml
          </Text>
          <pre className="mt-3 overflow-x-auto whitespace-pre rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            {formatRunmeVersionYaml(runmeVersionInfo)}
          </pre>
        </div>
      </div>
    </ScrollArea>
  )
}

export default VersionInfoTab
