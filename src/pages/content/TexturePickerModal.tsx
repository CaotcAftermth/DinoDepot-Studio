import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_MATERIAL_KEYWORDS,
  listModTextures,
  loadMaterialKeywords,
  matchesKeyword,
  modTexturePng,
  rankTextures,
  saveMaterialKeywords,
  type ModTexture,
} from "../../services/modAssets";
import { Button, Input, Modal, Toggle, cx } from "../../components/ui";

/**
 * Choosing a mod's own artwork for one entry.
 *
 * The mod ships the picture; nothing in it says which entry the picture
 * belongs to. Filename matching was measured and does not work, so this shows
 * the administrator what is in there and lets them decide - the one part of
 * the problem a person is better at than the data.
 *
 * Only the selected texture is decoded. A mod's art is mostly 4096x4096
 * material maps, and decoding a few hundred of those to fill a grid would cost
 * far more than it showed.
 */
export function TexturePickerModal({
  modDir,
  modName,
  entryName,
  onPick,
  onClose,
}: {
  modDir: string;
  modName: string;
  entryName: string;
  /** Receives the chosen texture, its decoded PNG (base64), and the invert choice. */
  onPick: (
    texture: ModTexture,
    pngB64: string,
    invert: boolean,
  ) => Promise<void> | void;
  onClose: () => void;
}) {
  const [textures, setTextures] = useState<ModTexture[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ModTexture | null>(null);
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invert, setInvert] = useState(false);
  const [keywords, setKeywords] = useState<string[]>(loadMaterialKeywords);
  const [excluded, setExcluded] = useState<Set<string>>(
    () => new Set(loadMaterialKeywords()),
  );
  const [showKeywords, setShowKeywords] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    setTextures(null);
    listModTextures(modDir)
      .then((found) => {
        if (!cancelled) setTextures(found);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [modDir]);

  const excludedList = useMemo(() => [...excluded], [excluded]);
  const results = useMemo(
    () => rankTextures(textures ?? [], { query, excluded: excludedList }),
    [textures, query, excludedList],
  );
  /** How many textures each keyword is currently accounting for. */
  const keywordCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const keyword of keywords) {
      counts.set(
        keyword,
        (textures ?? []).filter((texture) =>
          matchesKeyword(texture.name, keyword),
        ).length,
      );
    }
    return counts;
  }, [keywords, textures]);
  /**
   * Counted from the keywords alone, never from the visible rows: a search
   * narrows the list too, and folding that in would make the label claim the
   * filter was hiding textures the search had merely scrolled past.
   */
  const hiddenCount = useMemo(
    () =>
      (textures ?? []).filter((texture) =>
        excludedList.some((keyword) => matchesKeyword(texture.name, keyword)),
      ).length,
    [textures, excludedList],
  );

  function toggleKeyword(keyword: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword);
      else next.add(keyword);
      saveMaterialKeywords([...next]);
      return next;
    });
  }

  function addKeyword() {
    const keyword = newKeyword.trim().toLowerCase();
    if (!keyword) return;
    setKeywords((prev) => (prev.includes(keyword) ? prev : [...prev, keyword]));
    setExcluded((prev) => {
      const next = new Set(prev).add(keyword);
      saveMaterialKeywords([...next]);
      return next;
    });
    setNewKeyword("");
  }

  async function choose(texture: ModTexture) {
    setSelected(texture);
    setPreview("");
    setPreviewing(true);
    setError("");
    try {
      setPreview(await modTexturePng(modDir, texture.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function use() {
    if (!selected || !preview) return;
    setSaving(true);
    try {
      await onPick(selected, preview, invert);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Icon for ${entryName}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-400">
          Artwork read from <span className="text-ink-200">{modName}</span> as
          installed on this machine. Whatever you pick is saved into this
          project as a 160&times;160 WebP.
        </p>

        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            textures
              ? `Search ${textures.length} textures…`
              : "Reading the mod's containers…"
          }
        />

        {textures && (
          <div className="border border-ink-700 rounded-lg">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-1.5 cursor-pointer text-xs text-ink-300"
              onClick={() => setShowKeywords((open) => !open)}
            >
              <span>
                {showKeywords ? "▾" : "▸"} Excluded material words - {" "}
                {excluded.size} of {keywords.length} on, hiding {hiddenCount}{" "}
                texture{hiddenCount === 1 ? "" : "s"}
              </span>
            </button>

            {showKeywords && (
              <div className="px-3 pb-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-32 overflow-y-auto">
                  {keywords.map((keyword) => {
                    const count = keywordCounts.get(keyword) ?? 0;
                    return (
                      <label
                        key={keyword}
                        className="flex items-center gap-1.5 cursor-pointer"
                        // A word matching nothing in this mod is noise, but
                        // still worth showing so it can be unticked for the
                        // next one.
                        title={`${count} texture${count === 1 ? "" : "s"} in this mod`}
                      >
                        <input
                          type="checkbox"
                          checked={excluded.has(keyword)}
                          onChange={() => toggleKeyword(keyword)}
                        />
                        <span
                          className={cx(
                            "text-xs",
                            count > 0 ? "text-ink-200" : "text-ink-500",
                          )}
                        >
                          {keyword}
                          {count > 0 && (
                            <span className="text-ink-500"> ({count})</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    placeholder="Add a word to exclude, e.g. cubemap"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addKeyword();
                    }}
                  />
                  <Button
                    className="shrink-0"
                    disabled={!newKeyword.trim()}
                    onClick={addKeyword}
                  >
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => {
                      setKeywords([...DEFAULT_MATERIAL_KEYWORDS]);
                      setExcluded(new Set(DEFAULT_MATERIAL_KEYWORDS));
                      saveMaterialKeywords(DEFAULT_MATERIAL_KEYWORDS);
                    }}
                  >
                    Reset
                  </Button>
                </div>
                <p className="text-xs text-ink-500">
                  Words of five letters or fewer match whole words only, so
                  “metal” does not hide “Metalwork”.
                </p>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="border border-danger/30 bg-danger/5 rounded-lg p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {!textures && !error && (
          <p className="text-sm text-ink-400 py-8 text-center">
            Reading this mod's artwork - a large mod takes a few seconds…
          </p>
        )}

        {textures && (
          <div className="flex gap-3 min-h-0">
            <div className="flex flex-col gap-0.5 max-h-80 overflow-y-auto pr-1 flex-1 min-w-0">
              {results.map((texture) => (
                <button
                  key={texture.path}
                  onClick={() => void choose(texture)}
                  className={cx(
                    "text-left px-2 py-1 rounded-md cursor-pointer min-w-0",
                    selected?.path === texture.path
                      ? "bg-accent-500/15 text-ink-100"
                      : "hover:bg-ink-800 text-ink-300",
                  )}
                >
                  <span className="text-xs block truncate">{texture.name}</span>
                  <span className="text-xs text-ink-500 block truncate">
                    {texture.width}&times;{texture.height}
                  </span>
                </button>
              ))}
              {results.length === 0 && (
                <p className="text-xs text-ink-500 py-4 text-center">
                  {textures.length === 0
                    ? "This mod ships no textures."
                    : query.trim()
                      ? `Nothing matches “${query.trim()}”.`
                      : "Everything here looks like a material map - turn the filter off to see them."}
                </p>
              )}
            </div>

            <div className="w-56 shrink-0 border border-ink-700 rounded-lg p-3 flex flex-col items-center justify-center gap-2">
              {previewing && (
                <p className="text-xs text-ink-400">Decoding…</p>
              )}
              {!previewing && preview && (
                <img
                  src={`data:image/png;base64,${preview}`}
                  alt={selected?.name ?? ""}
                  className="max-w-full max-h-40 object-contain"
                  style={{
                    // Checkerboard so a transparent icon is legible.
                    backgroundImage:
                      "repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%)",
                    backgroundSize: "16px 16px",
                    // Shows exactly what saving will write: the backend runs
                    // the same inversion on the real pixels.
                    filter: invert ? "invert(1)" : undefined,
                  }}
                />
              )}
              {!previewing && !preview && (
                <p className="text-xs text-ink-500 text-center">
                  Pick a texture to see it.
                </p>
              )}
              {selected && (
                <p className="text-xs text-ink-400 text-center break-all">
                  {selected.name}
                </p>
              )}
              <Toggle
                checked={invert}
                onChange={setInvert}
                label="Invert colours"
              />
              <p className="text-xs text-ink-500 text-center">
                Mods often ship creature icons as black silhouettes, which
                vanish against a dark panel.
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!selected || !preview || saving}
            onClick={() => void use()}
          >
            {saving ? "Saving…" : "Use this icon"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
