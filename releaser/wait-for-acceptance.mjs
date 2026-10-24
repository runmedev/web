// Gate publication on tests of this exact source commit. Newer commits are handled
// by later reconciliations; the Go publisher separately rechecks the branch head.
const required = new Set(['test (ubuntu-latest)', 'controlled-releases'])
const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/commits/${process.env.GITHUB_SHA}/check-runs?per_page=100`
for (let attempt = 0; attempt < 150; attempt++) {
  const runs = []
  // Hourly reconciliations add checks to the same commit. Older acceptance
  // results can fall off the first page even when the source is unchanged.
  for (let page = 1; ; page++) {
    const response = await fetch(`${url}&page=${page}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`Cannot read acceptance checks: ${response.status}`)
    const { check_runs: batch } = await response.json()
    runs.push(...batch)
    if (batch.length < 100 || [...required].every(name => runs.some(run => run.name === name && run.app?.slug === 'github-actions'))) break
  }
  const checks = [...required].map(name => runs.find(run => run.name === name && run.app?.slug === 'github-actions'))
  for (const check of checks) if (check?.status === 'completed' && check.conclusion !== 'success') throw new Error(`Release acceptance failed: ${check.name}: ${check.conclusion}`)
  if (checks.every(check => check?.conclusion === 'success')) { console.log('Exact source commit passed release acceptance'); process.exit(0) }
  await new Promise(resolve => setTimeout(resolve, 10000))
}
throw new Error('Release acceptance checks did not complete; no publication performed')
