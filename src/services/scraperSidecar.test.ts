import { describe, expect, it } from "vitest";
// The sidecar runs as its own Node process; these are its pure decision
// helpers, imported directly so the incremental-collection rules can be tested
// without launching Chrome.
// @ts-expect-error — plain .mjs sidecar, no type declarations
import { canonicalUrl, canReuseKnown, cleanModName, mapLimit, PagePool } from "../../sidecar/scraper.mjs";
import { canonicalCurseforgeUrl } from "../model/catalogDuplicates";

const BASE = "https://www.curseforge.com/ark-survival-ascended/mods/cool-hats";

describe("canonicalUrl", () => {
  it("collapses the ways one mod URL gets written", () => {
    const forms = [
      BASE,
      `${BASE}/`,
      `${BASE}?utm_source=discord`,
      `${BASE}#files`,
      "http://curseforge.com/ark-survival-ascended/mods/COOL-HATS",
      `  ${BASE}  `,
    ];
    expect(new Set(forms.map(canonicalUrl)).size).toBe(1);
  });

  it("keeps different mods apart", () => {
    expect(canonicalUrl(BASE)).not.toBe(canonicalUrl(`${BASE}-2`));
  });

  it("handles missing values", () => {
    expect(canonicalUrl("")).toBe("");
    expect(canonicalUrl(null)).toBe("");
    expect(canonicalUrl(undefined)).toBe("");
  });

  it("agrees with the app-side canonicalizer it mirrors", () => {
    // Two processes, two copies — they must not drift, or incremental
    // matching silently stops matching anything.
    for (const url of [
      BASE,
      `${BASE}/`,
      `${BASE}?x=1`,
      "HTTP://WWW.CurseForge.com/ark-survival-ascended/mods/Cool-Hats/",
      "",
    ]) {
      expect(canonicalUrl(url)).toBe(canonicalCurseforgeUrl(url));
    }
  });
});

describe("canReuseKnown", () => {
  const known = {
    modId: "972253",
    name: "Cool Hats",
    url: BASE,
    updated: "Mar 4, 2026",
  };

  it("reuses a known mod whose listing date is unchanged", () => {
    expect(canReuseKnown({ updatedFromList: "Mar 4, 2026" }, known)).toBe(true);
  });

  it("opens the detail page when the listing shows a newer date", () => {
    expect(canReuseKnown({ updatedFromList: "Apr 1, 2026" }, known)).toBe(false);
  });

  it("opens the detail page for a mod we have never seen", () => {
    expect(canReuseKnown({ updatedFromList: "Mar 4, 2026" }, undefined)).toBe(false);
  });

  it("does not trust a listing with no date", () => {
    expect(canReuseKnown({ updatedFromList: "" }, known)).toBe(false);
  });

  it("does not trust a relative date — it cannot be compared", () => {
    expect(canReuseKnown({ updatedFromList: "3 days ago" }, known)).toBe(false);
  });

  it("does not reuse a stored entry whose project ID is not a number", () => {
    // Watchlist entries fall back to the source's internal id when no
    // CurseForge ID was recorded; that is not a project ID.
    expect(
      canReuseKnown({ updatedFromList: "Mar 4, 2026" }, { ...known, modId: "src-abc" }),
    ).toBe(false);
    expect(
      canReuseKnown({ updatedFromList: "Mar 4, 2026" }, { ...known, modId: "" }),
    ).toBe(false);
  });
});

describe("mapLimit", () => {
  it("keeps results in input order", async () => {
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n: number) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("PagePool", () => {
  /** Stands in for a Puppeteer browser — the pool only ever asks for tabs. */
  function fakeBrowser() {
    let made = 0;
    return {
      made: () => made,
      newPage: async () => {
        made++;
        return {
          id: made,
          setUserAgent: async () => {},
          setDefaultNavigationTimeout: () => {},
          setRequestInterception: async () => {},
          on: () => {},
          close: async () => {},
        };
      },
    };
  }

  it("creates at most `size` tabs however many callers there are", async () => {
    const browser = fakeBrowser();
    const pool = new PagePool(browser, 3);
    const pages = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    expect(browser.made()).toBe(3);
    for (const page of pages) pool.release(page);
    // Releasing makes them reusable rather than creating more.
    await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(browser.made()).toBe(3);
  });

  it("hands a released tab to whoever is waiting", async () => {
    const browser = fakeBrowser();
    const pool = new PagePool(browser, 1);
    const first = await pool.acquire();
    let handed: unknown = null;
    const waiting = pool.acquire().then((p: unknown) => (handed = p));
    expect(handed).toBeNull();
    pool.release(first);
    await waiting;
    expect(handed).toBe(first);
    expect(browser.made()).toBe(1);
  });

  it("closes the tabs it still holds", async () => {
    const browser = fakeBrowser();
    const pool = new PagePool(browser, 2);
    const page = await pool.acquire();
    pool.release(page);
    await pool.closeAll();
    expect(pool.idle).toEqual([]);
  });
});

describe("cleanModName", () => {
  it("strips the site furniture off a tab title", () => {
    expect(
      cleanModName(
        "Additions Ascended: Anomalocaris - Ark Survival Ascended Mods - CurseForge",
      ),
    ).toBe("Additions Ascended: Anomalocaris");
    expect(cleanModName("  Ports of Atlas  -  CurseForge ")).toBe(
      "Ports of Atlas",
    );
  });

  it("keeps separators that belong to the mod's own name", () => {
    // Real title for project 970540. Splitting at the first separator and
    // keeping the head returned "Paleo ARK" and threw the rest away.
    expect(
      cleanModName(
        "Paleo ARK - Evolution | Apex Predators (Crossplay) - Ark Survival Ascended Mods - CurseForge",
      ),
    ).toBe("Paleo ARK - Evolution | Apex Predators (Crossplay)");
  });

  it("handles the separators CurseForge actually uses", () => {
    expect(cleanModName("Foo – CurseForge")).toBe("Foo");
    expect(cleanModName("Foo — CurseForge")).toBe("Foo");
    expect(cleanModName("Foo | CurseForge")).toBe("Foo");
  });

  it("only strips a trailing segment, never an interior one", () => {
    expect(cleanModName("Prime-Time")).toBe("Prime-Time");
    expect(cleanModName("Mods of Doom - Apex Edition")).toBe(
      "Mods of Doom - Apex Edition",
    );
    expect(cleanModName("")).toBe("");
  });

  it("never returns nothing for a name that is all furniture", () => {
    expect(cleanModName("CurseForge")).toBe("CurseForge");
  });
});
