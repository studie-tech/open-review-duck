import type { KeyboardShortcut } from "~/lib/keyboard-shortcuts";

/**
 * Keyboard strokes shared by every review surface.
 *
 * The pull-request workspace and the repository reader must not collide with
 * the app shell's own global bindings (`q`, `?`, and the `g` navigation
 * sequences), so every stroke here avoids those prefixes.
 */
export const reviewShortcuts = {
  nextUnit: [{ key: "ArrowDown", mod: true }],
  previousUnit: [{ key: "ArrowUp", mod: true }],
  nextConcept: [{ key: "ArrowRight" }],
  previousConcept: [{ key: "ArrowLeft" }],
  scrollUp: [{ key: "ArrowUp" }],
  scrollDown: [{ key: "ArrowDown" }],
  revealContextAbove: [{ key: "ArrowUp", shift: true }],
  revealContextBelow: [{ key: "ArrowDown", shift: true }],
  togglePathPanel: [{ key: "b", mod: true }],
  toggleInsightsPanel: [{ key: "g", mod: true }],
  nextPending: [{ key: "n" }],
  nextReview: [{ key: "n", shift: true }],
  nextFinding: [{ key: "]" }],
  previousFinding: [{ key: "[" }],
  search: [{ key: "f" }],
  askAi: [{ key: "e" }],
  reviewPullRequest: [{ key: "a" }],
  comment: [{ key: "l" }],
  commentHere: [{ key: "Enter" }],
  undoSignOff: [{ key: "u", mod: true }],
  context: [{ key: "c" }],
  signOff: [{ key: "s" }],
  // Shift already carries the wider variant of an action here — concept
  // sign-off, deletions, reset, the next review.
  signOffConcept: [{ key: "s", shift: true }],
  signOffDeletions: [{ key: "d", shift: true }],
  undoReview: [{ key: "u" }],
  awaitResponse: [{ key: "w" }],
  refresh: [{ key: "r" }],
  reset: [{ key: "r", shift: true }],
  loadChanges: [{ key: "r" }],
  dashboard: [{ key: "g" }, { key: "r" }],
  aiSettings: [{ key: "g" }, { key: "a" }],
  postComment: [{ key: "Enter", mod: true }],
} satisfies Record<string, KeyboardShortcut>;

/**
 * Keyboard strokes for the monitored-repository cockpit.
 *
 * Bare digits pick cockpit sections; the rest mirror the vocabulary reviewers
 * already know from the pull-request workspace.
 */
export const cockpitShortcuts = {
  addRepository: [{ key: "a" }],
  search: [{ key: "f" }],
  previousMonitor: [{ key: "[" }],
  nextMonitor: [{ key: "]" }],
  overview: [{ key: "1" }],
  findings: [{ key: "2" }],
  rules: [{ key: "3" }],
  history: [{ key: "4" }],
  checkNow: [{ key: "c" }],
  runCodeAudit: [{ key: "r" }],
  runCompliance: [{ key: "r", shift: true }],
  openReader: [{ key: "o" }],
} satisfies Record<string, KeyboardShortcut>;

/**
 * Keyboard strokes for the repository reading path.
 *
 * Mirrors the pull-request workspace so muscle memory transfers between the
 * two review surfaces: arrows scroll or step, `s` commits a sign-off, `u`
 * takes it back, `n` resumes the queue, and `f` searches the path.
 */
export const readerShortcuts = {
  scrollDown: [{ key: "ArrowDown" }],
  scrollUp: [{ key: "ArrowUp" }],
  nextUnit: [{ key: "ArrowDown", mod: true }],
  previousUnit: [{ key: "ArrowUp", mod: true }],
  nextFile: [{ key: "ArrowRight" }],
  previousFile: [{ key: "ArrowLeft" }],
  nextPending: [{ key: "n" }],
  signOff: [{ key: "s" }],
  signOffHere: [{ key: "Enter" }],
  undoSignOff: [{ key: "u" }],
  togglePreviousSource: [{ key: "p" }],
  search: [{ key: "f" }],
  togglePathPanel: [{ key: "b", mod: true }],
} satisfies Record<string, KeyboardShortcut>;
