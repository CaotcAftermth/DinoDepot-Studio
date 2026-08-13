import { NavLink, Navigate, Outlet } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import { ToastContainer } from "../components/toast";
import { ConfirmHost } from "../components/confirm";
import { SyncStatus } from "../components/SyncStatus";
import { UpdateBanner } from "../components/UpdateBanner";
import { cx } from "../components/ui";
import { isTauri } from "../services/ipc";
import { enabledModules } from "./modules";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview", icon: "◆" },
  { to: "/production", label: "Production Rules", icon: "⚙" },
  { to: "/simulator", label: "Simulator", icon: "▶" },
  { to: "/content", label: "Content Sources", icon: "▦" },
  { to: "/remaps", label: "Creature Remaps", icon: "⇄" },
  { to: "/curseforge", label: "CurseForge", icon: "☁" },
  { to: "/publish", label: "Publish", icon: "↥" },
  { to: "/settings", label: "Settings", icon: "✦" },
];

function NavItem({
  to,
  label,
  icon,
}: {
  to: string;
  label: string;
  icon: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "flex items-center gap-2.5 px-4 py-2 text-sm transition-colors",
          isActive
            ? "bg-ink-800 text-white border-r-2 border-accent-500"
            : "text-ink-300 hover:text-white hover:bg-ink-850",
        )
      }
    >
      <span className="text-xs w-4 text-center opacity-70">{icon}</span>
      {label}
    </NavLink>
  );
}

export function AppShell() {
  const { dir, settings, closeProject } = useProjectStore();
  const modules = enabledModules(settings);

  if (!dir || !settings) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 bg-ink-900 border-r border-ink-700 flex flex-col">
        <div className="px-4 py-4 border-b border-ink-700">
          <div className="text-xs font-bold tracking-widest text-accent-400 uppercase">
            Dino Depot
          </div>
          <div className="text-sm font-semibold text-white">
            Production Studio
          </div>
        </div>

        <div className="px-4 py-3 border-b border-ink-700">
          <div className="text-xs text-ink-400 uppercase tracking-wide">
            Project
          </div>
          <div className="text-sm font-medium text-ink-100 truncate" title={dir}>
            {settings.name}
          </div>
          {settings.cluster && (
            <div className="text-xs text-ink-400 truncate">{settings.cluster}</div>
          )}
        </div>

        <nav className="flex-1 py-2 overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}

          {/* Everything below is optional, and not part of the studio proper. */}
          <hr className="my-2 border-ink-700" />

          {modules.length > 0 ? (
            modules.map((item) => <NavItem key={item.to} {...item} />)
          ) : (
            <p className="mx-3 px-3 py-2 text-xs text-ink-600 leading-relaxed border border-dashed border-ink-700 rounded-md">
              Additional pages appear here — turn them on in Settings.
            </p>
          )}
        </nav>

        {/* Above Close project, because sharing your work is the thing you do
            before you walk away from it. */}
        <div className="px-4 py-3 border-t border-ink-700">
          <SyncStatus />
        </div>

        <UpdateBanner />

        <div className="px-4 py-3 border-t border-ink-700 flex items-center justify-between">
          <button
            onClick={() => void closeProject()}
            className="text-xs text-ink-400 hover:text-white cursor-pointer"
          >
            ← Close project
          </button>
          {!isTauri && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-flag/20 text-amber-400 font-semibold">
              MOCK
            </span>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="p-6 w-full">
          <Outlet />
        </div>
      </main>

      <ToastContainer />
      <ConfirmHost />
    </div>
  );
}
