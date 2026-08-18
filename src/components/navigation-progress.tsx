"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useTransition,
} from "react";

type PendingNavigation = {
  pending: boolean;
  navigate: (href: string) => void;
};

const PendingNavigationContext = createContext<PendingNavigation>({
  pending: false,
  navigate: () => undefined,
});

/** Returns the shared programmatic navigation helper that tracks pending routing work. */
export function usePendingNavigation() {
  return useContext(PendingNavigationContext);
}

/** Tracks programmatic navigations and shows a top progress bar until they settle. */
export function NavigationProgressProvider({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback(
    (href: string) => {
      startTransition(() => router.push(href));
    },
    [router],
  );
  const value = useMemo(() => ({ pending, navigate }), [pending, navigate]);
  return (
    <PendingNavigationContext.Provider value={value}>
      {pending && (
        <div
          aria-hidden
          className="navigation-progress fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden"
        >
          <div className="navigation-progress-bar bg-lime h-full w-1/3 rounded-full" />
        </div>
      )}
      {children}
    </PendingNavigationContext.Provider>
  );
}
