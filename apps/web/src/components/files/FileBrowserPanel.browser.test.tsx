import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

describe("FileBrowserPanel", () => {
  it("dragging a file row carries a composer mention and does not open the file", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
