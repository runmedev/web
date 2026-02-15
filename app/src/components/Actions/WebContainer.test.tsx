// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { parser_pb } from "../../runme/client";
import WebContainer from "./WebContainer";

const updateCell = vi.fn();

vi.mock("../../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    getNotebookData: () => ({ updateCell }),
  }),
}));

vi.mock("../../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => "notebook://test",
  }),
}));

vi.mock("../../lib/useAisreClient", () => ({
  useBaseUrl: () => "http://localhost:3000",
}));

describe("WebContainer", () => {
  it("keeps the render container mounted while toggling visibility", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-wc",
      value: "await aisre.render((selection) => { selection.append('div').text('chart-ready'); });",
      metadata: {},
      outputs: [],
    });

    render(<WebContainer cell={cell} onExitCode={vi.fn()} onPid={vi.fn()} />);

    const shell = document.getElementById("webcontainer-output-shell-cell-wc");
    const before = document.getElementById("webcontainer-output-content-cell-wc");
    expect(shell).toBeTruthy();
    expect(shell?.className).toContain("hidden");
    expect(before).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("runCodeCell", { detail: { cellId: "cell-wc" } }),
      );
      await Promise.resolve();
    });

    const after = document.getElementById("webcontainer-output-content-cell-wc");
    expect(after).toBe(before);
    expect(shell?.className).not.toContain("hidden");
    expect(screen.getByText("chart-ready")).toBeTruthy();
    expect(updateCell).toHaveBeenCalledTimes(1);
  });
});
