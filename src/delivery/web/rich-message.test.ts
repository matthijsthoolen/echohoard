import { describe, expect, it } from "vitest";
import type { MessageRead } from "../../application/reads";
import { mediaUrl, renderRichMessage } from "./components/rich-message";

const attachment = (overrides: Record<string, unknown> = {}) => ({
  id: "attachment/hostile?", // URL encoding is part of the contract test.
  availability: "available" as const,
  mimeType: "image/png",
  originalName: "photo.png",
  ...overrides,
});
const message = (messageType: string, overrides: Record<string, unknown> = {}): MessageRead => ({
  id: "message-1",
  conversationId: "conversation-1",
  sentAt: "2026-01-01T00:00:00.000Z",
  attachmentCount: 0,
  direction: "received",
  messageType,
  revisions: [],
  reactions: [],
  ...overrides,
});

function elements(value: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== "object" || value === null) return [];
  const node = value as { type?: unknown; props?: Record<string, unknown> };
  if (node.type === undefined || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

describe("rich message presentation", () => {
  it("renders every required rich type as a known safe relationship", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["image", { attachments: [attachment()] }],
      ["video", { attachments: [attachment({ mimeType: "video/mp4", originalName: "clip.mp4" })] }],
      [
        "audio",
        { attachments: [attachment({ mimeType: "audio/mpeg", originalName: "voice.mp3" })] },
      ],
      [
        "document",
        { attachments: [attachment({ mimeType: "application/pdf", originalName: "notes.pdf" })] },
      ],
      ["location", { metadata: { latitude: 52.09, longitude: 5.12 } }],
      ["contact", { metadata: { contactName: "Example", contactPhone: "+31" } }],
      [
        "sticker",
        { attachments: [attachment({ mimeType: "image/webp", originalName: "sticker.webp" })] },
      ],
      ["reaction", { metadata: { reactionEmoji: "👍", reactsToKey: "message-0" } }],
      ["system", { metadata: { sourceEvent: "subject_changed" } }],
      ["unsupported", {}],
    ];
    for (const [type, overrides] of cases) {
      const tree = elements(renderRichMessage(message(type, overrides)));
      expect(tree.length, type).toBeGreaterThan(0);
    }
  });

  it("uses only encoded attachment IDs for safe image/audio/video playback", () => {
    expect(mediaUrl("id with / path")).toBe("/api/media/id%20with%20%2F%20path");
    const tree = elements(
      renderRichMessage(message("image", { attachments: [attachment({ id: "opaque-id" })] })),
    );
    const image = tree.find((node) => node.type === "img");
    expect(image?.props.src).toBe("/api/media/opaque-id");
    expect(image?.props.src).not.toContain("photo.png");
    const audio = elements(
      renderRichMessage(
        message("audio", {
          attachments: [
            attachment({ id: "voice-id", mimeType: "audio/mpeg", originalName: "voice.mp3" }),
          ],
        }),
      ),
    );
    expect(audio.find((node) => node.type === "audio")?.props.controls).toBe(true);
    expect(audio.find((node) => node.type === "source")?.props.src).toBe("/api/media/voice-id");
    const video = elements(
      renderRichMessage(
        message("video", {
          attachments: [
            attachment({ id: "clip-id", mimeType: "video/mp4", originalName: "clip.mp4" }),
          ],
        }),
      ),
    );
    expect(video.find((node) => node.type === "video")?.props.controls).toBe(true);
  });

  it("forces document downloads and makes missing/unsafe media explicit", () => {
    const documentTree = elements(
      renderRichMessage(
        message("document", {
          attachments: [
            attachment({
              id: "document-id",
              mimeType: "application/pdf",
              originalName: "report.pdf",
            }),
          ],
        }),
      ),
    );
    const link = documentTree.find((node) => node.type === "a");
    expect(link?.props.href).toBe("/api/media/document-id");
    expect(link?.props.download).toBe(true);
    expect(
      elements(
        renderRichMessage(
          message("image", { attachments: [attachment({ availability: "missing" })] }),
        ),
      ).some((node) => node.props["data-media-state"] === "missing"),
    ).toBe(true);
    expect(
      elements(
        renderRichMessage(
          message("image", { attachments: [attachment({ originalName: "payload.svg" })] }),
        ),
      ).some((node) => node.props["data-media-state"] === "unsafe"),
    ).toBe(true);
  });

  it("keeps hostile metadata and HTML/SVG inert as text", () => {
    const tree = elements(
      renderRichMessage(
        message("contact", {
          metadata: {
            contactName: "<img src=x onerror=alert(1)>",
            contactPhone: "<svg onload=alert(1)>",
          },
        }),
      ),
    );
    expect(tree.some((node) => node.type === "img" || node.type === "svg")).toBe(false);
    expect(tree.find((node) => node.type === "strong")?.props.children).toBe("Preserved contact");
  });
});
