import { describe, expect, it, vi } from "vitest";
import { COMMENT_IMAGE_CSP_SOURCES } from "~/lib/content-security-policy";
import { deploymentProxy } from "./request-proxy.saas";

const captured = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: vi.fn((options: unknown) => {
    captured.options = options;
    return vi.fn();
  }),
}));
vi.mock("~/env", () => ({ env: { NEXT_PUBLIC_SENTRY_DSN: undefined } }));

describe("hosted attachment image policy", () => {
  it("allows HTTPS attachments while preserving strict script and connection restrictions", () => {
    expect(deploymentProxy).toBeDefined();
    expect(captured.options).toMatchObject({
      contentSecurityPolicy: {
        strict: true,
        directives: {
          "img-src": [...COMMENT_IMAGE_CSP_SOURCES],
          "script-src": ["'wasm-unsafe-eval'"],
          "connect-src": ["'self'", "https://*.ufs.sh"],
          "object-src": ["'none'"],
        },
      },
    });
  });
});
