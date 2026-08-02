import { describe, expect, it } from "vitest";
import {
  formatLocalBootstrapLink,
  formatLocalSessionReady,
} from "./local-bootstrap-output.mjs";

describe("formatLocalBootstrapLink", () => {
  it("makes the complete owner URL visually prominent and copyable", () => {
    const url = "http://localhost:3000/api/local/bootstrap?token=example-token";
    const output = formatLocalBootstrapLink(url, { color: true });

    expect(output).toContain("ACTION REQUIRED: AUTHORIZE YOUR BROWSER");
    expect(output).toContain(`>>> ${url} <<<`);
    expect(output).toContain("\u001b[1;30;103m");
    expect(output).toContain("\u001b[1;4;96m");
  });

  it("omits terminal escapes from redirected output", () => {
    const output = formatLocalBootstrapLink("http://localhost:3000", {
      color: false,
    });
    expect(output).not.toContain("\u001b[");
    expect(output).toContain(">>> http://localhost:3000 <<<");
  });

  it("explains restarts without printing another owner capability", () => {
    const output = formatLocalSessionReady(3000);
    expect(output).toContain("already has an active owner session");
    expect(output).toContain("http://localhost:3000");
    expect(output).not.toContain("/api/local/bootstrap?token=");
  });
});
