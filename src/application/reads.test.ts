import { describe, expect, it } from "vitest";
import {
  CursorCodec,
  CursorScopeError,
  DEFAULT_READ_LIMIT,
  InvalidCursorError,
  MAX_READ_LIMIT,
  validatePageRequest,
} from "./reads";

describe("bounded archive read contracts", () => {
  it.each([
    [0, "zero"],
    [MAX_READ_LIMIT + 1, "too large"],
    [1.5, "fractional"],
    [Number.NaN, "NaN"],
  ])("rejects %s page limit (%s)", (limit) => {
    expect(() => validatePageRequest({ archiveId: "archive-a", limit })).toThrow(
      "limit must be an integer",
    );
  });

  it("defaults to a bounded page and validates archive scope", () => {
    expect(validatePageRequest({ archiveId: "archive-a" })).toEqual({
      archiveId: "archive-a",
      limit: DEFAULT_READ_LIMIT,
      direction: "forward",
    });
    expect(() => validatePageRequest({ archiveId: " " })).toThrow("archiveId is required");
  });
});

describe("signed opaque cursors", () => {
  const clock = { value: 1_000_000 };
  const codec = new CursorCodec("test-only-secret", () => clock.value, 1000);
  const input = {
    archiveId: "archive-a",
    direction: "backward" as const,
    readKind: "messages" as const,
    resourceId: "conversation-10",
    sort: "sentAt,id" as const,
    values: ["2026-01-01T00:00:00.000Z", "message-10"],
    filterKey: "context-a",
  };

  it("round trips an opaque versioned cursor", () => {
    const cursor = codec.encode(input);
    expect(cursor).not.toContain("archive-a");
    expect(codec.decode(cursor, "archive-a", input)).toEqual({
      readKind: input.readKind,
      resourceId: input.resourceId,
      sort: input.sort,
      values: input.values,
      direction: input.direction,
      filterKey: input.filterKey,
    });
  });

  it.each(["", "not-a-cursor", "bad.bad.bad"])("rejects malformed cursor %j", (cursor) => {
    expect(() => codec.decode(cursor, "archive-a")).toThrow(InvalidCursorError);
  });

  it("rejects tampering and cross-archive reuse deterministically", () => {
    const cursor = codec.encode(input);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expect(() => codec.decode(tampered, "archive-a")).toThrow(InvalidCursorError);
    expect(() => codec.decode(cursor, "archive-b")).toThrow(CursorScopeError);
  });

  it("rejects expired cursors", () => {
    const cursor = codec.encode(input);
    clock.value += 1000;
    expect(() => codec.decode(cursor, "archive-a")).toThrow(InvalidCursorError);
    clock.value = 1_000_000;
  });

  it("rejects an oversized opaque cursor", () => {
    expect(() => codec.encode({ ...input, values: ["x".repeat(3000)] })).toThrow(
      InvalidCursorError,
    );
  });

  it("binds cursors to the complete filter key", () => {
    const cursor = codec.encode({ ...input, filterKey: '{"sourceAccountId":"account-a"}' });
    expect(() =>
      codec.decode(cursor, "archive-a", { ...input, filterKey: '{"sourceAccountId":"account-b"}' }),
    ).toThrow(InvalidCursorError);
  });

  it("rejects replay across read kind, direction, resource, and UI context", () => {
    const cursor = codec.encode(input);
    const cases = [
      { ...input, readKind: "people" as const },
      { ...input, direction: "forward" as const },
      { ...input, resourceId: "conversation-11" },
      { ...input, filterKey: "context-hidden" },
    ];
    for (const expected of cases)
      expect(() => codec.decode(cursor, "archive-a", expected)).toThrow(InvalidCursorError);
  });

  it("requires null and discriminator values in the tuple", () => {
    expect(() =>
      codec.encode({
        ...input,
        readKind: "people",
        resourceId: undefined,
        sort: "displayNameNull,displayName,id",
        values: ["", "person-1"],
      }),
    ).toThrow(InvalidCursorError);
    expect(() =>
      codec.encode({
        ...input,
        readKind: "timeline",
        resourceId: undefined,
        sort: "occurredAt,kind,id",
        values: ["2026-01-01T00:00:00.000Z", "message", "event-1"],
      }),
    ).not.toThrow();
  });
});
