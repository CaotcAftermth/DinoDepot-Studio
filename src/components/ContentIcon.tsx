import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import missingCreatureIcon from "../assets/icons/Missing_Creature_Icon.webp";
import missingItemIcon from "../assets/icons/Missing_Item_Icon.webp";
import { catalogProjectAssets } from "../model/catalog";
import type { IconKey } from "../model/iconKey";
import { resolveImagesDir, useDraftsStore } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { isTauri } from "../services/ipc";
import { resolveIcon, type ContentIconType } from "../services/rightsAwareAssetResolver";
import { cx } from "./ui";

export function ContentIcon({
  iconKey,
  type,
  alt,
  size = 18,
  className,
}: {
  iconKey?: IconKey | string | null;
  type: ContentIconType;
  alt: string;
  size?: number;
  className?: string;
}) {
  const project = useProjectStore((state) => state.settings);
  const projectDir = useProjectStore((state) => state.dir);
  const imagesDir = useProjectStore((state) => state.local?.imagesDir);
  const projectAssets = useDraftsStore((state) => catalogProjectAssets(state.catalog));
  const placeholder = type === "creature" ? missingCreatureIcon : missingItemIcon;
  const [src, setSrc] = useState(placeholder);

  useEffect(() => {
    let cancelled = false;
    void resolveIcon({
      iconKey,
      expectedType: type,
      projectId: project?.projectId,
      projectRoot: projectDir ? resolveImagesDir(projectDir, imagesDir) : undefined,
      projectAssets,
    }).then((value) => {
      if (cancelled) return;
      if (value.localPath && value.source === "project" && isTauri) {
        setSrc(convertFileSrc(value.localPath));
      } else {
        setSrc(value.url || placeholder);
      }
    }).catch(() => !cancelled && setSrc(placeholder));
    return () => { cancelled = true; };
  }, [iconKey, type, project?.projectId, projectDir, imagesDir, projectAssets, placeholder]);

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={cx("inline-block rounded-sm object-contain shrink-0", className)}
      style={{ width: size, height: size }}
      onError={(event) => {
        if (!event.currentTarget.src.endsWith(placeholder)) event.currentTarget.src = placeholder;
      }}
    />
  );
}
