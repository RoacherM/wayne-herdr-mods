import { computed, effect, List, safeArea, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { clientLog, rpc, status } from "../conn";
import { BottomSheet, GlassCapsule, Icon, tapHaptic } from "../ui/controls";
import chevronDownIcon from "../../assets/chevron-down.svg";
import chevronIcon from "../../assets/chevron.svg";
import fileDocIcon from "../../assets/file-doc.svg";
import folderOutlineIcon from "../../assets/folder-outline.svg";
import searchIcon from "../../assets/search.svg";
import xIcon from "../../assets/x.svg";

export type FileEntry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  kind: string;
};

type TreeRow = {
  item: FileEntry;
  depth: number;
  isOpen: boolean;
  isLoading: boolean;
  mark: string;
};

const MARK_COLOR: Record<string, string> = {
  M: "text-warn",
  A: "text-ok",
  D: "text-bad",
  U: "text-bad",
};

function createFilesModel(getRootId: () => string) {
  const activeRoot = signal<string>(getRootId());
  const rootName = signal<string>("");
  const dirMap = signal<Record<string, FileEntry[]>>({});
  const expanded = signal<string[]>([]);
  const loadingDirs = signal<Record<string, boolean>>({});
  const marks = signal<Record<string, string>>({});
  const loading = signal<boolean>(true);
  const err = signal<string>("");
  const query = signal<string>("");

  async function loadRoot(rId: string) {
    if (status() !== "ready") return;
    loading.set(true);
    err.set("");
    try {
      const res = (await rpc("files.list", { rootId: rId || undefined, path: "" }, 20_000)) as {
        rootId: string;
        rootName: string;
        items: FileEntry[];
        marks?: Record<string, string>;
        subfolders?: Record<string, FileEntry[]>;
      };
      activeRoot.set(res.rootId);
      rootName.set(res.rootName || "");
      dirMap.set({ "": res.items ?? [], ...(res.subfolders ?? {}) });
      marks.set(res.marks ?? {});
      expanded.set([]);
    } catch (e: any) {
      err.set(e.message || "无法读取目录");
    } finally {
      loading.set(false);
    }
  }

  async function toggleFolder(relPath: string) {
    tapHaptic();
    const cur = expanded();
    if (cur.includes(relPath)) {
      expanded.set(cur.filter((p) => p !== relPath));
      return;
    }
    expanded.set([...cur, relPath]);
    if (!dirMap()[relPath] && !loadingDirs()[relPath]) {
      loadingDirs.set({ ...loadingDirs(), [relPath]: true });
      try {
        const res = (await rpc("files.list", { rootId: activeRoot() || undefined, path: relPath }, 20_000)) as {
          items: FileEntry[];
        };
        dirMap.set({ ...dirMap(), [relPath]: res.items ?? [] });
      } catch (e: any) {
        err.set(e.message || "无法展开子目录");
      } finally {
        const next = { ...loadingDirs() };
        delete next[relPath];
        loadingDirs.set(next);
      }
    }
  }

  const rows = computed<TreeRow[]>(() => {
    const map = dirMap();
    const exp = expanded();
    const busy = loadingDirs();
    const m = marks();
    const q = query().trim().toLowerCase();
    const out: TreeRow[] = [];

    function walk(dirRel: string, depth: number) {
      const items = map[dirRel] ?? [];
      for (const item of items) {
        if (q) {
          const selfMatch = item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q);
          const childList = item.dir ? map[item.path] : null;
          const hasMatchingChild = Boolean(
            childList?.some((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)),
          );
          if (!selfMatch && !hasMatchingChild) continue;
          const isOpen = item.dir && (exp.includes(item.path) || hasMatchingChild);
          out.push({
            item,
            depth,
            isOpen,
            isLoading: Boolean(item.dir && busy[item.path]),
            mark: item.dir ? "" : (m[item.path] ?? ""),
          });
          if (isOpen && childList) walk(item.path, depth + 1);
          continue;
        }
        const isOpen = item.dir && exp.includes(item.path);
        out.push({
          item,
          depth,
          isOpen,
          isLoading: Boolean(item.dir && busy[item.path]),
          mark: item.dir ? "" : (m[item.path] ?? ""),
        });
        if (isOpen && map[item.path]) walk(item.path, depth + 1);
      }
    }

    walk("", 0);
    return out;
  });

  return { activeRoot, rootName, loading, err, query, rows, loadRoot, toggleFolder };
}

