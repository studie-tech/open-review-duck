/**
 * Appends one value to a keyed bucket without rebuilding the bucket.
 *
 * Building an index with `map.set(key, [...(map.get(key) ?? []), value])` copies
 * the whole bucket on every insert, so a key that collects many values — a name
 * every file in a pull request contributes, a path shared by every unit in a
 * file, an identifier repeated throughout a module — costs time proportional to
 * the square of its bucket. Appending in place keeps insertion order identical
 * and the cost proportional to the number of values.
 */
export function appendToIndex<Key, Value>(
  index: Map<Key, Value[]>,
  key: Key,
  value: Value,
) {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}
