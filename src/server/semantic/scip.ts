import "server-only";

export interface ScipOccurrence {
  endCharacter: number;
  endLine: number;
  path: string;
  roles: number;
  startCharacter: number;
  startLine: number;
  symbol: string;
}

export interface ScipIndex {
  documentCount: number;
  occurrenceCount: number;
  occurrences: ScipOccurrence[];
}

const MAX_DOCUMENTS = 100_000;
const MAX_OCCURRENCES = 2_000_000;

class ProtobufReader {
  position = 0;

  /** Creates a bounded reader over one raw SCIP protobuf payload. */
  constructor(readonly bytes: Uint8Array) {}

  /** Reads one bounded unsigned protobuf varint. */
  varint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index++) {
      const byte = this.bytes[this.position++];
      if (byte === undefined) throw new Error("Truncated SCIP varint");
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value))
          throw new Error("SCIP integer overflow");
        return value;
      }
      multiplier *= 128;
    }
    throw new Error("Invalid SCIP varint");
  }

  /** Reads one length-delimited protobuf value without escaping its bounds. */
  value() {
    const length = this.varint();
    const end = this.position + length;
    if (length < 0 || end > this.bytes.length) {
      throw new Error("Truncated SCIP value");
    }
    const value = this.bytes.subarray(this.position, end);
    this.position = end;
    return value;
  }

  /** Skips a protobuf value while rejecting deprecated group encoding. */
  skip(wire: number) {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 1) {
      this.position += 8;
    } else if (wire === 2) {
      this.value();
      return;
    } else if (wire === 5) {
      this.position += 4;
    } else {
      throw new Error("Unsupported SCIP protobuf wire type");
    }
    if (this.position > this.bytes.length) {
      throw new Error("Truncated SCIP value");
    }
  }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes and validates an uncompressed SCIP protobuf index. */
export function parseScipIndex(bytes: Uint8Array): ScipIndex {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 * 1024) {
    throw new Error("SCIP artifact size is invalid");
  }
  const reader = new ProtobufReader(bytes);
  const occurrences: ScipOccurrence[] = [];
  let documentCount = 0;
  while (reader.position < bytes.length) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      documentCount += 1;
      if (documentCount > MAX_DOCUMENTS) {
        throw new Error("SCIP document limit exceeded");
      }
      parseDocument(reader.value(), occurrences);
      if (occurrences.length > MAX_OCCURRENCES) {
        throw new Error("SCIP occurrence limit exceeded");
      }
    } else {
      reader.skip(wire);
    }
  }
  if (documentCount === 0) throw new Error("SCIP index contains no documents");
  return {
    documentCount,
    occurrenceCount: occurrences.length,
    occurrences,
  };
}

/** Extracts path and symbol occurrences from one SCIP document. */
function parseDocument(bytes: Uint8Array, output: ScipOccurrence[]) {
  const reader = new ProtobufReader(bytes);
  let path = "";
  const encodedOccurrences: Uint8Array[] = [];
  while (reader.position < bytes.length) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      path = textDecoder.decode(reader.value());
    } else if (field === 2 && wire === 2) {
      encodedOccurrences.push(reader.value());
    } else {
      reader.skip(wire);
    }
  }
  if (
    !path ||
    path.length > 2_000 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("SCIP document path is unsafe");
  }
  for (const occurrence of encodedOccurrences) {
    const parsed = parseOccurrence(occurrence);
    if (parsed) output.push({ ...parsed, path });
  }
}

/** Extracts a usable source range and symbol from one SCIP occurrence. */
function parseOccurrence(bytes: Uint8Array) {
  const reader = new ProtobufReader(bytes);
  let symbol = "";
  let roles = 0;
  let range: number[] | undefined;
  while (reader.position < bytes.length) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const packed = new ProtobufReader(reader.value());
      range = [];
      while (packed.position < packed.bytes.length) range.push(packed.varint());
    } else if (field === 2 && wire === 2) {
      symbol = textDecoder.decode(reader.value());
    } else if (field === 3 && wire === 0) {
      roles = reader.varint();
    } else if ((field === 8 || field === 9) && wire === 2) {
      range = parseTypedRange(reader.value(), field === 8);
    } else {
      reader.skip(wire);
    }
  }
  if (!symbol) return undefined;
  if (symbol.length > 8_192) throw new Error("SCIP symbol is too long");
  if (!range || (range.length !== 3 && range.length !== 4)) {
    throw new Error("SCIP occurrence range is invalid");
  }
  const [startLine = -1, startCharacter = -1] = range;
  const endLine = range.length === 3 ? startLine : (range[2] ?? -1);
  const endCharacter = range.length === 3 ? (range[2] ?? -1) : (range[3] ?? -1);
  if (
    [startLine, startCharacter, endLine, endCharacter].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    endLine < startLine ||
    (endLine === startLine && endCharacter < startCharacter)
  ) {
    throw new Error("SCIP occurrence range is invalid");
  }
  return {
    endCharacter,
    endLine,
    roles,
    startCharacter,
    startLine,
    symbol,
  };
}

/** Decodes the newer typed single- or multi-line SCIP range. */
function parseTypedRange(bytes: Uint8Array, singleLine: boolean) {
  const reader = new ProtobufReader(bytes);
  const values = new Map<number, number>();
  while (reader.position < bytes.length) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0 && field >= 1 && field <= 4) {
      values.set(field, reader.varint());
    } else {
      reader.skip(wire);
    }
  }
  return singleLine
    ? [values.get(1) ?? 0, values.get(2) ?? 0, values.get(3) ?? 0]
    : [
        values.get(1) ?? 0,
        values.get(2) ?? 0,
        values.get(3) ?? 0,
        values.get(4) ?? 0,
      ];
}

/** Finds definitions and references by a literal symbol/name fragment. */
export function searchScipIndex(index: ScipIndex, query: string) {
  const normalized = query.toLowerCase();
  return index.occurrences
    .filter((occurrence) =>
      occurrence.symbol.toLowerCase().includes(normalized),
    )
    .slice(0, 200)
    .map((occurrence) => ({
      path: occurrence.path,
      line: occurrence.startLine + 1,
      character: occurrence.startCharacter + 1,
      endLine: occurrence.endLine + 1,
      endCharacter: occurrence.endCharacter + 1,
      symbol: occurrence.symbol,
      role: (occurrence.roles & 1) === 1 ? "definition" : "reference",
    }));
}
