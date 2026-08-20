import { z } from "zod";

/** Normalizes and validates a path stored inside a project or package. */
export function normalizeAssetPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0") ||
    normalized.includes(":")
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

const AssetPathSchema = z.string().refine((path) => normalizeAssetPath(path) !== null, {
  message: "Asset paths must be safe relative paths",
});

export const ProjectAssetRefSchema = z.object({
  origin: z.literal("project"),
  path: AssetPathSchema,
});

export const PackageAssetRefSchema = z.object({
  origin: z.literal("package"),
  packageId: z.string().min(1),
  version: z.string().min(1),
  path: AssetPathSchema,
});

export const OfficialAssetRefSchema = z.object({
  origin: z.literal("official"),
  packageVersion: z.string().min(1),
  path: AssetPathSchema,
});

export const RemoteAssetRefSchema = z.object({
  origin: z.literal("remote"),
  url: z.url().refine((url) => url.startsWith("https://"), {
    message: "New remote assets require HTTPS",
  }),
});

export const AssetRefSchema = z.discriminatedUnion("origin", [
  ProjectAssetRefSchema,
  PackageAssetRefSchema,
  OfficialAssetRefSchema,
  RemoteAssetRefSchema,
]);
export type AssetRef = z.infer<typeof AssetRefSchema>;

export interface LegacyAssetContext {
  origin: "project" | "package";
  packageId?: string;
  version?: string;
  /**
   * The official package version this project currently pins.
   *
   * An `official:` icon names base-game artwork without saying which release
   * it came from, deliberately: an administrator picking the stock Rex icon
   * means "the base game's Rex", and pinning the version into the stored value
   * would orphan every such assignment the next time Core Content moves.
   */
  officialVersion?: string;
}

export type ParsedAssetValue =
  | AssetRef
  | { origin: "glyph"; value: string };

/** Converts today's loose icon strings into an explicit transient origin. */
export function parseAssetValue(
  value: string | AssetRef | null | undefined,
  context: LegacyAssetContext = { origin: "project" },
): ParsedAssetValue | null {
  if (!value) return null;
  if (typeof value !== "string") {
    const parsed = AssetRefSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    // HTTP remains readable for legacy projects. Native download policy may
    // decline it, but parsing it as a URL prevents rendering the URL as text.
    return { origin: "remote", url: trimmed } as AssetRef;
  }
  if (trimmed.startsWith("official:")) {
    const path = normalizeAssetPath(trimmed.slice(9));
    if (!path) return null;
    return {
      origin: "official",
      // Empty when no official package is resolved yet; the resolver reports
      // that as a missing root rather than guessing at a version.
      packageVersion: context.officialVersion ?? "",
      path,
    };
  }
  if (trimmed.startsWith("file:")) {
    const path = normalizeAssetPath(trimmed.slice(5));
    if (!path) return null;
    if (context.origin === "package") {
      if (!context.packageId || !context.version) return null;
      return {
        origin: "package",
        packageId: context.packageId,
        version: context.version,
        path,
      };
    }
    return { origin: "project", path };
  }
  return { origin: "glyph", value };
}

/** Legacy string representation used while catalog schema 1 remains writable. */
export function legacyAssetValue(ref: AssetRef): string {
  switch (ref.origin) {
    case "remote":
      return ref.url;
    case "official":
      // Version-free on purpose — see `officialVersion` above.
      return `official:${normalizeAssetPath(ref.path) ?? ref.path}`;
    case "project":
    case "package":
      return `file:${normalizeAssetPath(ref.path) ?? ref.path}`;
  }
}
