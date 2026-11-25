import { Clipboard, computed, effect, Image, safeArea, Scroll, signal, Text, View } from "nsh";
import { Button, NavPage } from "nsh/base";
import { clientLog, fetchPreviewDataUrl, openNativePreview, rpc, status } from "../conn";
import { CARD_CURVE, fmtBytes, GlassCircle, Icon, tapHaptic } from "../ui/controls";
import chevronIcon from "../../assets/chevron.svg";
import videoIcon from "../../assets/video.svg";

const MAX_INLINE_TEXT_CHARS = 24 * 1024;
const MAX_INLINE_LINES = 300;
const MAX_LINE_CHARS = 600;

export function PreviewScreen(props: { rootId: string; path: string; title: string; onBack: () => void }) {
  const data = signal<any>(null);
  const loading = signal<boolean>(true);
  const err = signal<string>("");
  const imgUrl = signal<string>("");
  const progress = signal<number>(0);
  const opening = signal<boolean>(false);
  const copied = signal<boolean>(false);
  let initialLoaded = false;

  const safeTextInfo = computed(() => {
    const d = data();
    if (!d || (d.kind !== "text" && d.kind !== "md")) return null;
    const raw = String(d.text ?? "");
    const allLines = raw.split("\n");
    const slicedChars = raw.length > MAX_INLINE_TEXT_CHARS ? raw.slice(0, MAX_INLINE_TEXT_CHARS) : raw;
    const lines = slicedChars.split("\n");
    const cappedLines = lines.slice(0, MAX_INLINE_LINES).map((ln) =>
      ln.length > MAX_LINE_CHARS ? `${ln.slice(0, MAX_LINE_CHARS)} …` : ln,
    );
    const inlineTruncated =
      Boolean(d.truncated) ||
      raw.length > MAX_INLINE_TEXT_CHARS ||
      allLines.length > MAX_INLINE_LINES ||
      lines.some((ln) => ln.length > MAX_LINE_CHARS);
    return {
      totalLines: allLines.length,
      shownLines: cappedLines.length,
      inlineTruncated,
      display: cappedLines.join("\n") || "（空文件）",
    };
  });

  async function loadFile() {
    if (status() !== "ready") return;
    loading.set(true);
    err.set("");
    imgUrl.set("");
    progress.set(0);
    clientLog("info", "preview.load.start", { rootId: props.rootId, path: props.path });
    try {
      const res = (await rpc("files.open", { rootId: props.rootId, path: props.path }, 60_000)) as any;
      data.set(res);
      clientLog("info", "preview.load.opened", {
        rootId: props.rootId,
        path: props.path,
        kind: res?.kind,
        size: res?.size,
        total: res?.total ?? res?.rawTotal ?? res?.thumbTotal,
        truncated: res?.truncated,
        hasInline: Boolean(res?.inline),
        previewId: res?.previewId ?? res?.rawPreviewId ?? res?.thumbPreviewId,
      });
      if (res.kind === "image") {
        if (res.inline) {
          imgUrl.set(res.inline);
        } else if (res.previewId) {
          const url = await fetchPreviewDataUrl(res.previewId, res.mime, res.total, (loaded, total) => {
            progress.set(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100);
          });
          imgUrl.set(url);
        }
      } else if (res.kind === "look") {
        if (res.inline) {
          imgUrl.set(res.inline);
        } else if (res.thumbPreviewId) {
          const url = await fetchPreviewDataUrl(res.thumbPreviewId, "image/jpeg", res.thumbTotal, (loaded, total) => {
            progress.set(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100);
          });
          imgUrl.set(url);
        }
      }
    } catch (e: any) {
      clientLog("error", "preview.load.err", { rootId: props.rootId, path: props.path, err: String(e?.message ?? e) });
      err.set(e.message || "打开文件失败");
    } finally {
      loading.set(false);
    }
  }

  effect(() => {
    if (status() === "ready" && !initialLoaded) {
      initialLoaded = true;
      loadFile();
    }
  });

  async function openInSystem(previewId: string, name: string, kind: string, total: number) {
    if (!previewId || opening()) return;
    tapHaptic();
    opening.set(true);
    progress.set(0);
    err.set("");
    try {
      await openNativePreview(previewId, name, kind, total, (loaded, tot) => {
        progress.set(tot > 0 ? Math.min(100, Math.round((loaded / tot) * 100)) : 100);
      });
    } catch (e: any) {
      err.set(e.message || "打开失败");
    } finally {
      opening.set(false);
    }
  }

  async function copyFullText(str: string) {
    tapHaptic();
    await Clipboard.writeText(str);
    copied.set(true);
    setTimeout(() => copied.set(false), 2000);
  }

  return (
    <NavPage title={props.title} headerVisible={false}>
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)]">
        <View class="flex-row items-center gap-3 px-3.5 py-2.5">
          <GlassCircle onPress={() => { tapHaptic(); props.onBack(); }} size={42} accessibilityLabel="返回" testID="preview-back">
            <View style={{ rotate: "180deg" }}>
              <Icon src={chevronIcon} size={20} class="tint-foreground" />
            </View>
          </GlassCircle>
          <View class="flex-1 gap-0.5">
            <Text class="text-[17px] font-semibold text-foreground" style={{ numberOfLines: 1 }}>
              {props.title}
            </Text>
            <Text class="text-[13px] text-muted-foreground" style={{ numberOfLines: 1 }}>
              {props.path}
            </Text>
          </View>
        </View>

        <Scroll class="flex-1" contentClass="gap-4 px-4 pt-3" contentStyle={{ paddingBottom: safeArea().bottom + 24 }}>
          {err() ? (
            <View class="rounded-2xl bg-bad/15 px-4 py-3">
              <Text class="text-[13.5px] text-bad">{err()}</Text>
            </View>
          ) : null}

          {loading() ? (
            <View class="items-center justify-center rounded-[22px] bg-card py-14">
              <Text class="text-[14.5px] text-muted-foreground">加载中…</Text>
            </View>
          ) : data() ? (
            <View class="gap-4">
              {data().kind === "video" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  {data().strip ? (
                    <Scroll horizontal scrollbar={false} class="overflow-hidden rounded-[14px] bg-term-bg">
                      <Image src={data().strip} style={{ width: 960, height: 150 }} />
                    </Scroll>
                  ) : null}
                  <Button
                    onPress={() => openInSystem(data().previewId, data().name, "video", data().total)}
                    disabled={opening()}
                    class="h-12 flex-row items-center justify-center gap-2 rounded-full bg-primary active:opacity-80"
                    testID="play-video"
                  >
                    <Icon src={videoIcon} size={18} class="tint-primary-foreground" />
                    <Text class="text-[15px] font-semibold text-primary-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                      {opening() ? `${progress()}%` : "播放"}
                    </Text>
                  </Button>
                </View>
              ) : null}

              {data().kind === "audio" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  <Button
                    onPress={() => openInSystem(data().previewId, data().name, "audio", data().total)}
                    disabled={opening() || !data().previewId}
                    class="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                  >
                    <Text class="text-[15px] font-semibold text-primary-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                      {opening() ? `${progress()}%` : "播放"}
                    </Text>
                  </Button>
                </View>
              ) : null}

              {data().kind === "image" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  {imgUrl() ? (
                    <View class="items-center justify-center overflow-hidden rounded-[16px] bg-secondary p-2">
                      <Image src={imgUrl()} style={{ width: 320, height: 280 }} />
                    </View>
                  ) : (
                    <View class="items-center justify-center rounded-[16px] bg-secondary py-12">
                      <Text class="font-mono text-[13px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                        {progress()}%
                      </Text>
                    </View>
                  )}
                  <Button
                    onPress={() => openInSystem(data().previewId, data().name, "image", data().total)}
                    disabled={opening()}
                    class="h-12 items-center justify-center rounded-full bg-secondary active:opacity-80"
                    testID="open-image-ql"
                  >
                    <Text class="text-[15px] font-medium text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                      {opening() ? `${progress()}%` : "打开"}
                    </Text>
                  </Button>
                </View>
              ) : null}

              {data().kind === "look" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  {imgUrl() ? (
                    <View class="items-center justify-center overflow-hidden rounded-[16px] bg-secondary p-2">
                      <Image src={imgUrl()} style={{ width: 320, height: 360 }} />
                    </View>
                  ) : null}
                  <Button
                    onPress={() =>
                      openInSystem(
                        data().rawPreviewId || data().thumbPreviewId,
                        data().name,
                        "look",
                        data().rawTotal || data().thumbTotal,
                      )
                    }
                    disabled={opening() || (!data().rawPreviewId && !data().thumbPreviewId)}
                    class="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                    testID="open-doc-ql"
                  >
                    <Text class="text-[15px] font-semibold text-primary-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                      {opening() ? `${progress()}%` : "打开"}
                    </Text>
                  </Button>
                </View>
              ) : null}

              {data().kind === "text" || data().kind === "md" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="font-mono text-[12px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                      {safeTextInfo()?.inlineTruncated
                        ? `${safeTextInfo()?.shownLines ?? 0} / ${safeTextInfo()?.totalLines ?? 0}`
                        : `${safeTextInfo()?.totalLines ?? 0} 行`}
                    </Text>
                    <View class="flex-row items-center gap-2">
                      {safeTextInfo()?.inlineTruncated && data().rawPreviewId ? (
                        <Button
                          onPress={() => openInSystem(data().rawPreviewId, data().name, "look", data().rawTotal || data().size)}
                          disabled={opening()}
                          class="rounded-full bg-secondary px-3 py-1.5 active:opacity-70"
                          testID="open-text-ql"
                        >
                          <Text class="text-[12px] font-medium text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                            {opening() ? `${progress()}%` : "完整查看"}
                          </Text>
                        </Button>
                      ) : null}
                      <Button
                        onPress={() => copyFullText(String(data().text ?? ""))}
                        class="rounded-full bg-secondary px-3 py-1.5 active:opacity-70"
                      >
                        <Text class="text-[12px] font-medium text-foreground">{copied() ? "已复制" : "复制"}</Text>
                      </Button>
                    </View>
                  </View>
                  <View class="rounded-[16px] bg-background p-3">
                    <Text class="font-mono text-[12.5px] leading-relaxed text-foreground-soft">
                      {safeTextInfo()?.display || "（空文件）"}
                    </Text>
                  </View>
                </View>
              ) : null}

              {data().kind === "binary" ? (
                <View class="gap-3 rounded-[22px] bg-card p-4">
                  <Text class="font-mono text-[13px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                    二进制文件 · {fmtBytes(data().size)}
                  </Text>
                  {data().previewId ? (
                    <Button
                      onPress={() => openInSystem(data().previewId, data().name, "binary", data().total)}
                      disabled={opening()}
                      class="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                    >
                      <Text class="text-[15px] font-semibold text-primary-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                        {opening() ? `${progress()}%` : "打开"}
                      </Text>
                    </Button>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
        </Scroll>
      </View>
    </NavPage>
  );
}
