import { useRef, useState } from "react";
import type { RouterOutputs } from "~/trpc/react";

type Workspace = RouterOutputs["review"]["workspace"];

/** Stages new source revisions even when unrelated router refreshes deliver them. */
export function useStagedReviewWorkspace(incoming: Workspace) {
  const [displayed, setDisplayed] = useState(incoming);
  const loadRequested = useRef(false);
  const available = incoming.snapshot?.id !== displayed.snapshot?.id;
  if (incoming !== displayed && (!available || loadRequested.current)) {
    loadRequested.current = false;
    setDisplayed(incoming);
  }
  return {
    displayed,
    available,
    requestLoad: () => {
      loadRequested.current = true;
    },
  };
}
