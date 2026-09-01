/**
 * Presents stored units without their source ranges.
 *
 * The workspace payload is embedded in the review document, so the sources
 * stay out of it and the client downloads the ranges it is about to show
 * from the authorized source endpoint.
 */
export function unitsWithoutSource<Unit>(units: Unit[]) {
  return units.map((unit) => ({
    ...unit,
    source: "",
    previousSource: null as string | null,
  }));
}
