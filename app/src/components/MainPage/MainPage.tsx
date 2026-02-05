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
    <div className="flex h-screen w-screen bg-gray-50">
      <CurrentDocInitializer />
      <div className="flex h-full min-h-0 w-full">
        <div
          className="flex h-full flex-col bg-white"
          style={{ width: TOOLBAR_WIDTH }}
        >
          <SidePanelToolbar />
        </div>
        <div
          id="sidepanel-column"
          className={`h-full border-r border-gray-100 bg-white transition-[width] duration-150`}
          style={{ width: sidePanelVisible ? SIDE_PANEL_WIDTH : 0 }}
        >
          {sidePanelVisible && (
            <SidePanelContent />
          )}
        </div>
        <div className="flex h-full flex-1 min-w-0 flex-col gap-4 p-4">
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
