"use client";

import { useState } from "react";

/** Owns responsive drawer and persistent-column state for both side panels. */
export function useReviewPanelController() {
  const [pathPanelOpen, setPathPanelOpen] = useState(false);
  const [pathPanelCollapsed, setPathPanelCollapsed] = useState(false);
  const [insightsPanelOpen, setInsightsPanelOpen] = useState(false);
  const [insightsPanelCollapsed, setInsightsPanelCollapsed] = useState(false);

  /** Shows the review path as a drawer or desktop column. */
  function showPathPanel() {
    setPathPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1536px)").matches) {
      setInsightsPanelOpen(false);
      setInsightsPanelCollapsed(true);
      setPathPanelOpen(true);
    }
  }

  /** Hides the review-path drawer or collapses its desktop column. */
  function hidePathPanel() {
    setPathPanelOpen(false);
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelCollapsed(true);
    }
  }

  /** Toggles the review-path panel for the active responsive layout. */
  function togglePathPanel() {
    if (window.matchMedia("(min-width: 1536px)").matches) {
      setPathPanelOpen(false);
      setPathPanelCollapsed((current) => !current);
      return;
    }
    if (pathPanelOpen) setPathPanelOpen(false);
    else showPathPanel();
  }

  /** Shows AI assistance as a drawer or desktop column. */
  function showInsightsPanel() {
    setInsightsPanelCollapsed(false);
    if (!window.matchMedia("(min-width: 1280px)").matches) {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

  /** Hides the AI drawer or collapses its desktop column. */
  function hideInsightsPanel() {
    setInsightsPanelOpen(false);
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelCollapsed(true);
    }
  }

  /** Toggles AI assistance for the active responsive layout. */
  function toggleInsightsPanel() {
    if (window.matchMedia("(min-width: 1280px)").matches) {
      setInsightsPanelOpen(false);
      setInsightsPanelCollapsed((current) => !current);
      return;
    }
    if (insightsPanelOpen) setInsightsPanelOpen(false);
    else {
      setPathPanelOpen(false);
      setInsightsPanelOpen(true);
    }
  }

  return {
    hideInsightsPanel,
    hidePathPanel,
    insightsPanelCollapsed,
    insightsPanelOpen,
    pathPanelCollapsed,
    pathPanelOpen,
    setInsightsPanelCollapsed,
    setInsightsPanelOpen,
    setPathPanelCollapsed,
    setPathPanelOpen,
    showInsightsPanel,
    showPathPanel,
    toggleInsightsPanel,
    togglePathPanel,
  };
}
