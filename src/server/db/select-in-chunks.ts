/** Keeps one `inArray` under PostgreSQL's 65,535 bind-parameter ceiling. */
export const SELECT_IDS_CHUNK_SIZE = 10_000;

/** Selects rows for an identifier list in bounded, ordered query chunks. */
export async function selectByIdsInChunks<Id, Row>(
  ids: readonly Id[],
  select: (chunk: Id[]) => Promise<readonly Row[]>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < ids.length; offset += SELECT_IDS_CHUNK_SIZE) {
    rows.push(
      ...(await select(ids.slice(offset, offset + SELECT_IDS_CHUNK_SIZE))),
    );
  }
  return rows;
}
