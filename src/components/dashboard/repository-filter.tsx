"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/utils";

export type RepositoryFilterOption = {
  key: string;
  label: string;
  provider: "github" | "gitlab" | "azure_devops";
};

const providerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  azure_devops: "Azure DevOps",
} as const;

/** Returns the compact label for the current repository selection. */
export function repositoryFilterLabel(
  repositories: readonly RepositoryFilterOption[],
  selected: readonly string[],
) {
  if (selected.length === 0) return "All repositories";
  if (selected.length === 1) {
    return (
      repositories.find((repository) => repository.key === selected[0])
        ?.label ?? "1 repository"
    );
  }
  return `${selected.length} repositories`;
}

/** Renders a multi-select repository filter for the pull-request inbox. */
export function RepositoryFilter({
  onChange,
  providerFilter,
  repositories,
  selected,
}: {
  onChange: (keys: string[]) => void;
  providerFilter: "all" | RepositoryFilterOption["provider"];
  repositories: readonly RepositoryFilterOption[];
  selected: readonly string[];
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const label = repositoryFilterLabel(repositories, selected);

  useEffect(() => {
    if (!open) return;
    /** Closes the menu when the reviewer clicks or focuses outside it. */
    function handlePointerDown(event: MouseEvent | FocusEvent) {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    }
    /** Closes the menu from the keyboard without changing the selection. */
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("focusin", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("focusin", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /** Toggles one repository without collapsing the menu. */
  function toggle(key: string) {
    if (selected.includes(key)) {
      onChange(selected.filter((item) => item !== key));
      return;
    }
    onChange([...selected, key]);
  }

  return (
    <div ref={rootRef} className="relative min-w-0 sm:max-w-52">
      <button
        type="button"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Filter by repository"
        onClick={() => setOpen((current) => !current)}
        className="bg-ink/35 flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-line px-3 text-left text-xs outline-none transition focus:border-line-strong"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown className="text-fog size-3.5 shrink-0" />
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Repositories"
          aria-multiselectable="true"
          className="bg-surface absolute z-20 mt-1 max-h-64 w-max min-w-full max-w-80 overflow-y-auto rounded-xl border border-line py-1 shadow-[0_12px_32px_var(--app-shadow)]"
        >
          <button
            type="button"
            role="option"
            aria-selected={selected.length === 0}
            onClick={() => onChange([])}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-surface-hover"
          >
            <SelectionMark checked={selected.length === 0} />
            All repositories
          </button>
          {repositories.map((repository) => {
            const checked = selected.includes(repository.key);
            return (
              <button
                key={repository.key}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(repository.key)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-surface-hover"
              >
                <SelectionMark checked={checked} />
                <span className="min-w-0 truncate">
                  {repository.label}
                  {providerFilter === "all"
                    ? ` · ${providerLabel[repository.provider]}`
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Renders the compact checked state used by each repository option. */
function SelectionMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border",
        checked ? "border-cyan bg-cyan text-ink" : "border-line",
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}
