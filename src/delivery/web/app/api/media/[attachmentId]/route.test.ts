import { describe, expect, it, vi } from "vitest";
import type { ArchivePrincipal } from "../../../../../../application/auth";
import type {
  MediaByteRange,
  MediaDeliveryAttachment,
} from "../../../../../../application/media-delivery";
import { createMediaRoute } from "./route-handler";

const principal: ArchivePrincipal = {
  userId: "user-1",
  archiveId: "archive-1",
  issuer: "https://issuer.example",
  subject: "owner",
};
const attachmentId = "11111111-1111-4111-8111-111111111111";
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);

function asset(
  metadata: Pick<MediaDeliveryAttachment, "mimeType" | "originalName" | "state"> &
    Partial<Pick<MediaDeliveryAttachment, "byteSize">>,
  opened: (range?: MediaByteRange) => ReadableStream<Uint8Array> = () => stream(bytes),
): MediaDeliveryAttachment {
  return { ...metadata, byteSize: metadata.byteSize ?? bytes.byteLength, open: opened };
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function routeFor(attachment: MediaDeliveryAttachment | null, archiveId = principal.archiveId) {
  const find = vi.fn(async (requestedArchive: string) =>
    requestedArchive === archiveId ? attachment : null,
  );
  const route = createMediaRoute({
    getRuntime: () => ({
      auth: { principalForRequest: () => principal },
      media: { find },
    }),
  });
  return { find, route };
}

describe("media delivery route", () => {
  it("streams allowlisted raster images inline with nosniff", async () => {
    const { route } = routeFor(
      asset({ state: "available", mimeType: "image/png", originalName: "photo.png" }),
    );
    const response = await route(new Request("http://localhost/api/media/id"), {
      params: { attachmentId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="photo.png"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["audio/mpeg", "voice.mp3"],
    ["video/mp4", "clip.mp4"],
  ])("supports a validated seek range for %s", async (mimeType, originalName) => {
    const opened = vi.fn((range?: MediaByteRange) =>
      stream(range ? bytes.slice(range.start, range.end + 1) : bytes),
    );
    const { route } = routeFor(asset({ state: "available", mimeType, originalName }, opened));
    const response = await route(
      new Request("http://localhost/api/media/id", { headers: { Range: "bytes=2-4" } }),
      { params: Promise.resolve({ attachmentId }) },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 2-4/6");
    expect(response.headers.get("content-length")).toBe("3");
    expect(opened).toHaveBeenCalledWith({ start: 2, end: 4 });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));
  });

  it("forces documents and unknown MIME to inert downloads", async () => {
    const { route } = routeFor(
      asset({ state: "available", mimeType: "application/pdf", originalName: "report.pdf" }),
    );
    const response = await route(new Request("http://localhost/api/media/id"), {
      params: { attachmentId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
  });

  it.each([
    ["text/html", "payload.jpg"],
    ["image/svg+xml", "payload.svg"],
    ["image/png", "payload.html"],
    ["application/x-msdownload", "payload.exe"],
  ])("keeps hostile or spoofed content inert (%s)", async (mimeType, originalName) => {
    const { route } = routeFor(asset({ state: "available", mimeType, originalName }));
    const response = await route(new Request("http://localhost/api/media/id"), {
      params: { attachmentId },
    });
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects invalid and non-media ranges without opening the file", async () => {
    const opened = vi.fn(() => stream(bytes));
    const { route } = routeFor(
      asset({ state: "available", mimeType: "audio/mpeg", originalName: "voice.mp3" }, opened),
    );
    const response = await route(
      new Request("http://localhost/api/media/id", { headers: { Range: "bytes=99-100" } }),
      { params: { attachmentId } },
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */6");
    expect(opened).not.toHaveBeenCalled();
  });

  it("returns an explicit response for missing media", async () => {
    const { route } = routeFor(
      asset({ state: "missing", mimeType: "image/png", originalName: "photo.png" }),
    );
    const response = await route(new Request("http://localhost/api/media/id"), {
      params: { attachmentId },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Media unavailable" });
  });

  it("uses the authenticated archive and denies another archive", async () => {
    const { find, route } = routeFor(
      asset({ state: "available", mimeType: "image/png", originalName: "photo.png" }),
      "archive-2",
    );
    const response = await route(new Request("http://localhost/api/media/id"), {
      params: { attachmentId },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Media not found" });
    expect(find).toHaveBeenCalledWith("archive-1", attachmentId);
  });
});
