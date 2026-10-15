"use client";

import {
  ExternalLink,
  ImageIcon,
  LoaderCircle,
  Maximize2,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type ImageView = Point & { scale: number | null };
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
const controlClass =
  "flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan disabled:cursor-default disabled:opacity-35";

/** Keeps the image within reach after zooming, dragging, or resizing the viewer. */
function constrainPan(
  point: Point,
  image: Size,
  viewport: Size,
  scale: number,
) {
  const maxX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, point.x)),
    y: Math.max(-maxY, Math.min(maxY, point.y)),
  };
}

/** Provides attachment inspection with bounded zoom, pointer panning, and native modal focus. */
export function DiscussionImageViewer({
  image,
  onClose,
}: {
  image: { src: string; alt: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<ImageView>({ scale: null, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const helpId = useId();
  const ready = size.width > 0 && viewport.width > 0 && !failed;
  const fitScale = ready
    ? Math.min(
        1,
        Math.max(1, viewport.width - 48) / size.width,
        Math.max(1, viewport.height - 48) / size.height,
      )
    : 1;
  const minScale = Math.min(fitScale, 0.1);
  const scale = view.scale ?? fitScale;
  const pan = constrainPan(view, size, viewport, scale);
  const canPan =
    ready &&
    (size.width * scale > viewport.width ||
      size.height * scale > viewport.height);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
      close.current?.focus();
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    /** Measures the usable canvas as the window or toolbar changes size. */
    const measure = () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Zooms about the requested canvas point, retaining the detail under the pointer. */
  const zoom = useCallback(
    (factor: number, anchor: Point = { x: 0, y: 0 }) => {
      if (!ready) return;
      setView((previous) => {
        const currentScale = previous.scale ?? fitScale;
        const currentPan = constrainPan(previous, size, viewport, currentScale);
        const nextScale = Math.min(
          MAX_SCALE,
          Math.max(minScale, currentScale * factor),
        );
        const ratio = nextScale / currentScale;
        return {
          scale: nextScale,
          ...constrainPan(
            {
              x: anchor.x - (anchor.x - currentPan.x) * ratio,
              y: anchor.y - (anchor.y - currentPan.y) * ratio,
            },
            size,
            viewport,
            nextScale,
          ),
        };
      });
    },
    [fitScale, minScale, ready, size, viewport],
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    /** Handles trackpad and wheel zoom without scrolling the discussion behind the modal. */
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY) return;
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005), {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom]);

  /** Returns to the responsive overview and centers the attachment. */
  function fitImage() {
    setView({ scale: null, x: 0, y: 0 });
  }

  /** Moves a zoomed image while preserving reachable edges. */
  function move(delta: Point) {
    setView((previous) => {
      const currentScale = previous.scale ?? fitScale;
      const currentPan = constrainPan(previous, size, viewport, currentScale);
      return {
        ...previous,
        ...constrainPan(
          { x: currentPan.x + delta.x, y: currentPan.y + delta.y },
          size,
          viewport,
          currentScale,
        ),
      };
    });
  }

  // Keep the native modal visible if the reading pane hides at a mobile breakpoint.
  return createPortal(
    <dialog
      ref={dialog}
      aria-label={`Image preview: ${image.alt}`}
      aria-describedby={helpId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          [
            "+",
            "=",
            "-",
            "0",
            "1",
            "f",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ].includes(event.key)
        ) {
          event.preventDefault();
          if (event.key === "+" || event.key === "=") zoom(ZOOM_STEP);
          if (event.key === "-") zoom(1 / ZOOM_STEP);
          if (event.key === "0" || event.key === "f") fitImage();
          if (event.key === "1" && ready) setView({ scale: 1, x: 0, y: 0 });
          if (event.key === "ArrowLeft") move({ x: 80, y: 0 });
          if (event.key === "ArrowRight") move({ x: -80, y: 0 });
          if (event.key === "ArrowUp") move({ x: 0, y: 80 });
          if (event.key === "ArrowDown") move({ x: 0, y: -80 });
        }
      }}
      className="bg-panel border-line text-cloud fixed inset-0 m-auto hidden h-[94dvh] max-h-none w-[96vw] max-w-none flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl open:flex backdrop:bg-black/75 backdrop:backdrop-blur-sm max-sm:h-dvh max-sm:w-screen max-sm:rounded-none"
    >
      <header className="border-line flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-5">
        <span className="bg-cyan/10 text-cyan grid size-9 shrink-0 place-items-center rounded-lg">
          <ImageIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" title={image.alt}>
            {image.alt}
          </h2>
          <p className="text-fog mt-0.5 text-[11px]">
            {size.width
              ? `${size.width.toLocaleString()} × ${size.height.toLocaleString()} px`
              : "Image preview"}
          </p>
        </div>
        <a
          href={image.src}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(controlClass, "text-mist")}
          aria-label="Open original image in a new tab"
          title="Open original image in a new tab"
        >
          <span className="hidden sm:inline">Open original</span>
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <span className="bg-line h-6 w-px" aria-hidden="true" />
        <button
          ref={close}
          type="button"
          aria-label="Close image preview"
          title="Close (Esc)"
          onClick={onClose}
          className={cn(controlClass, "size-9 px-0")}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="border-line flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-5">
        <fieldset
          aria-label="Image zoom"
          className="m-0 flex min-w-0 items-center gap-1 border-0 p-0"
        >
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={!ready || scale <= minScale}
            onClick={() => zoom(1 / ZOOM_STEP)}
            className={cn(controlClass, "size-9 px-0")}
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <output
            aria-label="Zoom level"
            aria-live="polite"
            className="w-14 text-center font-mono text-xs tabular-nums"
          >
            {ready ? `${Math.round(scale * 100)}%` : "—"}
          </output>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={!ready || scale >= MAX_SCALE}
            onClick={() => zoom(ZOOM_STEP)}
            className={cn(controlClass, "size-9 px-0")}
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
          <span className="bg-line mx-1 h-5 w-px sm:mx-2" aria-hidden="true" />
          <button
            type="button"
            aria-label="Fit image to view"
            aria-pressed={view.scale === null}
            title="Fit to view (0)"
            disabled={!ready}
            onClick={fitImage}
            className={cn(
              controlClass,
              "px-2 sm:px-3",
              view.scale === null && "bg-cyan/10 text-cyan",
            )}
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
            Fit
          </button>
          <button
            type="button"
            aria-label="View image at actual size"
            aria-pressed={view.scale === 1}
            title="Actual size (1)"
            disabled={!ready}
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            className={cn(
              controlClass,
              "px-2 sm:px-3",
              view.scale === 1 && "bg-cyan/10 text-cyan",
            )}
          >
            <Scan className="hidden size-3.5 sm:block" aria-hidden="true" />
            100%
          </button>
        </fieldset>
        <span className="text-fog hidden text-[11px] md:inline">
          Scroll to zoom · Drag to pan
        </span>
      </div>

      <section
        ref={canvas}
        aria-label="Image canvas"
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden bg-surface-subtle/60 select-none",
          ready &&
            (canPan
              ? dragging
                ? "cursor-grabbing"
                : "cursor-grab"
              : "cursor-zoom-in"),
        )}
        onDoubleClick={() => {
          if (!ready) return;
          if (view.scale === null)
            setView({ scale: Math.max(1, fitScale * 2), x: 0, y: 0 });
          else fitImage();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !ready) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const other = [...pointers.current.entries()].find(
            ([id]) => id !== event.pointerId,
          )?.[1];
          const current = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, current);
          if (other) {
            const before = Math.hypot(
              previous.x - other.x,
              previous.y - other.y,
            );
            const after = Math.hypot(current.x - other.x, current.y - other.y);
            const rect = event.currentTarget.getBoundingClientRect();
            if (before > 0)
              zoom(after / before, {
                x: (current.x + other.x) / 2 - rect.left - rect.width / 2,
                y: (current.y + other.y) / 2 - rect.top - rect.height / 2,
              });
          } else move({ x: current.x - previous.x, y: current.y - previous.y });
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId);
          setDragging(pointers.current.size > 0);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          setDragging(pointers.current.size > 0);
        }}
      >
        {!ready && !failed && (
          <div
            role="status"
            className="text-fog absolute inset-0 flex items-center justify-center gap-2 text-sm"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading image…
          </div>
        )}
        {failed ? (
          <div
            role="status"
            className="text-mist absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm"
          >
            <ImageIcon className="text-fog mb-1 size-8" aria-hidden="true" />
            <p>This image couldn’t be loaded.</p>
            <p className="text-fog text-xs">
              Try opening the original image above.
            </p>
          </div>
        ) : (
          // biome-ignore lint/performance/noImgElement: load the original provider attachment directly
          <img
            src={image.src}
            alt={image.alt}
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            className="absolute top-1/2 left-1/2 max-w-none shadow-lg"
            style={{
              width: size.width,
              height: size.height,
              visibility: ready ? "visible" : "hidden",
              transformOrigin: "0 0",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale}) translate(-50%, -50%)`,
            }}
          />
        )}
      </section>
      <footer
        id={helpId}
        className="border-line text-fog flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5 text-[10px] sm:px-5 sm:text-[11px]"
      >
        <span>
          Double-click to toggle actual size
          <span className="hidden sm:inline">
            {" "}
            · + / − to zoom · Arrow keys to pan
          </span>
        </span>
        <span className="shrink-0">
          <kbd className="border-line mr-1 rounded border px-1 py-0.5 font-mono text-[10px]">
            Esc
          </kbd>{" "}
          to close
        </span>
      </footer>
    </dialog>,
    document.body,
  );
}
