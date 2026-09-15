import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ERROR_KINDS,
  errorDescriptors,
  errorKindForStatus,
  getErrorDescriptor,
} from "./error-registry";
import { renderErrorDocument } from "./error-document";

describe("browser error registry", () => {
  it("contains the complete initial catalog with one image and action per kind", () => {
    const descriptors = errorDescriptors();
    expect(descriptors).toHaveLength(10);
    expect(descriptors.map(({ kind }) => kind)).toEqual([...ERROR_KINDS]);
    expect(new Set(descriptors.map(({ image }) => image)).size).toBe(ERROR_KINDS.length);
    for (const descriptor of descriptors) {
      expect(descriptor.image).toMatch(/^\/brand\/errors\/.+\.png$/u);
      expect(descriptor.primaryAction.href).toMatch(/^\//u);
      const assetName = descriptor.image.replace("/brand/errors/", "");
      expect(
        existsSync(fileURLToPath(new URL(`./public/brand/errors/${assetName}`, import.meta.url))),
      ).toBe(true);
      expect(descriptor.title).not.toMatch(/token|archive id|stack|exception/iu);
    }
  });

  it("maps known statuses and unknown values to the designed fallback", () => {
    expect(errorKindForStatus(403)).toBe("access-denied");
    expect(errorKindForStatus(503)).toBe("service-unavailable");
    expect(errorKindForStatus(418)).toBe("unknown");
    expect(getErrorDescriptor("not-a-real-kind").kind).toBe("unknown");
    expect(getErrorDescriptor(undefined).kind).toBe("unknown");
  });

  it("keeps the access-denied copy safe and non-looping", () => {
    const denied = getErrorDescriptor("access-denied");
    expect(denied.title).toBe("You shall not pass!");
    expect(denied.description).toContain("Access denied");
    expect(denied.description).not.toMatch(/oidc|state|subject|archive/iu);
    expect(denied.primaryAction.href).toBe("/auth/logout");
  });

  it("renders a safe browser document for status-preserving route failures", () => {
    const document = renderErrorDocument("access-denied");
    expect(document).toContain("You shall not pass!");
    expect(document).toContain("/brand/errors/403-access-denied.png");
    expect(document).not.toContain("echohoard_oidc_state");
    expect(document).not.toContain("stack trace");
  });
});
