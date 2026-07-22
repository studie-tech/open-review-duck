import { z } from "zod";

const PUBLIC_PLACEHOLDER_PATTERNS = [
  /replace[-_ ]?with/i,
  /replace[-_ ]?me/i,
  /change[-_ ]?me/i,
  /example/i,
  /local[-_ ]?image[-_ ]?build[-_ ]?only/i,
];

/** Validates an application secret and rejects documented public placeholders. */
export const applicationSecretSchema = z
  .string()
  .min(32)
  .refine(
    (value) =>
      !PUBLIC_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value)),
    "Generate a private random value instead of using a public placeholder",
  );
