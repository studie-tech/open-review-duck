import Script from "next/script";
import { describe, expect, it } from "vitest";
import { ThemePreferenceScript } from "./theme-preference-script";

describe("ThemePreferenceScript", () => {
  it("uses Next's client loader instead of rendering an executable script", () => {
    const script = ThemePreferenceScript({ nonce: "request-nonce" });

    expect(script.type).toBe(Script);
    expect(script.props).toMatchObject({
      id: "theme-preference",
      nonce: "request-nonce",
      strategy: "afterInteractive",
    });
    expect(script.props.children).toContain("reviewduck-theme");
  });
});
