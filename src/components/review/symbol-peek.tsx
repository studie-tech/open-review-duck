"use client";

import { ArrowUpRight, FileCode2, X } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "~/components/ui/badge";
import {
  peekPlacement,
  SYMBOL_PEEK_ATTRIBUTE,
  SYMBOL_PEEK_CARD_WIDTH,
  SYMBOL_PEEK_CLOSE_DELAY_MS,
  SYMBOL_PEEK_HOVER_DELAY_MS,
  SYMBOL_PEEK_LINE_ATTRIBUTE,
  SYMBOL_PEEK_MAXIMUM_LINES,
} from "~/lib/symbol-peek";
import { useHighlightedSource } from "~/lib/syntax-highlighting";
import { cn } from "~/lib/utils";
import { HighlightedTokens } from "./highlighted-tokens";

/** The name the pointer is resting on, and where on screen it sits. */
export interface PeekedSymbol {
  anchor: { bottom: number; left: number; top: number };
  line?: number;
  symbol: string;
}

/** One resolved declaration, as the review router reports it. */
export interface SymbolDefinition {
  endLine: number;
  focusLine: number;
  language: string;
  name: string;
  path: string;
  signature?: string;
  source: string;
  startLine: number;
  unitId?: string;
  unitKind: string;
}

/**
 * Follows the pointer across the diff and names what it is resting on.
 *
 * One listener on the scrolling code pane serves every token, so marking a
 * name as looked-up-able costs an attribute rather than a pair of handlers.
 * The dwell before a lookup, and the grace after the pointer leaves, are what
 * keep a card from flickering past while the reviewer is only reading.
 */
export function useSymbolPeek(enabled: boolean) {
  const [peeked, setPeeked] = useState<PeekedSymbol>();
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinned = useRef(false);
  // The card is anchored to one occurrence, not to a name: the same name can
  // appear on several lines, and the second one has to move the card to it.
  const anchored = useRef<HTMLElement>(undefined);

  /** Cancels whichever transition the pointer has not yet completed. */
  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  const close = useCallback(() => {
    clearTimers();
    pinned.current = false;
    anchored.current = undefined;
    setPeeked(undefined);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    // Peeking stops with the source it reads, and the card must not outlive
    // it: switching units unmounts the token it was anchored to, which would
    // otherwise leave a card pointing at a line that is no longer there.
    if (!enabled) close();
  }, [close, enabled]);

  useEffect(() => {
    if (!peeked) return;
    const token = anchored.current;
    if (!token) return;
    const observer = new MutationObserver(() => {
      if (!token.isConnected) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [close, peeked]);

  useEffect(() => {
    if (!peeked) return;
    /** Dismisses the card on the keystroke that dismisses everything else. */
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, peeked]);

  /** Opens the card for one name, immediately on click or after a hover dwell. */
  const revealPeek = useCallback(
    (event: ReactMouseEvent<HTMLElement>, immediate: boolean) => {
      if (!enabled) return;
      const token = (
        event.target as HTMLElement | null
      )?.closest?.<HTMLElement>(`[${SYMBOL_PEEK_ATTRIBUTE}]`);
      const symbol = token?.getAttribute(SYMBOL_PEEK_ATTRIBUTE);
      if (!token || !symbol) return;
      clearTimers();
      if (!immediate && anchored.current === token) return;
      const line = Number(token.getAttribute(SYMBOL_PEEK_LINE_ATTRIBUTE));
      /** Places the card on the token that is still in the document. */
      const open = () => {
        // The dwell outlives a re-render, which can take the token with it.
        if (!token.isConnected) return;
        const bounds = token.getBoundingClientRect();
        pinned.current = immediate;
        anchored.current = token;
        setPeeked({
          anchor: {
            bottom: bounds.bottom,
            left: bounds.left,
            top: bounds.top,
          },
          line: Number.isInteger(line) && line > 0 ? line : undefined,
          symbol,
        });
      };
      if (immediate) {
        event.stopPropagation();
        open();
        return;
      }
      openTimer.current = setTimeout(open, SYMBOL_PEEK_HOVER_DELAY_MS);
    },
    [clearTimers, enabled],
  );

  const onPointerOver = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => revealPeek(event, false),
    [revealPeek],
  );

  const onPointerActivate = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => revealPeek(event, true),
    [revealPeek],
  );

  /** Lets the pointer cross the gap between a name and the card below it. */
  const onPointerOut = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      if (pinned.current) return;
      anchored.current = undefined;
      setPeeked(undefined);
    }, SYMBOL_PEEK_CLOSE_DELAY_MS);
  }, [clearTimers]);

  /** Holds the card open for as long as the pointer is inside it. */
  const holdOpen = useCallback(
    (held: boolean) => {
      pinned.current = held;
      if (held) clearTimers();
      else onPointerOut();
    },
    [clearTimers, onPointerOut],
  );

  return {
    close,
    holdOpen,
    peeked,
    peekHandlers: {
      onClick: onPointerActivate,
      onMouseOut: onPointerOut,
      onMouseOver: onPointerOver,
    },
  };
}

