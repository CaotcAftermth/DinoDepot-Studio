import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createHashRouter } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { APP_MODULES } from "./app/modules";
import { ProjectHomePage } from "./pages/ProjectHomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { ContentSourcesPage } from "./pages/ContentSourcesPage";
import { ProductionRulesPage } from "./pages/production/ProductionRulesPage";
import { SimulatorPage } from "./pages/SimulatorPage";
import { RemapsPage } from "./pages/RemapsPage";
import { PublishPage } from "./pages/PublishPage";
import { CurseForgePage } from "./pages/CurseForgePage";
import { OverviewPage } from "./pages/OverviewPage";
import "./styles.css";

// A data router (rather than <HashRouter>) so pages can block navigation —
// the Settings page uses it to catch unsaved changes.
const router = createHashRouter([
  { path: "/", element: <ProjectHomePage /> },
  {
    element: <AppShell />,
    children: [
      { path: "/overview", element: <OverviewPage /> },
      { path: "/production", element: <ProductionRulesPage /> },
      { path: "/simulator", element: <SimulatorPage /> },
      { path: "/content", element: <ContentSourcesPage /> },
      { path: "/remaps", element: <RemapsPage /> },
      { path: "/curseforge", element: <CurseForgePage /> },
      { path: "/publish", element: <PublishPage /> },
      { path: "/settings", element: <SettingsPage /> },
      // Optional modules are always routable; the sidebar decides what shows.
      ...APP_MODULES.map((m) => ({ path: m.to, element: m.element })),
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
