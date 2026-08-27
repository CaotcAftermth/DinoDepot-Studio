import {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useToggled, useUiPrefsStore } from "../stores/uiPrefsStore";
import type { FeedbackTargetProps } from "../model/feedback/targets";

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

/**
 * Multi-line text, styled like {@link Input}.
 *
 * `field-sizing: content` is deliberately not used: it is not in every webview
 * this ships to, and a box that silently does not grow is worse than one that
 * never claimed it would. Callers set `rows` for the height they want.
 */
export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "bg-ink-900 border border-ink-600 rounded-md px-2.5 py-1.5 text-sm text-ink-100",
        "focus:outline-none focus:border-accent-500/60 placeholder:text-ink-400",
        "min-w-0 resize-y leading-relaxed",
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
    <Tag
      className={cx("block", className)}
      data-feedback-field-name={typeof label === "string" ? label : undefined}
    >
      <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-ink-400 mt-1">{hint}</span>}
    </Tag>
  );
}

/**
 * A `?` beside a control, explaining it on hover or focus.
 *
 * Drawn rather than left to the browser's `title`, which waits a second before
 * appearing, cannot be reached from the keyboard at all, and paints itself in
 * the operating system's colours in the middle of a dark card. Clicking it
 * pins the bubble open, which is what a touch screen has instead of a hover.
 */
