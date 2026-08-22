import React, { Suspense, lazy, type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createHashRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { APP_MODULES, prefetchModules } from "./app/modules";
import { ProjectHomePage } from "./pages/ProjectHomePage";
import "./styles.css";

/**
 * Sections load on demand rather than all at once.
 *
 * Bundled together they were a single 1.5 MB script, and every byte of it —
 * the whole official catalog, every editor, the publisher — had to be parsed
 * and evaluated before the window could paint anything at all. The home
 * screen is the only thing needed to show a window, so it is the only thing
 * that stays eager.
 */
const pageImports = {
  overview: () => import("./pages/OverviewPage"),
  production: () => import("./pages/production/ProductionRulesPage"),
  simulator: () => import("./pages/SimulatorPage"),
  content: () => import("./pages/ContentSourcesPage"),
  remaps: () => import("./pages/RemapsPage"),
  curseforge: () => import("./pages/CurseForgePage"),
  publish: () => import("./pages/PublishPage"),
  settings: () => import("./pages/SettingsPage"),
} as const;

function page<K extends keyof typeof pageImports>(
  key: K,
  name: string,
): React.ReactElement {
  const Loaded = lazy(async () => {
    const module = (await pageImports[key]()) as Record<string, unknown>;
    return { default: module[name] as ComponentType };
  });
  return <Loaded />;
}

/**
 * Pulls the sections in once the window is up and idle.
 *
 * Splitting alone would only move the wait from launch to the first click.
 * Fetching in the background means the chunk is almost always already there
 * by the time somebody navigates, so neither moment has to wait.
 */
function prefetchSections(): void {
  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    for (const load of Object.values(pageImports)) void load();
    prefetchModules();
  };
  const idle = (
    window as unknown as {
      requestIdleCallback?: (callback: () => void) => number;
    }
  ).requestIdleCallback;
  // Whichever comes first. Idle is the polite signal, but a browser does not
  // fire it at all while the window is hidden, and a window that starts
  // minimised would otherwise never warm anything.
  setTimeout(run, 2000);
  if (idle) idle(run);
}

// A data router (rather than <HashRouter>) so pages can block navigation —
// the Settings page uses it to catch unsaved changes.
const router = createHashRouter([
  { path: "/", element: <ProjectHomePage /> },
  {
    element: <AppShell />,
    children: [
      { path: "/overview", element: page("overview", "OverviewPage") },
      // Optional rule id, so Overview can link straight at the rule a
      // validation error belongs to. One route, not two: separate route
      // objects remount the page and lose its state.
      {
        path: "/production/:ruleId?",
        element: page("production", "ProductionRulesPage"),
      },
      { path: "/simulator", element: page("simulator", "SimulatorPage") },
      { path: "/content", element: page("content", "ContentSourcesPage") },
      { path: "/remaps", element: page("remaps", "RemapsPage") },
      { path: "/curseforge", element: page("curseforge", "CurseForgePage") },
      { path: "/publish", element: page("publish", "PublishPage") },
      // Settings is split by category; the optional slug picks which one shows,
      // so a link elsewhere in the app can point at the relevant section.
      //
      // One route rather than "/settings" plus "/settings/:tab": those are two
      // route objects, so moving between them remounts the page and silently
      // discards the unsaved draft. Changing the parameter alone does not.
      { path: "/settings/:tab?", element: page("settings", "SettingsPage") },
      // Optional modules are always routable; the sidebar decides what shows.
      ...APP_MODULES.map((m) => ({ path: m.to, element: m.element })),
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense
      fallback={
        <div className="p-8 text-sm text-ink-400">Loading this section…</div>
      }
    >
      <RouterProvider router={router} />
    </Suspense>
  </React.StrictMode>,
);

prefetchSections();
