import * as Tabs from "@radix-ui/react-tabs";

import AppConsole from "../AppConsole/AppConsole";
import LogsPane from "../Logs/LogsPane";

/**
 * BottomPane groups debugging surfaces into tabs so the App Console and the
 * new Logs panel share the same page area (similar to VS Code output panels).
 */
export default function BottomPane() {
  return (
    <div id="bottom-pane" className="overflow-hidden rounded-nb-md border border-nb-cell-border">
      <Tabs.Root id="bottom-pane-tabs" defaultValue="console" className="flex flex-col">
        <Tabs.List
          id="bottom-pane-tab-list"
          className="flex items-center gap-1 border-b border-nb-tray-border bg-[#1a1a2e] px-2 py-1"
        >
          <Tabs.Trigger
            id="bottom-pane-tab-console"
            value="console"
            className="rounded px-2 py-1 text-xs font-mono text-slate-300 data-[state=active]:bg-[#2a2f45] data-[state=active]:text-white"
          >
            App Console
          </Tabs.Trigger>
          <Tabs.Trigger
            id="bottom-pane-tab-logs"
            value="logs"
            className="rounded px-2 py-1 text-xs font-mono text-slate-300 data-[state=active]:bg-[#2a2f45] data-[state=active]:text-white"
          >
            Logs
          </Tabs.Trigger>
        </Tabs.List>

        {/*
          Keep both panes mounted so terminal/log state is preserved while
          switching tabs, similar to VS Code's bottom panel behavior.
        */}
        <Tabs.Content
          id="bottom-pane-content-console"
          value="console"
          forceMount
          className="min-h-[220px] data-[state=inactive]:hidden"
        >
          <AppConsole />
        </Tabs.Content>
        <Tabs.Content
          id="bottom-pane-content-logs"
          value="logs"
          forceMount
          className="min-h-[220px] data-[state=inactive]:hidden"
        >
          <LogsPane />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
