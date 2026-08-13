import { useEffect, useState } from "react";
import { ipc, isTauri } from "../services/ipc";
import { cacheKey, resolveIcon, type FetchResult } from "../services/iconCache";

/**
 * A remote icon, served from the local cache.
 *
 * The webview cannot load one directly: `img-src` allows no remote host and
 * `connect-src` is `'self'`. That is deliberate — a project's catalog is
 * untrusted input, and an icon URL in it must not be able to make the page
 * reach an arbitrary server. So the bytes are fetched in Rust, cached on disk,
 * and served back through the asset protocol.
 *
 * The side effect is that icons work offline, which is what an administrator
 * on a server box actually notices.
 */
export function useRemoteIcon(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url || !isTauri) {
      setSrc(null);
      return;
    }

    let cancelled = false;
    const key = cacheKey({ url });

    void resolveIcon(key, (etag) =>
      ipc<FetchResult>("icon_fetch", { url, etag }),
    )
      .then(async (icon) => {
        if (cancelled || !icon.cached) return;
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        if (!cancelled) setSrc(convertFileSrc(icon.path));
      })
      .catch(() => {
        // Offline with nothing cached. The caller falls back to its emoji,
        // which is a plainer page rather than a broken one.
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}
