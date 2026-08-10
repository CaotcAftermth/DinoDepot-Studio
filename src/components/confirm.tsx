import { create } from "zustand";
import { Button, Modal } from "./ui";

/**
 * In-app confirmation and choice dialogs.
 *
 * `window.confirm` is unreliable inside the Tauri webview, so destructive
 * actions use this instead: styled like the rest of the app, works in browser
 * mock mode, and can spell out exactly what is about to be lost. Some
 * decisions aren't yes/no — picking a parent creature over its variant, or
 * saving versus discarding — so a prompt can offer several named answers.
 */

export interface ChoiceOption {
  /** Value handed back to the caller. */
  key: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  /** Optional second line under the label. */
  hint?: string;
}

interface ChoiceRequest {
  title: string;
  message: string;
  /** Extra detail lines — e.g. what will be deleted along with it. */
  details?: string[];
  options: ChoiceOption[];
  /** Label for the dismiss button; null hides it (Esc still dismisses). */
  cancelLabel?: string | null;
  resolve: (key: string | null) => void;
}

interface ConfirmState {
  request: ChoiceRequest | null;
  ask(request: ChoiceRequest): void;
  answer(key: string | null): void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  ask(request) {
    set({ request });
  },
  answer(key) {
    const { request } = get();
    set({ request: null });
    request?.resolve(key);
  },
}));

/** Yes/no. Resolves true only when the confirm button is pressed. */
export function confirmDialog(options: {
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return chooseDialog({
    title: options.title,
    message: options.message,
    details: options.details,
    options: [
      {
        key: "confirm",
        label: options.confirmLabel ?? "Confirm",
        variant: options.danger ? "danger" : "primary",
      },
    ],
  }).then((key) => key === "confirm");
}

/** Several named answers. Resolves null when dismissed. */
export function chooseDialog(
  options: Omit<ChoiceRequest, "resolve">,
): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirmStore.getState().ask({ ...options, resolve });
  });
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const answer = useConfirmStore((s) => s.answer);
  if (!request) return null;

  // Stacked buttons once there is more than one real answer — side-by-side
  // options with sentence-long labels are a coin flip to read.
  const stacked = request.options.length > 1;

  return (
    <Modal title={request.title} onClose={() => answer(null)}>
      <p className="text-sm text-ink-200 whitespace-pre-wrap">
        {request.message}
      </p>
      {request.details && request.details.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {request.details.map((line, i) => (
            <li key={i} className="text-xs text-ink-400">
              • {line}
            </li>
          ))}
        </ul>
      )}
      <div
        className={
          stacked
            ? "flex flex-col gap-2 mt-5"
            : "flex justify-end gap-2 mt-5"
        }
      >
        {stacked ? (
          <>
            {request.options.map((option, i) => (
              <Button
                key={option.key}
                variant={option.variant ?? "secondary"}
                onClick={() => answer(option.key)}
                autoFocus={i === 0}
                className="text-left"
              >
                {option.label}
                {option.hint && (
                  <span className="block text-xs font-normal opacity-70 mt-0.5">
                    {option.hint}
                  </span>
                )}
              </Button>
            ))}
            {request.cancelLabel !== null && (
              <Button variant="ghost" onClick={() => answer(null)}>
                {request.cancelLabel ?? "Cancel"}
              </Button>
            )}
          </>
        ) : (
          <>
            {request.cancelLabel !== null && (
              <Button variant="ghost" onClick={() => answer(null)}>
                {request.cancelLabel ?? "Cancel"}
              </Button>
            )}
            {request.options.map((option) => (
              <Button
                key={option.key}
                variant={option.variant ?? "primary"}
                onClick={() => answer(option.key)}
                autoFocus
              >
                {option.label}
              </Button>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
