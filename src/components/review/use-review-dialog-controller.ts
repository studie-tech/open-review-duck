"use client";

import { useState } from "react";

interface ReviewDialogControllerInput {
  importPreviewOpen: boolean;
  linePickerOpen: boolean;
}

/** Owns modal visibility and the command-center suspension derived from it. */
export function useReviewDialogController({
  importPreviewOpen,
  linePickerOpen,
}: ReviewDialogControllerInput) {
  const [hierarchyOpen, setHierarchyOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [aiReviewDialogOpen, setAiReviewDialogOpen] = useState(false);
  const [conceptGroupingDialogOpen, setConceptGroupingDialogOpen] =
    useState(false);
  const [splitConceptDialogOpen, setSplitConceptDialogOpen] = useState(false);
  const [pullRequestDetailsOpen, setPullRequestDetailsOpen] = useState(false);
  const [moveMemberDialogOpen, setMoveMemberDialogOpen] = useState(false);

  return {
    aiReviewDialogOpen,
    commandBindingsSuspended:
      linePickerOpen ||
      importPreviewOpen ||
      hierarchyOpen ||
      resetDialogOpen ||
      aiReviewDialogOpen ||
      conceptGroupingDialogOpen ||
      splitConceptDialogOpen ||
      pullRequestDetailsOpen ||
      moveMemberDialogOpen,
    conceptGroupingDialogOpen,
    hierarchyOpen,
    moveMemberDialogOpen,
    pullRequestDetailsOpen,
    resetDialogOpen,
    setAiReviewDialogOpen,
    setConceptGroupingDialogOpen,
    setHierarchyOpen,
    setMoveMemberDialogOpen,
    setPullRequestDetailsOpen,
    setResetDialogOpen,
    setSplitConceptDialogOpen,
    splitConceptDialogOpen,
  };
}
