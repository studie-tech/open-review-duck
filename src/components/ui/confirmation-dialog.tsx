"use client";

import type { ReactNode } from "react";
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
  pending?: boolean;
  pendingLabel?: ReactNode;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = `confirmation-${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "")}-title`;
  const descriptionId = `${titleId}-description`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cancel confirmation"
        disabled={pending}
        className="absolute inset-0 cursor-default"
        onClick={onCancel}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="bg-panel relative w-full max-w-md rounded-2xl border border-line-strong p-5 shadow-2xl shadow-black/30 sm:p-6"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) onCancel();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onConfirm();
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
            disabled={pending}
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
    </div>
  );
}
