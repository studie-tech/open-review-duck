import { describe, expect, it } from "vitest";
import {
  addMonitorSchema,
  addRuleSchema,
  archiveRuleSchema,
  monitorIdSchema,
  reportIdSchema,
  startRunSchema,
  updateRuleSchema,
} from "./repo-reviews";

const monitorId = "3f1d1f9c-6b0b-4a2f-8a1c-9d5e2b7c4a10";
const ruleId = "7a4c3e21-9d8b-4f60-a2c1-5e7b9d3f6a40";
const jobId = "8c2b6f41-2a55-4f0e-9f7d-1b3c5a6e7d80";
const repositoryId = "399ea3a7-2860-4eb9-9243-28627e87898d";

const rule = {
  monitorId,
  title: "Flag secret leaks",
  instruction: "Reject commits that introduce hardcoded credentials.",
  pathGlob: "**/*.{ts,tsx}",
  scope: "file" as const,
  severity: "high" as const,
};

describe("repository monitor validation", () => {
  it("accepts a monitor identifier", () => {
    expect(monitorIdSchema.parse({ monitorId })).toEqual({ monitorId });
  });

  it("rejects a malformed monitor identifier", () => {
    expect(
      monitorIdSchema.safeParse({ monitorId: "not-a-monitor" }).success,
    ).toBe(false);
  });

  it("accepts a bounded branch name and trims it", () => {
    expect(
      addMonitorSchema.parse({
        repositoryId,
        branch: "  main  ",
      }),
    ).toEqual({ repositoryId, branch: "main" });
  });

  it("rejects an oversized branch name", () => {
    expect(
      addMonitorSchema.safeParse({
        repositoryId,
        branch: "b".repeat(256),
      }).success,
    ).toBe(false);
  });
});

describe("repository report validation", () => {
  it("accepts a monitor and job pair", () => {
    expect(reportIdSchema.parse({ monitorId, jobId })).toEqual({
      monitorId,
      jobId,
    });
  });

  it("rejects a malformed job identifier", () => {
    expect(
      reportIdSchema.safeParse({ monitorId, jobId: "job-1" }).success,
    ).toBe(false);
  });
});

describe("repository rule validation", () => {
  it("accepts a rule at the existing field bounds", () => {
    expect(
      addRuleSchema.safeParse({
        ...rule,
        title: "t".repeat(200),
        instruction: "i".repeat(8_000),
        pathGlob: "p".repeat(500),
      }).success,
    ).toBe(true);
  });

  it("rejects oversized rule fields", () => {
    expect(
      addRuleSchema.safeParse({ ...rule, title: "t".repeat(201) }).success,
    ).toBe(false);
    expect(
      addRuleSchema.safeParse({ ...rule, instruction: "i".repeat(8_001) })
        .success,
    ).toBe(false);
    expect(
      addRuleSchema.safeParse({ ...rule, pathGlob: "p".repeat(501) }).success,
    ).toBe(false);
  });

  it("accepts a partial rule update", () => {
    expect(
      updateRuleSchema.safeParse({
        monitorId,
        ruleId,
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it("rejects an update that names no change", () => {
    expect(updateRuleSchema.safeParse({ monitorId, ruleId }).success).toBe(
      false,
    );
  });

  it("requires a rule identifier when archiving", () => {
    expect(archiveRuleSchema.parse({ monitorId, ruleId })).toEqual({
      monitorId,
      ruleId,
    });
    expect(archiveRuleSchema.safeParse({ monitorId }).success).toBe(false);
  });
});

describe("repository review start validation", () => {
  it("accepts a code or compliance run", () => {
    expect(
      startRunSchema.safeParse({ monitorId, purpose: "code" }).success,
    ).toBe(true);
    expect(
      startRunSchema.safeParse({ monitorId, purpose: "compliance" }).success,
    ).toBe(true);
  });

  it("rejects an unknown review purpose", () => {
    expect(
      startRunSchema.safeParse({ monitorId, purpose: "security" }).success,
    ).toBe(false);
  });
});
