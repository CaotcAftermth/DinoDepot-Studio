import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { packageRootKey } from "./dependencyManager";
import { resolveAsset } from "./assetResolver";

/**
 * Installed package icons live under the app-data content root, and the only
 * way a renderer may read them is the asset protocol. A resolver that returns
 * a correct path the protocol then refuses is indistinguishable, on screen,
 * from having no icon at all — which is how the whole official icon set
 * silently fell back to emoji.
 */

const scope = tauriConfig.app.security.assetProtocol.scope;

/**
 * Small glob check matching the semantics Tauri's scope uses: `**` spans
 * separators, `*` does not, and `**\/` also matches zero segments — so
 * `a/**\/*.x` denies `a/leak.x` as well as `a/b/leak.x`.
 */
function matches(pattern: string, path: string): boolean {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith("**/", i)) {
      expression += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      expression += ".*";
      i += 1;
    } else if (pattern[i] === "*") {
      expression += "[^/]*";
    } else {
      expression += pattern[i].replace(/[.+?^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(path);
}

const allows = (path: string) =>
  scope.allow.some((pattern) => matches(pattern, path)) &&
  !scope.deny.some((pattern) => matches(pattern, path));

describe("asset protocol scope", () => {
  it("allows installed package icons under the app-data content root", () => {
    expect(
      allows("$APPDATA/content/official/asa/1.0.0/assets/creatures/Achatina.webp"),
    ).toBe(true);
    expect(
      allows("$APPDATA/content/modpacks/test-pack/1.0.1/assets/Icon.png"),
    ).toBe(true);
  });

  it("still allows the icon cache and project image folders", () => {
    expect(allows("$APPDATA/icon-cache/abc.png")).toBe(true);
    expect(allows("$HOME/projects/cluster/images/creatures/Rex.webp")).toBe(true);
  });

  it("keeps every existing denial, including under the new content root", () => {
    expect(allows("$APPDATA/icon-cache/leak.arkprofile")).toBe(false);
    expect(allows("$APPDATA/content/modpacks/p/1.0.0/leak.arkprofile")).toBe(false);
    expect(allows("$HOME/projects/cluster/save.arkprofile")).toBe(false);
    expect(allows("$HOME/projects/cluster/players.json")).toBe(false);
  });

  it("does not open up unrelated app-data or home paths", () => {
    expect(allows("$APPDATA/secrets.json")).toBe(false);
    expect(allows("$HOME/Documents/taxes.pdf")).toBe(false);
  });

  it("resolves a package icon to a path inside that allowed root", () => {
    const root = "$APPDATA/content/official/asa/1.0.0";
    const resolved = resolveAsset(
      {
        origin: "official",
        packageVersion: "1.0.0",
        path: "assets/creatures/Achatina.webp",
      },
      {
        officialRoot: (version) =>
          ({ [packageRootKey("official", "official-asa", "1.0.0")]: root })[
            packageRootKey("official", "official-asa", version)
          ] ?? null,
      },
    );

    expect(resolved.kind).toBe("local");
    if (resolved.kind !== "local") return;
    expect(allows(resolved.absolutePath)).toBe(true);
  });
});

describe("bundled official package", () => {
  it("ships the official package folder as a Tauri resource", () => {
    // Without this, a first launch with no network has no Core Content art at
    // all — which is the state the app was actually shipping in.
    expect(
      Object.keys(tauriConfig.bundle.resources).some((source) =>
        source.includes("Official_Icons/versions"),
      ),
    ).toBe(true);
  });
});