/**
 * Says why a lookup came back without a declaration, when that is worth saying.
 *
 * A name whose declaration is missing, or is the code already on screen, is
 * answered with silence: hovering ordinary identifiers must not litter the
 * diff. A lookup the reviewer asked for that could not be carried out is
 * different, and reads as "no such symbol" unless it says otherwise.
 */
export function symbolPeekNotice(reason: string) {
  if (reason === "unavailable") {
    return "This symbol could not be looked up. The provider did not answer.";
  }
  if (reason === "too_large") {
    return "The file that declares this symbol is too large to preview.";
  }
  return undefined;
}

/** Places one short message where a definition card would have gone. */
export function SymbolPeekMessage({
  message,
  peeked,
}: {
  message: string;
  peeked: PeekedSymbol;
}) {
  const placement = peekPlacement(peeked.anchor, {
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    width: typeof window === "undefined" ? 1200 : window.innerWidth,
  });
  return (
    <p
      role="status"
      style={{
        left: placement.left,
        top: placement.top,
        transform:
          placement.placement === "above" ? "translateY(-100%)" : undefined,
      }}
      className="border-line bg-panel text-mist fixed z-[60] max-w-[min(360px,calc(100vw-24px))] rounded-lg border px-3 py-2 font-sans text-[11px] leading-5 shadow-[0_16px_40px_var(--app-shadow)]"
    >
      {message}
    </p>
  );
}

/**
 * Shows one symbol's declaration beside the code that uses it.
 *
 * Mounted only once a declaration has been found somewhere the reviewer is
 * not already looking, so a name with nothing to add stays quiet instead of
 * flashing a card that says so.
 */
export function SymbolPeekCard({
  definition,
  onClose,
  onHold,
  onOpenUnit,
  peeked,
}: {
  definition: SymbolDefinition;
  onClose: () => void;
  onHold: (held: boolean) => void;
  onOpenUnit?: (unitId: string) => void;
  peeked: PeekedSymbol;
}) {
  const [viewport, setViewport] = useState({
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    width: typeof window === "undefined" ? 1200 : window.innerWidth,
  });

  useEffect(() => {
    /** Re-places the card when the window changes size beneath it. */
    function onResize() {
      setViewport({ height: window.innerHeight, width: window.innerWidth });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const placement = peekPlacement(peeked.anchor, viewport);
  const lines = useHighlightedSource(definition.source, definition.language);
  const shown = lines.slice(0, SYMBOL_PEEK_MAXIMUM_LINES);
  const hidden = Math.max(0, lines.length - shown.length);

  return (
    <section
      aria-label={`Definition of ${peeked.symbol}`}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      style={{
        left: placement.left,
        maxHeight: placement.maxHeight,
        top: placement.top,
        transform:
          placement.placement === "above" ? "translateY(-100%)" : undefined,
        width: SYMBOL_PEEK_CARD_WIDTH,
      }}
      className="border-cyan/25 bg-panel fixed z-[60] flex max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border font-sans shadow-[0_20px_60px_var(--app-shadow)]"
    >
      <header className="bg-cyan/[.045] flex items-center gap-2 border-b border-line px-3 py-2">
        <FileCode2 className="text-cyan size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-cloud truncate font-mono text-[11px] font-medium">
          {peeked.symbol}
        </span>
        <Badge className="border-cyan/20 bg-cyan/8 text-cyan shrink-0 px-1.5 py-0.5 text-[8px] tracking-wider uppercase">
          {definition.unitKind.replace("_", " ")}
        </Badge>
        <button
          type="button"
          aria-label="Close the definition"
          onClick={onClose}
          className="text-mist hover:text-cloud ml-auto grid size-5 shrink-0 place-items-center rounded transition hover:bg-surface-subtle"
        >
          <X className="size-3" />
        </button>
      </header>
      <p className="text-fog shrink-0 truncate px-3 py-1.5 font-mono text-[9px]">
        {definition.path} · lines {definition.startLine}–{definition.endLine}
      </p>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line">
        {shown.map((line, index) => (
          <div
            key={`${definition.path}-${definition.startLine + index}`}
            className={cn(
              "grid grid-cols-[44px_1fr] px-2",
              definition.focusLine === definition.startLine + index &&
                "bg-cyan/[.07]",
            )}
          >
            <span className="text-fog pr-2 text-right font-mono text-[10px] select-none">
              {definition.startLine + index}
            </span>
            <pre className="syntax-code overflow-visible text-xs font-medium text-cloud">
              <HighlightedTokens tokens={line.tokens} />
            </pre>
          </div>
        ))}
      </div>
      <footer className="text-fog flex shrink-0 items-center gap-2 border-t border-line bg-surface-subtle/25 px-3 py-1.5 text-[9px]">
        {hidden > 0 ? <span>{hidden} more lines</span> : <span />}
        {definition.unitId && onOpenUnit && (
          <button
            type="button"
            onClick={() => {
              const unitId = definition.unitId;
              if (unitId) onOpenUnit(unitId);
              onClose();
            }}
            className="text-cyan hover:bg-cyan/[.08] ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition"
          >
            Open in review
            <ArrowUpRight className="size-3" />
          </button>
        )}
      </footer>
    </section>
  );
}
