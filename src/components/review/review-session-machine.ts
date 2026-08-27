import { setup } from "xstate";

/** Owns review lifecycle transitions; server and view state stay outside XState. */
export const reviewSessionMachine = setup({
  types: {
    events: {} as
      | { type: "SYNC_STARTED" }
      | { type: "SYNC_FINISHED" }
      | { type: "REVIEW_COMPLETED" }
      | { type: "REVIEW_BROWSED" }
      | { type: "REVIEW_REOPENED" },
  },
}).createMachine({
  id: "reviewSession",
  initial: "reviewing",
  states: {
    reviewing: {
      on: {
        SYNC_STARTED: "synchronizing",
        REVIEW_COMPLETED: "completedOverlay",
      },
    },
    synchronizing: {
      on: {
        SYNC_FINISHED: "reviewing",
        REVIEW_COMPLETED: "completedOverlay",
      },
    },
    completedOverlay: {
      on: {
        REVIEW_BROWSED: "completedBrowsing",
        REVIEW_REOPENED: "reviewing",
        SYNC_STARTED: "synchronizing",
      },
    },
    completedBrowsing: {
      on: {
        REVIEW_REOPENED: "reviewing",
        SYNC_STARTED: "synchronizing",
      },
    },
  },
});