function FileTreeList(props: {
  model: ReturnType<typeof createFilesModel>;
  onOpenFile: (rootId: string, path: string, title: string) => void;
  bottomPadding?: number;
}) {
  const m = props.model;
  return (
    <View class="min-h-0 flex-1">
      <If when={Boolean(m.err())}>
        <View class="mx-5 mb-2 flex-none rounded-2xl bg-bad/15 px-4 py-3">
          <Text class="text-[13.5px] text-bad">{m.err()}</Text>
        </View>
      </If>

      <If when={m.loading()}>
        <View class="flex-1 items-center justify-center py-14">
          <Text class="text-[14.5px] text-muted-foreground">加载中…</Text>
        </View>
      </If>

      <If when={!m.loading() && m.rows().length === 0}>
        <View class="flex-1 items-center justify-center py-12">
          <Text class="text-[14.5px] text-muted-foreground">
            {m.query().trim() ? "无匹配文件" : "空目录"}
          </Text>
        </View>
      </If>

      <If when={!m.loading() && m.rows().length > 0}>
        <List
          each={m.rows()}
          keyExtractor={(r) => r.item.path}
          estimatedItemSize={44}
          class="min-h-0 flex-1"
          testID="files-list"
          contentStyle={{ paddingBottom: props.bottomPadding ?? 36 }}
        >
          {(row) => (
            <Button
              onPress={() => {
                const r = row();
                if (r.item.dir) {
                  m.toggleFolder(r.item.path);
                } else {
                  tapHaptic();
                  clientLog("info", "files.tap_file", {
                    rootId: m.activeRoot(),
                    path: r.item.path,
                    size: r.item.size,
                    kind: r.item.kind,
                  });
                  props.onOpenFile(m.activeRoot(), r.item.path, r.item.name);
                }
              }}
              style={{ paddingLeft: 20 + row().depth * 20, paddingRight: 20 }}
              class="min-h-[44px] flex-row items-center gap-2.5 py-2 active:bg-secondary/60"
              testID={`file-${row().item.path}`}
            >
              <View class="w-3.5 items-center justify-center">
                <If when={row().item.dir}>
                  <Icon
                    src={row().isOpen ? chevronDownIcon : chevronIcon}
                    size={12}
                    class="tint-idle"
                  />
                </If>
              </View>
              <Icon
                src={row().item.dir ? folderOutlineIcon : fileDocIcon}
                size={17}
                class="tint-muted-foreground"
              />
              <Text class="flex-1 text-[16px] text-foreground-soft" style={{ numberOfLines: 1 }}>
                {row().item.name}
              </Text>
              <If when={row().isLoading}>
                <Text class="text-[12px] text-muted-foreground">…</Text>
              </If>
              <If when={!row().item.dir && Boolean(row().mark)}>
                <Text class={`font-mono text-[12px] font-semibold ${MARK_COLOR[row().mark] ?? "text-warn"}`}>
                  {row().mark}
                </Text>
              </If>
            </Button>
          )}
        </List>
      </If>
    </View>
  );
}

export function FilesSheet(props: {
  open: boolean;
  rootId: string;
  subtitle: string;
  onClose: () => void;
  onOpenFile: (rootId: string, path: string, title: string) => void;
}) {
  const model = createFilesModel(() => props.rootId);
  let loadedFor = "";

  effect(() => {
    if (props.open && status() === "ready") {
      const target = props.rootId;
      if (loadedFor !== target) {
        loadedFor = target;
        model.query.set("");
        model.loadRoot(target);
      }
    }
  });

  return (
    <BottomSheet
      open={props.open}
      onClose={props.onClose}
      title="Files"
      subtitle={model.rootName() || props.subtitle}
      detents={["large"]}
      accessibilityLabel="文件"
      footer={
        <View class="px-[18px] pt-2" style={{ paddingBottom: safeArea().bottom + 12 }}>
          <GlassCapsule class="h-12 gap-2.5 px-4">
            <Icon src={searchIcon} size={18} class="tint-foreground" />
            <Input
              value={model.query()}
              onChange={(e) => model.query.set(e.value)}
              placeholder="Search files"
              autoCapitalize="none"
              autoCorrect={false}
              class="flex-1 text-[16px] text-foreground"
              testID="files-search"
            />
            {model.query() ? (
              <Button
                onPress={() => model.query.set("")}
                class="h-7 w-7 items-center justify-center rounded-full active:bg-secondary"
                accessibilityLabel="清空"
              >
                <Icon src={xIcon} size={14} class="tint-muted-foreground" />
              </Button>
            ) : null}
          </GlassCapsule>
        </View>
      }
    >
      <FileTreeList
        model={model}
        onOpenFile={(rootId, path, title) => {
          props.onClose();
          props.onOpenFile(rootId, path, title);
        }}
        bottomPadding={36}
      />
    </BottomSheet>
  );
}
