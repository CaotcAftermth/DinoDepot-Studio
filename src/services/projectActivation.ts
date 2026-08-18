import type { CatalogFile } from "../model/catalog";
import {
  mergeDependencies,
  type PackageDependency,
} from "../model/dependency";
import { PROJECT_FILE } from "../model/project";
import { useDraftsStore } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { localPackageSourceKey } from "./dependencyManager";

export interface PackageActivation {
  /** The exact pin this project should carry once the install has landed. */
  dependency: PackageDependency;
  /** Project-owned catalog after the package's content was applied. */
  catalog: CatalogFile;
  /**
   * Manifest or compatibility JSON on this machine for a local package.
   * Recorded in local state only — never in shared project JSON.
   */
  localPackageSourcePath?: string;
}

/**
 * Commits a package install to the project as one unit.
 *
 * The pieces used to land independently: settings were saved from a React
 * closure captured before the install started, and the catalog write was only
 * *scheduled* on a debounce. An install could therefore report success with
 * its dependency recorded and its content still unwritten, or overwrite a
 * dependency another operation had added in the meantime.
 *
 * Here the catalog is written first and rolled back if the settings write
 * fails, the settings are read at commit time rather than captured, and
 * dependencies merge by identity. The caller may report success only when
 * this resolves.
 *
 * A package-library entry may survive a failure. That is intentional — it is
 * reconstructable cache, and keeping verified bytes costs nothing, while a
 * half-written project costs an administrator their afternoon.
 */
export async function commitPackageActivation(
  activation: PackageActivation,
): Promise<void> {
  const project = useProjectStore.getState();
  const drafts = useDraftsStore.getState();
  if (!project.dir || !project.settings) {
    throw new Error("No project is open");
  }

  const previousCatalogJson = project.files[PROJECT_FILE.catalog];
  const previousCatalog = drafts.catalog;
  const previousProjectCatalog = drafts.projectCatalog;

  await drafts.setCatalogDurable(activation.catalog);
  try {
    await project.updateSettings((current) => ({
      ...current,
      packageDependencies: mergeDependencies(current.packageDependencies, [
        activation.dependency,
      ]),
    }));
  } catch (error) {
    // Put the catalog back the way it was so the project stays internally
    // consistent: no content from a package this project does not require.
    try {
      if (previousCatalogJson !== undefined) {
        await project.saveFile(PROJECT_FILE.catalog, previousCatalogJson);
      }
      useDraftsStore.setState({
        catalog: previousCatalog,
        projectCatalog: previousProjectCatalog,
      });
    } catch {
      // Reported through the original failure; the rollback problem is the
      // less useful of the two messages.
    }
    throw error;
  }

  if (activation.localPackageSourcePath) {
    const local = useProjectStore.getState().local;
    if (local) {
      await useProjectStore.getState().updateLocal({
        localPackageSources: {
          ...local.localPackageSources,
          [localPackageSourceKey(
            activation.dependency.packageId,
            activation.dependency.version,
          )]: activation.localPackageSourcePath,
        },
      });
    }
  }
}
