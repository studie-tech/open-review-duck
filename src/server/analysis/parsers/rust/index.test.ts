import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { rustAdapter } from ".";

/** Analyzes an in-memory Rust fixture. */
function analyze(content: string, path = "src/lib.rs") {
  return rustAdapter.analyze({ path, content, changeType: "added" });
}

/** Returns a fixture unit by name with a useful assertion failure. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map((candidate) => candidate.name).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing unit ${name}`);
  return unit;
}

describe("Rust review analysis", () => {
  it("extracts documented types, fields, enum variants, aliases, and globals", () => {
    const units = analyze(`use std::sync::Arc;

/// A review job waiting to run.
#[derive(Debug, Clone)]
pub struct Job<'a, T> {
    /// Stable job identifier.
    pub id: u64,
    pub payload: &'a T,
}

pub struct Coordinates(pub i32, pub i32);
pub struct Marker;

pub enum Status<T> {
    Queued,
    Running { worker: Arc<T> },
    Failed(String),
}

pub union Word {
    integer: u64,
    bytes: [u8; 8],
}

pub type SharedJob<'a, T> = Arc<Job<'a, T>>;
pub const MAX_JOBS: usize = 64;
pub static ACTIVE: AtomicUsize = AtomicUsize::new(0);
`);
    const job = named(units, "Job");
    expect(job.source).toContain("A review job");
    expect(job.source).toContain("#[derive(Debug, Clone)]");
    expect(job.source).not.toContain("pub id");
    expect(named(units, "Job.id").source).toContain("Stable job identifier");
    expect(named(units, "Job.payload").kind).toBe("variable");
    expect(job.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "Job.id").stableKey,
        named(units, "Job.payload").stableKey,
      ]),
    );
    expect(named(units, "Coordinates.0").kind).toBe("variable");
    expect(named(units, "Coordinates.1").kind).toBe("variable");
    expect(named(units, "Marker").kind).toBe("class");
    expect(named(units, "Status::Running").kind).toBe("constant");
    expect(named(units, "Word.integer").kind).toBe("variable");
    expect(named(units, "SharedJob").kind).toBe("variable");
    expect(named(units, "MAX_JOBS").kind).toBe("constant");
    expect(named(units, "ACTIVE").kind).toBe("variable");
  });

  it("separates trait and generic impl shells from direct members", () => {
    const units = analyze(`pub trait Store<T> {
    type Error;
    const RETRIES: usize = 3;
    fn load(&self, key: &str) -> Result<T, Self::Error>;
    fn ready(&self) -> bool { true }
}

pub struct Memory<T> { value: Option<T> }

impl<T: Clone> Store<T> for Memory<T>
where T: Send + Sync
{
    type Error = LoadError;
    const RETRIES: usize = 5;

    /// Loads a cloned value.
    async unsafe fn load(&self, _key: &str) -> Result<T, Self::Error> {
        self.value.clone().ok_or(LoadError)
    }
}

impl<T> Memory<T> {
    pub const fn empty() -> Self { Self { value: None } }
}
`);
    const traitUnit = named(units, "Store");
    expect(traitUnit.source).not.toContain("fn load");
    expect(named(units, "Store::load").kind).toBe("method");
    expect(named(units, "Store::Error").kind).toBe("variable");
    expect(traitUnit.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "Store::load").stableKey,
        named(units, "Store::RETRIES").stableKey,
      ]),
    );

    const traitImpl = units.find(({ name }) =>
      name.startsWith("impl Store<T> for Memory<T>"),
    );
    expect(traitImpl).toBeDefined();
    expect(traitImpl?.stableKey).toContain(
      "impl<T: Clone> Store<T> for Memory<T>",
    );
    const load = units.find(
      ({ name }) => name.endsWith("::load") && name.startsWith("impl Store"),
    );
    expect(load?.source).toContain("Loads a cloned value");
    expect(load?.kind).toBe("method");
    expect(traitImpl?.dependencies).toContain(load?.stableKey);
    expect(named(units, "impl Memory<T>::empty").kind).toBe("method");
  });

  it("recognizes free async, const, unsafe, and extern functions", () => {
    const units = analyze(`pub async fn fetch() -> usize { 1 }
pub const fn capacity() -> usize { 8 }
pub unsafe fn unchecked(ptr: *const u8) -> u8 { *ptr }
pub extern "C" fn exported(value: i32) -> i32 { value }

unsafe extern "C" {
    pub fn imported(value: i32) -> i32;
    static FOREIGN_COUNT: i32;
}
`);
    expect(named(units, "fetch").kind).toBe("function");
    expect(named(units, "capacity").kind).toBe("function");
    expect(named(units, "unchecked").kind).toBe("function");
    expect(named(units, "exported").kind).toBe("function");
    const externBlock = named(units, "extern C");
    expect(named(units, "extern C::imported").kind).toBe("method");
    expect(externBlock.dependencies).toContain(
      named(units, "extern C::imported").stableKey,
    );
  });

  it("qualifies nested modules and connects same-file dependencies", () => {
    const units = analyze(`pub mod codec {
    pub const LIMIT: usize = 12;
    pub fn normalize(value: usize) -> usize { value.min(LIMIT) }

    pub mod wire {
        pub fn encode(value: usize) -> usize {
            super::normalize(value)
        }
    }
}
`);
    const codec = named(units, "codec");
    const normalize = named(units, "normalize");
    expect(normalize.stableKey).toContain("codec::normalize");
    expect(normalize.dependencies).toContain(named(units, "LIMIT").stableKey);
    expect(named(units, "encode").dependencies).toContain(normalize.stableKey);
    expect(codec.dependencies).toEqual(
      expect.arrayContaining([
        normalize.stableKey,
        named(units, "wire").stableKey,
      ]),
    );
  });

  it("extracts attributed tests and nested test modules without misclassifying helpers", () => {
    const units = analyze(`#[cfg(test)]
mod tests {
    fn fixture() -> usize { 1 }

    #[test]
    fn adds_values() { assert_eq!(fixture() + 1, 2); }

    #[tokio::test(flavor = "current_thread")]
    async fn loads_async() { fetch().await; }

    #[rstest]
    #[case(1, 2)]
    fn parameterized(#[case] input: usize, #[case] expected: usize) {
        assert_eq!(input + 1, expected);
    }

    #[quickcheck]
    fn round_trips(value: u8) -> bool { decode(encode(value)) == value }
}
`);
    expect(named(units, "fixture").kind).toBe("function");
    expect(named(units, "adds_values").kind).toBe("test");
    expect(named(units, "loads_async").kind).toBe("test");
    expect(named(units, "parameterized").kind).toBe("test");
    expect(named(units, "round_trips").kind).toBe("test");
    expect(named(units, "tests").dependencies).toContain(
      named(units, "adds_values").stableKey,
    );
  });

  it("extracts proptest and quickcheck macro cases", () => {
    const units = analyze(`proptest! {
    #[test]
    fn never_panics(value in any::<u8>()) { prop_assert!(value <= u8::MAX); }
}

quickcheck! {
    fn reversing_twice(values: Vec<u8>) -> bool {
        reverse(reverse(values.clone())) == values
    }
}
`);
    expect(named(units, "never_panics").kind).toBe("test");
    expect(named(units, "reversing_twice").kind).toBe("test");
  });

  it("keeps macro definitions and material invocations reviewable", () => {
    const units = analyze(`/// Defines a checked accessor.
macro_rules! checked_get {
    ($name:ident, $field:ident) => {
        fn $name(&self) -> usize { self.$field }
    };
}

inventory::submit! {
    Command { name: "review", run: execute }
}
`);
    const definition = named(units, "checked_get");
    expect(definition.kind).toBe("function");
    expect(definition.source).toContain("Defines a checked accessor");
    expect(named(units, "inventory::submit!").kind).toBe("module");
  });

  it("extracts named closures and makes their parent depend on them", () => {
    const units = analyze(`pub fn process(values: &[usize]) -> Vec<usize> {
    let threshold = 4;
    let keep = move |value: &&usize| **value >= threshold;
    values.iter().filter(keep).copied().collect()
}
`);
    const closure = named(units, "process::keep");
    expect(closure.kind).toBe("function");
    expect(closure.source).toContain("move |value");
    expect(named(units, "process").dependencies).toContain(closure.stableKey);
  });

  it("masks raw strings, lifetimes, chars, and nested comments without losing syntax", () => {
    const source = `/* outer { /* nested fn fake() {} */ still outer } */
const SAMPLE: &str = r###"fn hidden<'a>() { /* text */ }"###;
const BYTE: u8 = b'}';
fn borrow<'a>(value: &'a str) -> &'a str { value }
`;
    const units = analyze(source);
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "hidden")).toBe(false);
    expect(named(units, "SAMPLE").kind).toBe("constant");
    expect(named(units, "BYTE").kind).toBe("constant");
    expect(named(units, "borrow").kind).toBe("function");
  });

  it("recognizes crate attributes, imports, extern crates, and module declarations as context", () => {
    const context = `#![cfg_attr(not(test), no_std)]
//! Crate-level documentation.
use crate::{codec::encode, model::Item};
pub(crate) use alloc::vec::Vec;
extern crate alloc;
#[cfg(target_os = "linux")]
mod platform;
`;
    expect(
      rustAdapter.analyze({
        path: "src/lib.rs",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(rustAdapter.isContextOnly?.(context)).toBe(true);
    expect(
      rustAdapter.isContextOnly?.("use crate::x;\npub const VALUE: u8 = 1;"),
    ).toBe(false);
    expect(rustAdapter.extensions).toEqual([".rs"]);
  });
});
