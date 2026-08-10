import { RemapsDraft } from "../model/remaps";
import { CatalogIndex, normalizeBpPath } from "../model/catalog";
import { ValidationIssue } from "./types";

/**
 * Semantic validation for creature type remaps. Remap files reference class
 * paths (usually with a trailing `_C`); catalog matching is `_C`-insensitive.
 */
export function validateRemaps(
  draft: RemapsDraft,
  index: CatalogIndex | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenFrom = new Map<string, string>();

  draft.entries.forEach((entry, i) => {
    if (!entry.active) return;
    const where = `Remap ${i + 1}`;

    if (!entry.fromClass.trim()) {
      issues.push(err(entry.id, where, "Source class (fromClass) is empty"));
    }
    if (!entry.toClass.trim()) {
      issues.push(err(entry.id, where, "Destination class (toClass) is empty"));
    }
    if (!entry.fromClass.trim() || !entry.toClass.trim()) return;

    checkClassPath(issues, entry.id, where, entry.fromClass, "fromClass");
    checkClassPath(issues, entry.id, where, entry.toClass, "toClass");

    if (normalizeBpPath(entry.fromClass) === normalizeBpPath(entry.toClass)) {
      issues.push(
        err(entry.id, where, "fromClass and toClass are the same creature"),
      );
    }

    const fromKey = normalizeBpPath(entry.fromClass);
    const duplicate = seenFrom.get(fromKey);
    if (duplicate) {
      issues.push(
        err(
          entry.id,
          where,
          `Duplicate source: ${duplicate} already remaps this creature`,
        ),
      );
    } else {
      seenFrom.set(fromKey, where);
    }

    if (index) {
      const dest = index.creatures.get(normalizeBpPath(entry.toClass));
      if (!dest) {
        issues.push(
          warn(
            entry.id,
            where,
            "Destination creature is not in the catalog — make sure it exists on the server",
          ),
        );
      } else if (dest.source.removed) {
        issues.push(
          err(
            entry.id,
            where,
            `Destination creature belongs to "${dest.source.name}", which is being removed — remapping into removed content defeats the purpose`,
          ),
        );
      } else if (!dest.source.enabled) {
        issues.push(
          warn(
            entry.id,
            where,
            `Destination creature belongs to "${dest.source.name}", which is disabled`,
          ),
        );
      }

      const src = index.creatures.get(normalizeBpPath(entry.fromClass));
      if (src && !src.source.removed && src.source.enabled && !entry.intentional) {
        issues.push(
          warn(
            entry.id,
            where,
            `Source creature's content ("${src.source.name}") is still enabled and not marked as being removed — if this remap is deliberate, turn on its "Intentional" toggle to dismiss this warning`,
          ),
        );
      }
    }

    // Chained remap check: destination is itself a remap source.
    const toKey = normalizeBpPath(entry.toClass);
    const chained = draft.entries.find(
      (other) =>
        other.active &&
        other.id !== entry.id &&
        normalizeBpPath(other.fromClass) === toKey,
    );
    if (chained) {
      issues.push(
        warn(
          entry.id,
          where,
          "Destination creature is itself remapped by another entry (chained remaps may not resolve)",
        ),
      );
    }
  });

  return issues;
}

function checkClassPath(
  issues: ValidationIssue[],
  entityId: string,
  where: string,
  path: string,
  field: string,
) {
  const ok = /^\/[^\s]+\/[^\s/.]+\.[^\s/.]+$/.test(path.trim());
  if (!ok) {
    issues.push(
      err(
        entityId,
        where,
        `${field} does not look like a class path (expected /…/Name.Name_C): ${path}`,
      ),
    );
  } else if (!/_C$/.test(path.trim())) {
    issues.push(
      warn(
        entityId,
        where,
        `${field} does not end in _C — remap files usually use class references (…_C)`,
      ),
    );
  }
}

function err(entityId: string, where: string, message: string): ValidationIssue {
  return { level: "error", entityId, where, message };
}

function warn(entityId: string, where: string, message: string): ValidationIssue {
  return { level: "warning", entityId, where, message };
}
