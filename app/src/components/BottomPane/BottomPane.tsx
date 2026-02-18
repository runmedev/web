import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/20/solid";

import AppConsole from "../AppConsole/AppConsole";
import LogsPane from "../Logs/LogsPane";

const STORAGE_KEY = "runme.bottomPaneCollapsed";
const LEGACY_STORAGE_KEY = "aisre.bottomPaneCollapsed";

/**
 * BottomPane groups debugging surfaces into tabs so the App Console and the
 * new Logs panel share the same page area (similar to VS Code output panels).
 */
export default function BottomPane() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      return stored === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "true" : "false");
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Non-critical preference persistence.
    }
  }, [collapsed]);

  return (
    <div
      id="bottom-pane"
      data-collapsed={collapsed ? "true" : "false"}
      className="overflow-hidden rounded-nb-md border border-nb-cell-border"
    >
      <Tabs.Root id="bottom-pane-tabs" defaultValue="console" className="flex flex-col">
        <div
          id="bottom-pane-header"
          className="flex items-center justify-between border-b border-nb-tray-border bg-[#161927] px-2 py-1"
        >
          <Tabs.List
            id="bottom-pane-tab-list"
            className="flex items-center gap-1"
          >
            <Tabs.Trigger
              id="bottom-pane-tab-console"
              value="console"
              className="rounded px-2 py-1 text-xs font-mono text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100 data-[state=active]:bg-[#2d3550] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-2px_0_0_#60a5fa]"
            >
              App Console
            </Tabs.Trigger>
            <Tabs.Trigger
              id="bottom-pane-tab-logs"
              value="logs"
              className="rounded px-2 py-1 text-xs font-mono text-slate-300 transition-colors hover:bg-white/5 hover:text-slate-100 data-[state=active]:bg-[#2d3550] data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-2px_0_0_#60a5fa]"
            >
              Logs
            </Tabs.Trigger>
          </Tabs.List>
          <button
            id="bottom-pane-collapse-toggle"
            type="button"
            aria-label={collapsed ? "Expand bottom pane" : "Collapse bottom pane"}
            className="inline-flex h-8 w-8 items-center justify-center rounded bg-black/0 text-[12.6px] font-mono font-medium text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/80"
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
          </button>
        </div>

        <div id="bottom-pane-body" className={collapsed ? "hidden" : ""}>
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
            <AppConsole showHeader={false} />
          </Tabs.Content>
          <Tabs.Content
            id="bottom-pane-content-logs"
            value="logs"
            forceMount
            className="min-h-[220px] data-[state=inactive]:hidden"
          >
            <LogsPane />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}
