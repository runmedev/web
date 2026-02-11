import Actions from "../Actions/Actions";
import AppConsole from "../AppConsole/AppConsole";
import { SidePanelContent, SidePanelToolbar } from "../SidePanel/SidePanel";
import { useSidePanel } from "../../contexts/SidePanelContext";
import { CurrentDocInitializer } from "../CurrentDocInitializer";

const SIDE_PANEL_WIDTH = 360;
const TOOLBAR_WIDTH = 48; // ~12 tailwind units (12 * 4px)

export default function MainPage() {
  const { activePanel } = useSidePanel();
  const sidePanelVisible = Boolean(activePanel);

  return (
    <div id="main-page" className="flex h-screen w-screen bg-nb-bg">
      <CurrentDocInitializer />
      <div className="flex h-full min-h-0 w-full">
        <div
          id="toolbar-column"
          className="flex h-full flex-col bg-nb-surface border-r border-nb-border"
          style={{ width: TOOLBAR_WIDTH }}
        >
          <SidePanelToolbar />
        </div>
        <div
          id="sidepanel-column"
          className={`h-full transition-[width] duration-200 ease-in-out overflow-hidden bg-nb-surface ${sidePanelVisible ? 'border-r border-nb-border' : ''}`}
          style={{
            width: sidePanelVisible ? SIDE_PANEL_WIDTH : 0,
          }}
        >
          {sidePanelVisible && (
            <SidePanelContent />
          )}
        </div>
        <div id="content-area" className="flex h-full flex-1 min-w-0 flex-col gap-2 p-2">
          <div className="flex-1 min-h-0">
            <Actions />
          </div>
          <div>
            <AppConsole />
          </div>
        </div>
      </div>
    </div>
  );
}
