"use client";

import {
  type InboxInvolvement,
  inboxInvolvementChoices,
} from "~/lib/pull-request-involvement";
import { cn } from "~/lib/utils";

/** Segmented choice for pull requests assigned to you, opened by you, or both. */
export function InvolvementFilter({
  onChange,
  value,
}: {
  onChange: (value: InboxInvolvement) => void;
  value: InboxInvolvement;
}) {
  return (
    <fieldset className="flex min-w-0 items-center gap-2 border-0 p-0">
      <legend className="text-mist float-left w-auto px-0 text-xs leading-9">
        Show
      </legend>
      <div className="bg-ink/35 flex h-9 max-w-full items-center overflow-x-auto rounded-xl border border-line p-0.5">
        {inboxInvolvementChoices.map((choice) => {
          const selected = value === choice.id;
          return (
            <label
              className={cn(
                "flex h-full cursor-pointer items-center rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-lime/55",
                selected
                  ? "bg-lime text-accent-foreground shadow-sm"
                  : "text-mist hover:text-cloud",
              )}
              key={choice.id}
              title={choice.description}
            >
              <input
                checked={selected}
                className="sr-only"
                name="inbox-involvement"
                onChange={() => onChange(choice.id)}
                type="radio"
                value={choice.id}
              />
              {choice.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
