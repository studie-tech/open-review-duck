"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { ShortcutHint } from "~/components/command-center";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type ConfirmationVariant = "primary" | "danger";

/** Renders a keyboard-accessible confirmation dialog with consistent actions. */
export function ConfirmationDialog({
  confirmLabel,
  confirmVariant = "primary",
  description,
  icon,
  iconClassName,
  confirmDisabled = false,
  pending = false,
  pendingLabel,
  title,
  onCancel,
  onConfirm,
}: {
  confirmLabel: string;
  confirmVariant?: ConfirmationVariant;
  description: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
  confirmDisabled?: boolean;
  pending?: boolean;
  pendingLabel?: ReactNode;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }

    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    /** Dismisses the modal independently of which element currently has focus. */
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || pending) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }

    document.addEventListener("keydown", dismissOnEscape, true);
    return () => document.removeEventListener("keydown", dismissOnEscape, true);
  }, [onCancel, pending]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="w-full max-w-md bg-transparent p-4 backdrop:bg-black/65 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <form
        className="bg-panel relative w-full rounded-2xl border border-line-strong p-5 shadow-2xl shadow-black/30 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && !confirmDisabled) onConfirm();
        }}
      >
        {icon && (
          <div
            className={cn(
              "bg-coral/10 grid size-10 place-items-center rounded-xl",
              iconClassName,
            )}
          >
            {icon}
          </div>
        )}
        <h2
          id={titleId}
          className={cn(
            "text-cloud text-base font-semibold",
            icon ? "mt-4" : undefined,
          )}
        >
          {title}
        </h2>
        <div id={descriptionId} className="text-mist mt-2 text-sm leading-6">
          {description}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant={confirmVariant}
            autoFocus
            disabled={pending || confirmDisabled}
          >
            {pending ? (
              pendingLabel
            ) : (
              <>
                {confirmLabel}
                <ShortcutHint shortcut={[{ key: "Enter" }]} />
              </>
            )}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
