import { ScrollArea, Text } from '@radix-ui/themes'

import { useRunners } from '../contexts/RunnersContext'

function formatReconnect(reconnect: boolean): string {
  return reconnect ? 'Enabled' : 'Disabled'
}

export function RunnerStatusTab() {
  const { defaultRunnerName, listRunners } = useRunners()
  const runners = listRunners()
  const availableRunners = runners.filter((runner) => runner.endpoint.trim())
  const availableCount = availableRunners.length

  return (
    <ScrollArea
      type="auto"
      scrollbars="vertical"
      className="flex-1 p-4"
      data-testid="runner-status-scroll"
    >
      <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 text-sm">
        <div className="space-y-2">
          <Text size="5" weight="bold" as="p" className="text-nb-text">
            Notebook Runner Status
          </Text>
          <Text size="2" as="p" className="text-nb-text-muted">
            {availableCount > 0
              ? `${availableCount} ${availableCount === 1 ? 'runner is' : 'runners are'} available for notebook execution.`
              : 'No backend runners are available for notebook execution.'}
          </Text>
        </div>

        <div className="rounded-lg border border-nb-border bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text size="3" weight="bold" as="p" className="text-nb-text">
              Configured Runners
            </Text>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                availableCount > 0
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              {availableCount > 0 ? 'Available' : 'Unavailable'}
            </span>
          </div>

          {runners.length === 0 ? (
            <Text size="2" as="p" className="mt-4 text-nb-text-muted">
              No runners have been configured.
            </Text>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-nb-border bg-nb-surface-2 text-xs font-semibold uppercase tracking-wide text-nb-text-muted">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Endpoint</th>
                    <th className="px-3 py-2">Default</th>
                    <th className="px-3 py-2">Reconnect</th>
                  </tr>
                </thead>
                <tbody>
                  {runners.map((runner) => {
                    const hasEndpoint = Boolean(runner.endpoint.trim())
                    return (
                      <tr
                        key={runner.name}
                        className="border-b border-nb-border last:border-0"
                      >
                        <td className="px-3 py-3 font-medium text-nb-text">
                          {runner.name}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-semibold ${
                              hasEndpoint
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {hasEndpoint ? 'Available' : 'Unavailable'}
                          </span>
                        </td>
                        <td className="max-w-[320px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                          {hasEndpoint
                            ? runner.endpoint
                            : 'No endpoint configured'}
                        </td>
                        <td className="px-3 py-3 text-nb-text-muted">
                          {runner.name === defaultRunnerName ? 'Yes' : 'No'}
                        </td>
                        <td className="px-3 py-3 text-nb-text-muted">
                          {formatReconnect(runner.reconnect)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <Text size="1" as="p" className="text-nb-text-faint">
          Availability is based on configured runner endpoints. This view does
          not perform a live network health check.
        </Text>
      </div>
    </ScrollArea>
  )
}

export default RunnerStatusTab