export function HelpDot({
  text,
  label = "What this means",
  className,
}: {
  text: string;
  /** What a screen reader announces the button as, before reading `text`. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={cx("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className="w-7 h-7 rounded-full border border-ink-600 bg-ink-800 text-ink-300 text-xs font-semibold leading-none hover:bg-ink-700 hover:text-ink-100 cursor-help"
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 bottom-full z-30 mb-2 w-64 -translate-x-1/2 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-200 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  feedback,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Marks the card as reportable, from `feedbackTarget(...)`.
   *
   * A prop rather than a wrapper element, so instrumenting a card cannot
   * change what it looks like — an extra `<div>` around a grid item or a flex
   * child is exactly the sort of thing that moves a layout by four pixels and
   * gets blamed on something else a week later.
   */
  feedback?: FeedbackTargetProps;
}) {
  return (
    <section
      {...feedback}
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
  feedback,
  onOpenChange,
}: {
  title?: ReactNode;
  collapsedSummary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /**
   * Fired when the admin folds or unfolds this card, never on a change the
   * owner made itself. For sections where opening one card should close its
   * siblings — a list of cycles is only navigable one at a time.
   */
  onOpenChange?: (open: boolean) => void;
  /** Marks the card as reportable. See {@link Card}. */
  feedback?: FeedbackTargetProps;
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
    onOpenChange?.(next);
  };
  const bodyId = useId();

  return (
    <section
      {...feedback}
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
          data-collapse-key={prefKey}
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
        // `rounded-md`, the same corner every button and input in the app
        // uses. A pill next to a square-cornered card and a square-cornered
        // button reads as something borrowed from a different interface.
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border",
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
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  /** Hover explanation, for switches whose meaning isn't obvious from the label. */
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cx(
        "inline-flex items-center gap-2",
        disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
      )}
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

export type ModalPlacement = "start" | "center" | "end";

const MODAL_PLACEMENTS: ModalPlacement[] = ["start", "center", "end"];
const MODAL_PLACEMENT_LABELS: Record<ModalPlacement, string> = {
  start: "left",
  center: "center",
  end: "right",
};

/**
 * Makes Back dismiss a dialog instead of navigating the page behind it.
 *
 * A modal is modal to the pointer and the keyboard but not to history: a mouse
 * with a Back button, or Alt+Left, moved the app to another page while the
 * dialog stayed open on top of it. So an entry pointing at the same page is
 * parked on the stack when a dialog opens, and the Back that pops it closes
 * the dialog instead of going anywhere — which is what pressing Back over a
 * dialog is asking for anyway.
 *
 * The entry is deliberately *not* taken off again when the dialog closes some
 * other way. Removing it means calling `history.back()`, which is a real
 * navigation the router also reacts to, and under React's development double
 * mount the push and the pop interleave and land the app a page back. The cost
 * of leaving it is one Back press that does nothing, once, and only after a
 * dialog has been opened and closed without using Back — and the next dialog
 * reuses the same entry rather than adding another.
 */
/** Marks the entry this hook parks on top of the real one. */
interface DialogHistoryState {
  ddDialog?: true;
}

function onDialogEntry(): boolean {
  return Boolean((window.history.state as DialogHistoryState | null)?.ddDialog);
}

function useHistoryDismiss(onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Only when there is not one there already. React's development double
    // mount runs this effect twice, and a nested confirmation is a second
    // dialog over the same page — neither should stack a second entry, and
    // one entry closes whatever is open on top of it either way.
    if (!onDialogEntry()) {
      window.history.pushState({ ddDialog: true }, "", window.location.href);
    }

    function onPop() {
      close.current();
    }

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}

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
  subtitle,
  onClose,
  children,
  footer,
  backdropDecoration,
  avoidElement,
  placementOverride,
  onPlacementChange,
  wide,
  medium,
  xl,
  layer = "default",
}: {
  title: string;
  /** Supporting copy shown below the title when the dialog needs more hierarchy. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Actions pinned to the bottom of the panel. Method editing makes this
   * modal very tall, and Save should not require scrolling to reach.
   */
  footer?: ReactNode;
  /**
   * Visual content between the page and the panel, such as a selected-element
   * spotlight. It must not accept pointer input; the modal owns the backdrop.
   */
  backdropDecoration?: ReactNode;
  /** Places the panel on the side with more distance from this live page element. */
  avoidElement?: Element | null;
  /** A user-selected position. Null leaves positioning to `avoidElement`. */
  placementOverride?: ModalPlacement | null;
  /** When provided, shows a header control that cycles left, center and right. */
  onPlacementChange?: (placement: ModalPlacement) => void;
  wide?: boolean;
  /** Between the default form width and the wide editor width. */
  medium?: boolean;
  /** Extra-wide, for side-by-side layouts like the INI composer. */
  xl?: boolean;
  /** Confirmations must sit above the modal whose action requested them. */
  layer?: "default" | "confirmation";
}) {
  // Only dismiss when the press *starts* on the backdrop — otherwise
  // selecting text inside and releasing outside would close the modal.
  const pressedBackdrop = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [automaticPlacement, setAutomaticPlacement] =
    useState<ModalPlacement>("center");
  const placement = placementOverride ?? automaticPlacement;
  const nextPlacement = MODAL_PLACEMENTS[
    (MODAL_PLACEMENTS.indexOf(placement) + 1) % MODAL_PLACEMENTS.length
  ];

  // `onClose` is usually an inline arrow, so read it through a ref rather than
  // re-running the key handler effect (and the stack bookkeeping) every render.
  const close = useRef(onClose);
  close.current = onClose;

  // Back closes this rather than moving the page underneath it.
  useHistoryDismiss(onClose);

  useLayoutEffect(() => {
    if (!avoidElement) {
      setAutomaticPlacement("center");
      return;
    }

    function place() {
      if (!avoidElement?.isConnected || window.innerWidth < 960) {
        setAutomaticPlacement("center");
        return;
      }
      const rect = avoidElement.getBoundingClientRect();
      setAutomaticPlacement(
        rect.left + rect.width / 2 <= window.innerWidth / 2 ? "end" : "start",
      );
    }

    place();
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [avoidElement]);

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
      className={cx(
        "fixed inset-0 flex items-center p-8",
        placement === "center" && "justify-center",
        placement === "start" && "justify-start",
        placement === "end" && "justify-end",
        !backdropDecoration && "bg-black/60",
        layer === "confirmation" ? "z-[80]" : "z-40",
      )}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      {backdropDecoration && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
          {backdropDecoration}
        </div>
      )}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative z-10 bg-ink-900 border border-ink-600 rounded-lg shadow-2xl w-full max-h-full flex flex-col focus:outline-none",
          xl
            ? "max-w-6xl"
            : wide
              ? "max-w-3xl"
              : medium
                ? "max-w-2xl"
                : "max-w-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-ink-700 bg-ink-900 shrink-0 rounded-t-lg">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-semibold leading-tight text-white">
              {title}
            </h3>
            {subtitle && (
              <p className="mt-1 text-xs leading-relaxed text-ink-400">{subtitle}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onPlacementChange && (
              <button
                type="button"
                onClick={() => onPlacementChange(nextPlacement)}
                aria-label={`Move dialog to the ${MODAL_PLACEMENT_LABELS[nextPlacement]}`}
                title={`Move to ${MODAL_PLACEMENT_LABELS[nextPlacement]}`}
                className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-transparent text-ink-400 hover:border-ink-600 hover:bg-ink-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent-500/50"
              >
                <ModalPlacementIcon placement={placement} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md text-lg leading-none text-ink-400 hover:bg-ink-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent-500/50"
            >
              ×
            </button>
          </div>
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

/** A miniature viewport with the current panel position filled in. */
function ModalPlacementIcon({ placement }: { placement: ModalPlacement }) {
  return (
    <span
      className="relative block h-3.5 w-5 rounded-[3px] border border-current/60"
      aria-hidden
    >
      <span
        className={cx(
          "absolute bottom-0.5 top-0.5 w-1.5 rounded-[1px] bg-current",
          placement === "start" && "left-0.5",
          placement === "center" && "left-1/2 -translate-x-1/2",
          placement === "end" && "right-0.5",
        )}
      />
    </span>
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
