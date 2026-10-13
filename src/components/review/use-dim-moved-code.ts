"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "reviewduck:dim-moved-code";

/** Shares and remembers the movement display preference independently of navigation. */
export function useDimMovedCode() {
  const [dimMovedCode, setDimMovedCode] = useState(false);
  useEffect(() => {
    try {
      setDimMovedCode(window.localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      // Restricted storage still leaves the toggle usable for this workspace.
    }
  }, []);
  const changeDimMovedCode = useCallback((checked: boolean) => {
    setDimMovedCode(checked);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(checked));
    } catch {
      // The workspace state remains shared across Files and Guided.
    }
  }, []);
  return { dimMovedCode, changeDimMovedCode };
}
