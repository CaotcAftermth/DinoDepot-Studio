import {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  Ref,
  SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useToggled, useUiPrefsStore } from "../stores/uiPrefsStore";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-600 hover:bg-accent-500 text-white border border-accent-500/40",
  secondary:
    "bg-ink-800 hover:bg-ink-700 text-ink-100 border border-ink-600",
  danger:
    "bg-danger/15 hover:bg-danger/25 text-red-300 border border-danger/40",
  ghost: "bg-transparent hover:bg-ink-800 text-ink-300 border border-transparent",
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cx(
        "px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        buttonStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

/**
 * The default `w-full`, unless the caller sized the control themselves.
 *
 * Tailwind resolves conflicting utilities by CSS source order, not by the
 * order they appear in the class attribute — so a base `w-full` silently beat
 * every caller's `w-20`/`w-44`, and sized fields rendered full width. Dropping
 * the default is the only way for the caller's width to take effect.
 *
 * `min-w-`/`max-w-` deliberately do not count: they constrain a width rather
 * than setting one, and are routinely paired with `w-full`.
 */
function defaultWidth(className?: string): string {
  return /(?:^|\s)(?:w-|flex-1\b|flex-auto\b|basis-)/.test(className ?? "")
    ? ""
    : "w-full";
}

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  /** React 19 takes `ref` as a plain prop; forwarded so callers can focus a field. */
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      className={cx(
        "bg-ink-900 border border-ink-600 rounded-md px-2.5 py-1.5 text-sm text-ink-100",
        "focus:outline-none focus:border-accent-500/60 placeholder:text-ink-400",
        // A text input's intrinsic min-width is ~20 characters, which stops it
        // shrinking inside a flex row and pushes the row past its container.
        "min-w-0",
        defaultWidth(className),
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "bg-ink-900 border border-ink-600 rounded-md px-2 py-1.5 text-sm text-ink-100",
        "focus:outline-none focus:border-accent-500/60 min-w-0",
        defaultWidth(className),
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  className,
  interactiveLabel,
}: {
  /** Usually a string; a node when the label itself is interactive. */
  label: ReactNode;
  hint?: string;
  children: ReactNode;
  className?: string;
  /**
   * Set when the label contains its own control.
   *
   * A `<label>` forwards a click from anywhere inside it to the first control
   * it contains — so a button in the label fires when the admin clicks the
   * hint text or the padding beside the input. Rendering a plain `<div>` keeps
   * the label's own hit area to the label itself.
   */
  interactiveLabel?: boolean;
}) {
  const Tag = interactiveLabel ? "div" : "label";
  return (
    <Tag className={cx("block", className)}>
      <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-ink-400 mt-1">{hint}</span>}
    </Tag>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "bg-ink-900 border border-ink-700 rounded-lg overflow-hidden",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-700 bg-ink-850">
          <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A `Card` whose body folds away behind its header.
 *
 * The body is hidden with CSS rather than unmounted: a collapsed section is a
 * presentation choice, and unmounting would throw away everything the children
 * hold locally — which item rows are open, a half-typed blueprint path, the
 * scroll position of a long list. `display: none` also keeps the content out
 * of the modal focus trap, which filters on `offsetParent`.
 */
export function CollapsibleCard({
  title,
  /** Extra header content shown only while collapsed, e.g. a summary line. */
  collapsedSummary,
  actions,
  children,
  className,
  defaultOpen = true,
  prefKey,
}: {
  title?: ReactNode;
  collapsedSummary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /**
   * Stable id (`rule:<ruleId>`, `cycle:<cycleId>`…) under which the fold state
   * is remembered across navigation and restarts. Must not be a list index —
   * the point is that a card keeps its state when its neighbours change.
   * Omit for a card whose state should not outlive the mount.
   */
  prefKey?: string;
}) {
  // Stored as "differs from the default", so a card the admin has never
  // touched always follows whatever its section chose.
  const flipped = useToggled(prefKey);
  const setToggled = useUiPrefsStore((s) => s.setToggled);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = prefKey ? (flipped ? !defaultOpen : defaultOpen) : localOpen;
  const setOpen = (next: boolean) => {
    if (prefKey) setToggled(prefKey, next !== defaultOpen);
    else setLocalOpen(next);
  };
  const bodyId = useId();

  return (
    <section
      className={cx(
        "bg-ink-900 border border-ink-700 rounded-lg overflow-hidden",
        className,
      )}
    >
      <header
        className={cx(
          "flex items-center justify-between gap-2 px-4 py-2.5 bg-ink-850",
          open && "border-b border-ink-700",
        )}
      >
        {/* The whole title area is the toggle; actions sit outside it so a
            Delete button is never one stray click away from a collapse. */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
        >
          <span
            className={cx(
              "text-xs text-ink-400 transition-transform shrink-0",
              open && "rotate-90",
            )}
            aria-hidden
          >
            ▸
          </span>
          <h3 className="text-sm font-semibold text-ink-100 min-w-0">
            {title}
          </h3>
          {!open && collapsedSummary}
        </button>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </header>
      <div id={bodyId} className={cx("p-4", !open && "hidden")}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Open/close plumbing for a panel that hangs off a trigger and is portalled to
 * `<body>` — dropdown menus, the spawn-argument editors.
 *
 * The portal is the reason this is shared: the panel is *not* inside the
 * anchor's DOM subtree, so an outside-click check that only looks at the
 * anchor treats every press inside the panel as outside, closing it before the
 * click lands. Both refs have to be consulted.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Opening one popover closes any other. They are portalled siblings with no
  // relationship to each other, so without this two adjacent triggers stack
  // their panels over one another and the one underneath is unreachable.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    openPopoverClosers.add(close);
    for (const other of openPopoverClosers) if (other !== close) other();
    return () => {
      openPopoverClosers.delete(close);
    };
  }, [open]);

  useEscapeLayer(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function toggle() {
    setRect(anchor.current?.getBoundingClientRect() ?? null);
    setOpen((o) => !o);
  }

  return { open, setOpen, toggle, rect, anchor, panel };
}

/** The portalled panel half of {@link usePopover}. */
export function PopoverPanel({
  rect,
  panelRef,
  children,
  className,
  align = "left",
  width,
  role,
}: {
  rect: DOMRect | null;
  panelRef: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
  className?: string;
  /** Which edge of the panel lines up with the trigger. */
  align?: "left" | "right";
  width?: number;
  role?: string;
}) {
  if (!rect) return null;
  // Kept inside the viewport on both axes: these open low in a tall modal, and
  // a panel that runs off the bottom of the window cannot be scrolled to.
  const maxHeight = Math.max(180, window.innerHeight - rect.bottom - 16);
  const style: React.CSSProperties = {
    top: Math.min(rect.bottom + 4, window.innerHeight - 8),
    maxHeight,
    width,
  };
  if (align === "right") {
    style.right = Math.max(window.innerWidth - rect.right, 8);
  } else {
    style.left = Math.min(
      Math.max(rect.left, 8),
      Math.max(8, window.innerWidth - (width ?? 320) - 8),
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      style={style}
      className={cx(
        "fixed z-50 bg-ink-900 border border-ink-600 rounded-lg shadow-2xl flex flex-col overflow-hidden",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  hint?: string;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * A button that opens a small action menu, portalled so it escapes the row's
 * `overflow-hidden` ancestors. Used where a row has more actions than it has
 * room for permanent buttons.
 */
export function MenuButton({
  label,
  items,
  title,
  variant = "ghost",
}: {
  label: string;
  items: MenuItem[];
  title?: string;
  variant?: ButtonVariant;
}) {
  const { open, setOpen, toggle, rect, anchor, panel } = usePopover();

  return (
    <div ref={anchor} className="relative">
      <Button
        variant={variant}
        title={title}
        onClick={toggle}
        className={cx(open && "text-accent-400")}
      >
        {label} ▾
      </Button>
      {open && (
        <PopoverPanel
          rect={rect}
          panelRef={panel}
          role="menu"
          // Right-aligned: these hang off row actions that already sit against
          // the right edge.
          align="right"
          className="min-w-52 max-w-72 py-1"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                "w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-ink-800",
                item.danger
                  ? "text-red-300 hover:text-red-200"
                  : "text-ink-200 hover:text-white",
              )}
            >
              {item.label}
              {item.hint && (
                <span className="block text-xs text-ink-500">{item.hint}</span>
              )}
            </button>
          ))}
        </PopoverPanel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type BadgeTone = "ok" | "warn" | "error" | "neutral" | "info";

const badgeTones: Record<BadgeTone, string> = {
  ok: "bg-accent-500/15 text-accent-400 border-accent-500/30",
  warn: "bg-amber-flag/15 text-amber-400 border-amber-flag/30",
  error: "bg-danger/15 text-red-400 border-danger/30",
  neutral: "bg-ink-700/40 text-ink-300 border-ink-600",
  info: "bg-sky-500/15 text-sky-400 border-sky-500/30",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border",
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  /** Hover explanation, for switches whose meaning isn't obvious from the label. */
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 cursor-pointer"
    >
      <span
        className={cx(
          "w-9 h-5 rounded-full transition-colors relative shrink-0",
          checked ? "bg-accent-600" : "bg-ink-600",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
            checked ? "left-4.5" : "left-0.5",
          )}
        />
      </span>
      {label && (
        <span className="text-sm text-ink-200 whitespace-nowrap">{label}</span>
      )}
    </button>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-6">
      <p className="text-ink-300 font-medium mb-1">{title}</p>
      {children && <div className="text-ink-400 text-sm">{children}</div>}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open modals, outermost first. Modals nest — a blueprint picker opens over
 * the creature details modal — and only the top one may answer Escape or trap
 * focus, or dismissing the picker would tear down its parent too.
 */
const modalStack: string[] = [];

/**
 * Transient popups (portalled dropdowns, autocomplete menus) that own Escape
 * while they are open. Counted rather than ordered because two document-level
 * key listeners fire in registration order, which says nothing about which one
 * is visually on top.
 */
let openPopups = 0;

/**
 * Close callbacks for every popover currently open. Module scope because
 * popovers are independent components with no common ancestor to coordinate
 * through — and there should only ever be one entry in here.
 */
const openPopoverClosers = new Set<() => void>();

/** Claims Escape for a popup while `active`, so it dismisses that and not the modal behind it. */
export function useEscapeLayer(active: boolean) {
  useEffect(() => {
    if (!active) return;
    openPopups += 1;
    return () => {
      openPopups -= 1;
    };
  }, [active]);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  xl,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Actions pinned to the bottom of the panel. Method editing makes this
   * modal very tall, and Save should not require scrolling to reach.
   */
  footer?: ReactNode;
  wide?: boolean;
  /** Extra-wide, for side-by-side layouts like the INI composer. */
  xl?: boolean;
}) {
  // Only dismiss when the press *starts* on the backdrop — otherwise
  // selecting text inside and releasing outside would close the modal.
  const pressedBackdrop = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // `onClose` is usually an inline arrow, so read it through a ref rather than
  // re-running the key handler effect (and the stack bookkeeping) every render.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const id = titleId;
    modalStack.push(id);
    const restoreTo = document.activeElement as HTMLElement | null;

    // Focus the first control *in the body*, not the header's close button —
    // landing on Close means a picker's search box never gets the caret and
    // the admin has to click before typing. An explicit autofocus wins.
    const target =
      body.current?.querySelector<HTMLElement>("[autofocus]") ??
      body.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel.current;
    target?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (modalStack[modalStack.length - 1] !== id) return;
      if (e.key === "Escape") {
        // A dropdown open over this modal dismisses itself first.
        if (openPopups > 0) return;
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        // A control scrolled out of an overflow container is still reachable;
        // one inside a `display:none` branch is not.
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge || !panel.current.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const at = modalStack.indexOf(id);
      if (at !== -1) modalStack.splice(at, 1);
      restoreTo?.focus?.();
    };
  }, [titleId]);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-8"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "bg-ink-900 border border-ink-600 rounded-lg shadow-2xl w-full max-h-full flex flex-col focus:outline-none",
          xl ? "max-w-6xl" : wide ? "max-w-3xl" : "max-w-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-ink-700 bg-ink-900 shrink-0 rounded-t-lg">
          <h3 id={titleId} className="text-sm font-semibold text-white">
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-ink-400 hover:text-white cursor-pointer text-lg leading-none"
          >
            ×
          </button>
        </header>
        <div ref={body} className="p-5 overflow-y-auto min-h-0">
          {children}
        </div>
        {footer && (
          <div className="px-5 py-3 border-t border-ink-700 bg-ink-900 shrink-0 rounded-b-lg">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between mb-5">
      <div>
        <h1 className="text-xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-ink-400 text-sm mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
