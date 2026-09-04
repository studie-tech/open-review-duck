export interface SignOffQueueState {
  completed: number;
  ids: Set<string>;
  total: number;
}

export type ReviewFooterSaveState =
  | "active"
  | "background"
  | "finalizing"
  | "idle";

export type SignOffQueueAction =
  | { type: "enqueue"; unitId: string }
  | { type: "settle"; unitId: string }
  | { type: "synchronize"; unitIds: string[] };

/** Creates an idle sign-off queue progress state. */
export function createSignOffQueue(): SignOffQueueState {
  return { completed: 0, ids: new Set(), total: 0 };
}

/** Selects one mutually exclusive save presentation for the review footer. */
export function reviewFooterSaveState(input: {
  activeSavePending: boolean;
  pendingSaveCount: number;
  reviewComplete: boolean;
}): ReviewFooterSaveState {
  if (input.pendingSaveCount === 0) return "idle";
  if (input.reviewComplete) return "finalizing";
  return input.activeSavePending ? "active" : "background";
}

/** Tracks one expanding batch of optimistic sign-off writes. */
export function signOffQueueReducer(
  state: SignOffQueueState,
  action: SignOffQueueAction,
): SignOffQueueState {
  if (action.type === "synchronize") {
    const ids = new Set(action.unitIds);
    const added = [...ids].filter((unitId) => !state.ids.has(unitId)).length;
    const settled = [...state.ids].filter((unitId) => !ids.has(unitId)).length;
    if (added === 0 && settled === 0) return state;
    if (state.ids.size === 0 && ids.size > 0) {
      return { completed: 0, ids, total: ids.size };
    }
    return {
      completed: Math.min(state.completed + settled, state.total + added),
      ids,
      total: state.total + added,
    };
  }

  if (action.type === "enqueue") {
    if (state.ids.has(action.unitId)) return state;
    const ids = new Set(state.ids).add(action.unitId);
    return state.ids.size === 0
      ? { completed: 0, ids, total: 1 }
      : { ...state, ids, total: state.total + 1 };
  }

  if (!state.ids.has(action.unitId)) return state;
  const ids = new Set(state.ids);
  ids.delete(action.unitId);
  return {
    ...state,
    completed: Math.min(state.completed + 1, state.total),
    ids,
  };
}
