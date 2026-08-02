import { setup } from "xstate";

/** Owns review lifecycle transitions; server and view state stay outside XState. */
export const reviewSessionMachine = setup({
  types: {
    events: {} as
      | { type: "SYNC_STARTED" }
      | { type: "SYNC_FINISHED" }
      | { type: "REVIEW_COMPLETED" }
      | { type: "REVIEW_REOPENED" },
  },
}).createMachine({
  id: "reviewSession",
  initial: "reviewing",
  states: {
    reviewing: {
      on: {
        SYNC_STARTED: "synchronizing",
        REVIEW_COMPLETED: "completed",
      },
    },
    synchronizing: {
      on: {
        SYNC_FINISHED: "reviewing",
        REVIEW_COMPLETED: "completed",
      },
    },
    completed: {
      on: {
        REVIEW_REOPENED: "reviewing",
        SYNC_STARTED: "synchronizing",
      },
    },
  },
});
