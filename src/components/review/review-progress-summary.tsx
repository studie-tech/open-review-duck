"use client";

import { ChartNoAxesColumn, ChevronRight, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReviewFileEntry, ReviewMode } from "~/lib/review-files";
import {
  type ProgressUnit,
  reviewProgressBreakdown,
} from "~/lib/review-progress";
import { ReviewChangeComposition } from "./review-change-composition";

const number = new Intl.NumberFormat("en-US");

/** Keeps progress readable in a narrow sidebar, with line volume available on demand. */
export function ReviewProgressSummary({
  files,
  units,
  mode,
  conceptsRemaining,
}: {
  files: readonly ReviewFileEntry[];
  units: readonly ProgressUnit[];
  mode: ReviewMode;
  conceptsRemaining: number;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();
  const groups = useMemo(() => reviewProgressBreakdown(units), [units]);
  const signed = units.filter(({ status }) => status === "signed_off").length;
  const reviewable = files.filter(({ totalUnits }) => totalUnits > 0);
  const reviewed = reviewable.filter(
    ({ state }) => state === "reviewed",
  ).length;
  const totalLines = groups.reduce((sum, group) => sum + group.lines, 0);
  const reviewedLines = groups.reduce(
    (sum, group) => sum + group.reviewedLines,
    0,
  );
  const percent = units.length ? (signed / units.length) * 100 : 0;
  const excluded = files.length - reviewable.length;

  useLayoutEffect(() => {
    if (!open) return;
    /** Fits the detail panel beside its trigger without clipping the sidebar or viewport. */
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = panel.current?.offsetWidth ?? 380;
      const height = panel.current?.offsetHeight ?? 400;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: Math.max(
          12,
          Math.min(rect.bottom + 8, window.innerHeight - height - 12),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    /** Dismisses before workspace shortcuts can navigate away from the popup. */
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    /** Allows outside clicks and keyboard focus to dismiss this non-modal panel. */
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("keydown", dismissOnEscape, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[.12em] text-fog">
        {mode === "files" ? "Changed files" : "Review concepts"}
      </span>
      <button
        ref={trigger}
        type="button"
        aria-label="Review details"
        title="Review progress and change breakdown"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="flex shrink-0 items-center gap-2 rounded-md border border-line px-2 py-1 text-[10px] text-fog hover:border-cyan/40 hover:text-cyan focus-visible:outline-2 focus-visible:outline-cyan"
      >
        <span className="whitespace-nowrap tabular-nums">
          {mode === "files"
            ? `${number.format(files.length)} files`
            : `${number.format(conceptsRemaining)} left`}
        </span>
        <ChartNoAxesColumn className="size-3.5" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-modal="false"
            onKeyDown={(event) => event.stopPropagation()}
            aria-labelledby={`${id}-title`}
            className="fixed z-[60] max-h-[calc(100dvh-24px)] w-[380px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-line-strong bg-panel shadow-2xl"
            style={position}
          >
            <div className="flex items-start justify-between gap-3 border-b border-line p-4">
              <div>
                <h2
                  id={`${id}-title`}
                  className="text-sm font-semibold text-cloud"
                >
                  Review details
                </h2>
                <p className="mt-1 text-[11px] text-fog">
                  Progress and change composition for this PR
                </p>
              </div>
              <button
                ref={close}
                type="button"
                aria-label="Close review details"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className="rounded-md p-1 text-fog hover:bg-surface-hover hover:text-cloud focus-visible:outline-2 focus-visible:outline-cyan"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-2.5 border-b border-line px-4 py-3">
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
                <span className="text-mist">
                  {mode === "path" ? "Concepts remaining" : "Files reviewed"}
                </span>
                <span className="shrink-0 whitespace-nowrap font-medium text-cloud tabular-nums">
                  {mode === "path"
                    ? number.format(conceptsRemaining)
                    : `${number.format(reviewed)} / ${number.format(reviewable.length)}`}
                </span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
                <span className="text-mist">Units reviewed</span>
                <span className="shrink-0 whitespace-nowrap font-medium text-cloud tabular-nums">
                  {number.format(signed)} / {number.format(units.length)}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Review units completed"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${number.format(signed)} of ${number.format(units.length)} units reviewed`}
                className="h-1 overflow-hidden rounded-full bg-surface-hover"
              >
                <div
                  className="h-full rounded-full bg-lime transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="mb-3 flex items-center justify-between text-[10px] text-fog">
                <span>File type</span>
                <span>Reviewed / changed lines</span>
              </div>
              {groups.map((group) => (
                <details
                  key={group.key}
                  className="group border-t border-line py-2.5"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-cyan [&::-webkit-details-marker]:hidden">
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronRight
                        className="size-3 shrink-0 text-fog transition-transform group-open:rotate-90"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-medium text-cloud">
                        {group.label}
                        <span className="mt-0.5 block text-[10px] font-normal text-fog">
                          {number.format(group.files)}{" "}
                          {group.files === 1 ? "file" : "files"}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-cloud tabular-nums">
                      <span className="text-fog">
                        {number.format(group.reviewedLines)} /{" "}
                      </span>
                      {number.format(group.lines)}
                    </span>
                  </summary>
                  <ul className="mt-3 space-y-2 pl-5">
                    {group.types.map((type) => (
                      <li
                        key={type.label}
                        className="flex items-center justify-between gap-3 text-[11px]"
                      >
                        <span className="min-w-0 break-all text-mist">
                          {type.label}{" "}
                          <span className="text-fog">
                            · {number.format(type.files)}{" "}
                            {type.files === 1 ? "file" : "files"}
                          </span>
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-cloud tabular-nums">
                          <span className="text-fog">
                            {number.format(type.reviewedLines)} /{" "}
                          </span>
                          {number.format(type.lines)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
              <div className="mt-1 flex items-center justify-between border-t border-line pt-3 text-xs font-medium text-cloud">
                <span>Total</span>
                <span className="whitespace-nowrap tabular-nums">
                  {number.format(reviewedLines)} / {number.format(totalLines)}
                </span>
              </div>
            </div>
            {mode === "files" && (
              <div className="border-t border-line px-4 py-3">
                <p className="mb-2 text-[10px] font-medium text-fog">
                  File changes
                </p>
                <ReviewChangeComposition files={files} />
              </div>
            )}
            <div className="border-t border-line px-4 py-3 text-[10px] leading-relaxed text-fog">
              Counts added + deleted text lines. Reviewed lines belong to
              signed-off units. Binary files have no text-line count.
              {excluded > 0 && (
                <p className="mt-1">
                  {number.format(excluded)}{" "}
                  {excluded === 1 ? "file has" : "files have"} no review units
                  and {excluded === 1 ? "is" : "are"} excluded from these
                  totals.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
