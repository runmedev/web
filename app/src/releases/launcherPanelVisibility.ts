/** Version UI availability is independent of notebook storage health. An app
 * must explicitly take responsibility for controls before the launcher hides;
 * frozen apps and the standalone recovery page still need independent controls.
 */
export function hideLauncherPanel(state: {
  versionUiUsers: number
  attentionUiUsers: number
  recovery: boolean
  frozen: boolean
  transitioning: boolean
  tabUpdateAvailable: boolean
}): boolean {
  return (
    state.versionUiUsers > 0 &&
    !state.recovery &&
    !state.frozen &&
    (state.attentionUiUsers > 0 ||
      (!state.transitioning && !state.tabUpdateAvailable))
  )
}
