// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { Tree, type TreeApi } from "react-arborist";
import { expect, it } from "vitest";
import { workspaceRows } from "./workspaceTree";

it("expands nested and root appearances independently in Arborist", () => {
  const notebook = { uri: "file" };
  const nested = { uri: 'nested/"folder', children: [notebook] };
  const outer = { uri: "outer", children: [nested] };
  type Item = { uri: string; children?: Item[] };
  const rows = workspaceRows<Item>([outer, nested]);
  const tree = createRef<TreeApi<(typeof rows)[number]>>();
  render(<Tree ref={tree} data={rows} width={400} height={500} openByDefault={false} />);
  const api = tree.current!;
  act(() => api.open(rows[0].id));
  const [nestedRow, shortcut] = api.visibleNodes.filter(node => node.data.uri === nested.uri);
  act(() => {
    api.open(nestedRow.id);
    api.open(shortcut.id);
  });
  const ids = api.visibleNodes.map(node => node.id);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(ids.length);
  expect(api.visibleNodes.filter(node => node.data.uri === notebook.uri)).toHaveLength(2);
  act(() => api.close(shortcut.id));
  expect(api.get(nestedRow.id)?.isOpen).toBe(true);
  expect(api.visibleNodes.filter(node => node.data.uri === notebook.uri)).toHaveLength(1);
});
