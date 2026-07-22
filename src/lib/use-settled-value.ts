import { useEffect, useState } from "react";

/**
 * Returns a changed value only after it remains unchanged for the given delay.
 * The initial value is available immediately; transitions return undefined so
 * consumers cannot accidentally display data belonging to the previous value.
 */
export function useSettledValue<T>(value: T, delayMs: number): T | undefined {
  const [settledValue, setSettledValue] = useState(value);

  useEffect(() => {
    if (Object.is(value, settledValue)) return;
    const timeout = window.setTimeout(() => setSettledValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, settledValue, value]);

  return Object.is(value, settledValue) ? settledValue : undefined;
}
