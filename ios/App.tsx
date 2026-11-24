import "./src/shim";
import { computed, effect, mount, setColorScheme, signal, Storage } from "nsh";
import { createNavStack, NavStack } from "nsh/base";
import { addingMac, boot, clientLog, paired } from "./src/conn";
import { HomeShell, type AppearancePref } from "./src/screens/HomeShell";
import { PairScreen } from "./src/screens/PairScreen";
import { PreviewScreen } from "./src/screens/PreviewScreen";
import { TermScreen } from "./src/screens/TermScreen";

type Route =
  | { name: "home" }
  | { name: "term"; address: string }
  | { name: "preview"; rootId: string; path: string; title: string };

const nav = createNavStack<Route>([{ name: "home" }]);
const APPEARANCE_KEY = "herdr-appearance";
const appearance = signal<AppearancePref>("system");

function routeDesc(r: Route): string {
  if (r.name === "term") return `term:${r.address}`;
  if (r.name === "preview") return `preview:${r.path}`;
  return r.name;
}

effect(() => {
  clientLog("info", "nav.routes", { stack: nav.routes().map(routeDesc) });
});

function openTerm(address: string, reason = "tap") {
  const routes = nav.routes();
  const top = routes[routes.length - 1];
  clientLog("info", "nav.openTerm", { address, reason, stack: routes.map(routeDesc) });
  if (top?.name === "term" && top.address === address && routes.length === 2) return;
  if (routes.length === 1 && routes[0]?.name === "home") {
    nav.push({ name: "term", address });
    return;
  }
  nav.setRoutes([{ name: "home" }, { name: "term", address }]);
}

function openPreview(rootId: string, path: string, title: string) {
  const routes = nav.routes();
  const top = routes[routes.length - 1];
  if (top?.name === "preview" && top.rootId === rootId && top.path === path) return;
  clientLog("info", "nav.openPreview", { rootId, path, title });
  nav.push({ name: "preview", rootId, path, title });
}

async function initAppearance() {
  try {
    const saved = await Storage.getItem(APPEARANCE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") {
      appearance.set(saved);
      setColorScheme(saved);
    }
  } catch {}
}

function updateAppearance(next: AppearancePref) {
  appearance.set(next);
  setColorScheme(next);
  Storage.setItem(APPEARANCE_KEY, next).catch(() => {});
}

function App() {
  const showHome = computed(() => Boolean(paired()) && !addingMac());
  return (
    <If when={showHome()} else={<PairScreen />}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) =>
          route.name === "home" ? (
            <HomeShell
              appearance={appearance}
              onChangeAppearance={updateAppearance}
              onOpenTerm={openTerm}
            />
          ) : route.name === "preview" ? (
            <PreviewScreen
              rootId={route.rootId}
              path={route.path}
              title={route.title}
              onBack={() => nav.pop()}
            />
          ) : (
            <TermScreen
              address={route.address}
              onBack={() => nav.pop()}
              onOpenPreview={openPreview}
            />
          )
        }
      </NavStack>
    </If>
  );
}

initAppearance();
boot();
mount(App);
