import { describe, expect, it } from "vitest";
import { reconcileAttachmentAvailability } from "./text-import.js";

describe("attachment availability transitions", () => {
  it("promotes missing and unresolved observations when bytes arrive", () => {
    expect(reconcileAttachmentAvailability(undefined, "missing")).toBe("missing");
    expect(reconcileAttachmentAvailability("missing", "available")).toBe("available");
    expect(reconcileAttachmentAvailability("unresolved", "available")).toBe("available");
  });

  it("never downgrades owned bytes when a later observation is absent", () => {
    expect(reconcileAttachmentAvailability("available", "missing")).toBe("available");
    expect(reconcileAttachmentAvailability("available", "unresolved")).toBe("available");
    expect(reconcileAttachmentAvailability("available", "unsafe")).toBe("available");
  });

  it("keeps unsafe observations explicit until a positive available observation", () => {
    expect(reconcileAttachmentAvailability("unsafe", "missing")).toBe("unsafe");
    expect(reconcileAttachmentAvailability("unsafe", "unresolved")).toBe("unsafe");
    expect(reconcileAttachmentAvailability("unsafe", "available")).toBe("available");
  });
});
