import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./engine";
import { withPreparedTreeSitterLanguages } from "./tree-sitter";

const go = `package model

import (
	"errors"
	"time"
)

const (
	StatusPending = "pending"
	StatusDone    = "done"
)

var ErrNotFound = errors.New("not found")

// Account holds the persisted shape of a customer account.
type Account struct {
	ID        string
	Email     string
	CreatedAt time.Time
}

// Store reads and writes accounts.
type Store interface {
	Get(id string) (*Account, error)
	Put(account *Account) error
}
`;

describe("raw", () => {
  it("dumps raw units", async () => {
    const out: string[] = ["--- analyzeFiles units (no prior adapter call) ---"];
    const result = await withPreparedTreeSitterLanguages(["go"], () =>
      analyzeFiles([{ path: "a/model.go", content: go, changeType: "added" }]),
    );
    for (const u of [...result.units].sort((l, r) => l.startLine - r.startLine)) {
      out.push(`${u.startLine}-${u.endLine} ${u.kind} ${u.name}`);
    }
    out.push("--- source ---");
    for (const [i, l] of go.split("\n").entries()) out.push(`${i + 1}| ${l}`);
    writeFileSync("/tmp/raw.txt", out.join("\n"));
    expect(out.length).toBeGreaterThan(0);
  });
});
