/**
 * Positions a native modal dialog independently of user-agent margins.
 *
 * A `dialog` element is centred by the user agent through `margin: auto`, which
 * the stylesheet reset zeroes along with every other margin. A dialog that
 * relies on it lands in the corner instead. Every modal therefore claims the
 * viewport itself and places its own panel, so placement never depends on
 * whichever margin rule wins.
 *
 * Compose with the alignment the dialog wants, then give the panel inside it a
 * width: `cn(modalSurfaceClassName, "items-center justify-center")`.
 */
export const modalSurfaceClassName =
  "fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent open:flex";
