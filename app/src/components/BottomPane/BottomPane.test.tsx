// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../AppConsole/AppConsole", () => ({
  default: ({ showHeader }: { showHeader?: boolean }) => (
    <div data-show-header={showHeader ? "true" : "false"} data-testid="app-console-mock">
      App console mock
    </div>
  ),
}));

vi.mock("../Logs/LogsPane", () => ({
  default: () => <div data-testid="logs-pane-mock">Logs pane mock</div>,
}));

import BottomPane from "./BottomPane";
import { BottomPaneProvider } from "../../contexts/BottomPaneContext";

function renderBottomPane() {
  return render(
    <BottomPaneProvider>
      <BottomPane />
    </BottomPaneProvider>
  );
}

describe("BottomPane", () => {
  it("uses a single tab bar and highlights the selected tab", () => {
    renderBottomPane();

    const consoleTab = screen.getByRole("tab", { name: "App Console" });
    const logsTab = screen.getByRole("tab", { name: "Logs" });
    const appConsole = screen.getByTestId("app-console-mock");

    expect(appConsole.getAttribute("data-show-header")).toBe("false");
    expect(consoleTab.getAttribute("data-state")).toBe("active");
    expect(logsTab.getAttribute("data-state")).toBe("inactive");
    expect(consoleTab.className).toContain("data-[state=active]:shadow");
    expect(logsTab.className).toContain("data-[state=active]:shadow");

    const toggle = screen.getByRole("button", { name: "Collapse bottom pane" });
    const pane = screen.getByRole("tablist").closest("#bottom-pane");

    expect(pane?.className).toContain("h-[30vh]");
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Expand bottom pane" })).toBeTruthy();
    expect(pane?.getAttribute("data-collapsed")).toBe("true");
    expect(pane?.className).not.toContain("h-[30vh]");
  });
});
