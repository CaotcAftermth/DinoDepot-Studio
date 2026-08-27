import { z } from "zod";

declare const iconKeyBrand: unique symbol;
export type IconKey = string & { readonly [iconKeyBrand]: true };

export type ParsedIconKey =
  | { namespace: "dds"; className: string; assetId: string; value: IconKey }
  | {
      namespace: "official";
      type: "creature" | "item" | "map";
      assetId: string;
      value: IconKey;
    }
  | {
      namespace: "mod";
      modId: string;
      type: "creature" | "item";
      assetId: string;
      value: IconKey;
    }
  | {
      namespace: "project";
      projectId: string;
      assetId: string;
      value: IconKey;
    };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The only parser/validator for content image identities. */
export function parseIconKey(value: unknown): ParsedIconKey | null {
  if (typeof value !== "string" || value.length > 240 || value.trim() !== value) {
    return null;
  }
  const parts = value.split(":");
  if (!parts.every((part) => SLUG.test(part))) return null;
  const branded = value as IconKey;
  if (parts[0] === "dds" && parts.length === 3) {
    return { namespace: "dds", className: parts[1], assetId: parts[2], value: branded };
  }
  if (
    parts[0] === "official" &&
    parts.length === 3 &&
    ["creature", "item", "map"].includes(parts[1])
  ) {
    return {
      namespace: "official",
      type: parts[1] as "creature" | "item" | "map",
      assetId: parts[2],
      value: branded,
    };
  }
  if (
    parts[0] === "mod" &&
    parts.length === 4 &&
    /^(?:0|[1-9][0-9]*)$/.test(parts[1]) &&
    ["creature", "item"].includes(parts[2])
  ) {
    return {
      namespace: "mod",
      modId: parts[1],
      type: parts[2] as "creature" | "item",
      assetId: parts[3],
      value: branded,
    };
  }
  if (parts[0] === "project" && parts.length === 3) {
    return { namespace: "project", projectId: parts[1], assetId: parts[2], value: branded };
  }
  return null;
}

export const IconKeySchema = z
  .string()
  .refine((value) => parseIconKey(value) !== null, "Invalid icon key")
  .transform((value) => value as IconKey);

/** Lowercase, traversal-safe identity segment. */
export function iconSlug(value: string, fallback = "asset"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || fallback;
}

/** Small stable suffix; identity aid, never a security hash. */
export function blueprintPathSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value.trim().toLowerCase())) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface AssignIconKeyEntry {
  name: string;
  bpPath: string;
  iconKey?: IconKey;
}

/**
 * Assign canonical keys while preserving any valid key already attached.
 * Only colliding slugs receive a blueprint-derived suffix.
 */
export function assignCanonicalIconKeys<T extends AssignIconKeyEntry>(
  entries: readonly T[],
  prefix: `official:${"creature" | "item" | "map"}` | `mod:${string}:${"creature" | "item"}`,
): Array<T & { iconKey: IconKey }> {
  const used = new Set(
    entries.flatMap((entry) => (entry.iconKey && parseIconKey(entry.iconKey) ? [entry.iconKey] : [])),
  );
  const baseCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.iconKey && parseIconKey(entry.iconKey)) continue;
    const base = iconSlug(entry.name || entry.bpPath.split("/").pop() || "asset");
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if (entry.iconKey && parseIconKey(entry.iconKey)) {
      return { ...entry, iconKey: entry.iconKey } as T & { iconKey: IconKey };
    }
    const base = iconSlug(entry.name || entry.bpPath.split("/").pop() || "asset");
    let assetId = (baseCounts.get(base) ?? 0) > 1
      ? `${base}-${blueprintPathSuffix(entry.bpPath)}`
      : base;
    let candidate = `${prefix}:${assetId}` as IconKey;
    if (used.has(candidate)) {
      assetId = `${base}-${blueprintPathSuffix(entry.bpPath)}`;
      candidate = `${prefix}:${assetId}` as IconKey;
    }
    used.add(candidate);
    return { ...entry, iconKey: candidate } as T & { iconKey: IconKey };
  });
}
