"use client";

import { forwardRef, useCallback, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import {
  SideBySideUnitDiff,
  type SideBySideUnitDiffHandle,
  type SideBySideUnitDiffProps,
} from "./review-workspace-diff";

/**
 * Loads the commits that touched one file once a line range is selected.
 *
 * The query stays idle until the diff asks for it, so opening a file does
 * not spend a provider request.
 */
export const ReviewDiffWithLineHistory = forwardRef<
  SideBySideUnitDiffHandle,
  SideBySideUnitDiffProps & { pullRequestId: string; path: string }
>(function ReviewDiffWithLineHistory({ pullRequestId, path, ...props }, ref) {
  const [requested, setRequested] = useState(false);
  const history = api.review.fileLineHistory.useQuery(
    { pullRequestId, path },
    { enabled: requested, staleTime: 60_000 },
  );
  const onRequest = useCallback(() => setRequested(true), []);
  const lineHistory = useMemo(
    () => ({
      status: history.isError
        ? ("error" as const)
        : history.isFetching
          ? ("loading" as const)
          : history.data
            ? ("ready" as const)
            : ("idle" as const),
      commits: history.data?.commits ?? [],
      truncated: history.data?.truncated ?? false,
      unmapped: history.data?.unmapped ?? false,
      onRequest,
    }),
    [history.data, history.isError, history.isFetching, onRequest],
  );
  return <SideBySideUnitDiff ref={ref} {...props} lineHistory={lineHistory} />;
});
