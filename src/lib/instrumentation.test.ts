import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../instrumentation";

const { getWorld, start } = vi.hoisted(() => ({
  getWorld: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@workflow/world-postgres", () => ({}));
vi.mock("workflow/runtime", () => ({ getWorld }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("waits for the asynchronous world and its worker startup", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("DEPLOYMENT_MODE", "local");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  let finishStartup: (() => void) | undefined;
  start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishStartup = resolve;
      }),
  );
  getWorld.mockResolvedValue({ start });

  let registered = false;
  const registration = register().then(() => {
    registered = true;
  });
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  expect(registered).toBe(false);
  finishStartup?.();
  await registration;
  expect(registered).toBe(true);
});
