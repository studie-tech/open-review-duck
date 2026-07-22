import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combines conditional class names and resolves Tailwind conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Returns the singular or plural label for a numeric count. */
export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count} ${count === 1 ? singular : plural}`;
}
