import { z } from "zod";

const text = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? value : value.join("")));
const output = z.object({
  output_type: z.string(),
  text: text.optional(),
  traceback: z.array(z.string()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
const cell = z.object({
  id: z.string().optional(),
  cell_type: z.enum(["markdown", "code", "raw"]),
  source: text,
  execution_count: z.number().nullable().optional(),
  outputs: z.array(output).optional(),
});
const notebook = z.object({ nbformat: z.literal(4), cells: z.array(cell) });

export type NotebookCell = z.infer<typeof cell>;
export type NotebookOutput = z.infer<typeof output>;

/** Validates untrusted notebook JSON before any cell or output is rendered. */
export function parseReviewNotebook(source: string) {
  try {
    const result = notebook.safeParse(JSON.parse(source));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Reads nbformat multiline strings, ignoring unsupported MIME value shapes. */
export function notebookOutputText(value: unknown): string | undefined {
  const result = text.safeParse(value);
  return result.success ? result.data : undefined;
}
