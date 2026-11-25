import { Clipboard, computed, host, Image, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { addingMac, cancelPair, pairWith, problem, sas, status } from "../conn";
import { CARD_CURVE, GlassCapsule, Icon, STATUS_TEXT, tapHaptic } from "../ui/controls";
import arrowRightIcon from "../../assets/arrow-right.svg";
import herdrIcon from "../../assets/herdr-icon.png";
import pasteIcon from "../../assets/paste.svg";
import scanIcon from "../../assets/scan.svg";

export function PairScreen() {
  const text = signal("");
  const busy = computed(() => status() === "connecting" && !problem());

  async function go(linkStr?: string) {
    const raw = (linkStr ?? text()).trim();
    if (!raw) return;
    tapHaptic();
    problem.set("");
    try {
      await pairWith(raw, "Herdr iPhone");
    } catch (e: any) {
      console.warn(`pair failed: ${e.message}`);
      problem.set(e.message);
    }
  }

  async function scan() {
    tapHaptic();
    problem.set("");
    try {
      const scanned = await host.call<string | null>("qr.scan", null, { timeout: 0 });
      if (scanned) {
        text.set(scanned);
        await go(scanned);
      }
    } catch (e: any) {
      problem.set(e.message || "无法打开相机扫码");
    }
  }

  async function paste() {
    tapHaptic();
    const c = await Clipboard.readText();
    if (c) text.set(c);
  }

  return (
    <Scroll
      class="flex-1 bg-background"
      contentClass="grow justify-between px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <If
        when={sas()}
        else={
          <View class="flex-1 justify-between py-9">
            <View class="flex-1 items-center justify-center gap-4">
              <View class="h-[76px] w-[76px] overflow-hidden rounded-[22px] bg-white" style={CARD_CURVE}>
                <Image src={herdrIcon} style={{ width: 76, height: 76 }} />
              </View>
              <Text class="text-[28px] font-semibold text-foreground">Herdr</Text>
              <If when={problem()}>
                {(p) => (
                  <View class="mt-2 rounded-2xl bg-bad/15 px-4 py-2.5">
                    <Text class="text-center text-[13.5px] text-bad">{p()}</Text>
                  </View>
                )}
              </If>
              <If when={status() !== "idle" && !problem()}>
                <Text class="text-[13.5px] text-muted-foreground" testID="pair-status">
                  {STATUS_TEXT[status()] ?? status()}
                </Text>
              </If>
            </View>

            <View class="gap-3.5 pb-4">
              {host.available() ? (
                <Button
                  onPress={scan}
                  disabled={busy()}
                  class="h-[52px] flex-row items-center justify-center gap-2 rounded-full bg-primary transition-transform duration-150 active:scale-95"
                  testID="scan-qr"
                  accessibilityLabel="扫描二维码"
                >
                  <Icon src={scanIcon} size={19} class="tint-primary-foreground" />
                  <Text class="text-[16px] font-semibold text-primary-foreground">扫描二维码</Text>
                </Button>
              ) : null}

              <View class="flex-row items-center gap-3 px-2">
                <View class="h-px flex-1 bg-separator" />
                <Text class="text-[13px] text-idle">或</Text>
                <View class="h-px flex-1 bg-separator" />
              </View>

              <GlassCapsule class="h-[50px] gap-1.5 pr-1.5 pl-4">
                <Input
                  value={text()}
                  onChange={(e) => text.set(e.value)}
                  onSubmit={() => go()}
                  placeholder="粘贴配对链接"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  class="flex-1 text-[15.5px] text-foreground"
                  testID="pair-link"
                />
                <Button
                  onPress={paste}
                  class="h-9 w-9 items-center justify-center rounded-full active:bg-secondary"
                  accessibilityLabel="粘贴"
                >
                  <Icon src={pasteIcon} size={17} class="tint-muted-foreground" />
                </Button>
                <Button
                  onPress={() => go()}
                  disabled={busy() || !text().trim()}
                  class={`h-9 w-9 items-center justify-center rounded-full transition-transform duration-150 active:scale-95 ${
                    text().trim() ? "bg-primary" : "bg-secondary opacity-50"
                  }`}
                  testID="pair-submit"
                  accessibilityLabel="配对"
                >
                  <Icon
                    src={arrowRightIcon}
                    size={17}
                    class={text().trim() ? "tint-primary-foreground" : "tint-foreground"}
                  />
                </Button>
              </GlassCapsule>

              {addingMac() ? (
                <Button
                  onPress={() => { tapHaptic(); cancelPair(); }}
                  class="h-11 items-center justify-center rounded-full active:opacity-60"
                  testID="cancel-pair"
                >
                  <Text class="text-[15px] text-muted-foreground">取消</Text>
                </Button>
              ) : null}
            </View>
          </View>
        }
      >
        {(code) => (
          <View class="flex-1 items-center justify-center gap-5 py-8">
            <View class="h-[60px] w-[60px] overflow-hidden rounded-[18px] bg-white" style={CARD_CURVE}>
              <Image src={herdrIcon} style={{ width: 60, height: 60 }} />
            </View>
            <View class="w-full items-center justify-center rounded-[24px] bg-card px-6 py-8" style={CARD_CURVE}>
              <Text
                class="font-mono text-[42px] font-semibold tracking-[0.14em] text-foreground"
                style={{ fontVariant: ["tabular-nums"] }}
                testID="sas"
              >
                {code().length === 6 ? `${code().slice(0, 3)} ${code().slice(3)}` : code()}
              </Text>
            </View>
            <Text class="text-[15px] text-muted-foreground">在 Mac 上确认核对码</Text>
            <Button
              onPress={() => { tapHaptic(); cancelPair(); }}
              class="mt-2 h-12 w-full items-center justify-center rounded-full bg-card active:bg-secondary"
              testID="cancel-pair"
            >
              <Text class="text-[15px] font-medium text-muted-foreground">取消</Text>
            </Button>
          </View>
        )}
      </If>
    </Scroll>
  );
}
