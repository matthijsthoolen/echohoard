import { describe, expect, it } from "vitest";
import { env } from "./env";

describe("environment configuration", () => {
  it("defaults to the web role", () => {
    expect(env.ECHOHOARD_ROLE).toBe("web");
    expect(env.NODE_ENV).toBe("test");
  });
});
