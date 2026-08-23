import { useLayoutEffect, useState } from "react";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const EDGE_GAP = 6;
const TARGET_GAP = 4;

/**
 * Keeps the report's live page element visible through the modal backdrop.
 *
 * The element itself never leaves the renderer: only its safe snapshot is
 * saved with the draft. Scroll and resize listeners keep this decorative box
 * aligned with nested panes while the report is open.
 */
export function SelectedTargetSpotlight({ element }: { element: Element }) {
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    let frame = 0;

    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!element.isConnected) {
          setBox(null);
          return;
        }

        const rect = element.getBoundingClientRect();
        const left = Math.max(EDGE_GAP, rect.left - TARGET_GAP);
        const top = Math.max(EDGE_GAP, rect.top - TARGET_GAP);
        const right = Math.min(window.innerWidth - EDGE_GAP, rect.right + TARGET_GAP);
        const bottom = Math.min(window.innerHeight - EDGE_GAP, rect.bottom + TARGET_GAP);

        setBox(
          right > left && bottom > top
            ? { top, left, width: right - left, height: bottom - top }
            : null,
        );
      });
    }

    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element]);

  if (!box) return <div className="absolute inset-0 bg-black/60" />;

  return (
    <div
      className="feedback-selection-spotlight absolute rounded-md border-2 border-accent-400 bg-accent-500/10"
      style={{
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        boxShadow:
          "0 0 0 9999px rgb(0 0 0 / 0.68), 0 0 0 5px rgb(74 222 128 / 0.14)",
      }}
    />
  );
}
