import React, { type ReactNode } from "react";
import type { MessageAttachmentRead, MessageRead } from "../../../application/reads";

/** The media endpoint accepts only this opaque handle; source paths and URLs
 * from imported metadata are intentionally not part of the component API. */
export function mediaUrl(attachmentId: string): string {
  return `/api/media/${encodeURIComponent(attachmentId)}`;
}

const INLINE_MIME = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/webm",
]);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav", ".weba"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".ogv", ".webm"]);
const ACTIVE_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".cjs",
  ".exe",
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".sh",
  ".svg",
  ".xml",
]);

type RichMetadata = Readonly<Record<string, unknown>>;

export function RichMessage({ message }: { readonly message: MessageRead }): ReactNode {
  return (
    <div className="rich-message" data-rich-type={message.messageType}>
      {renderRichMessage(message)}
    </div>
  );
}

/** Render source-neutral rich types with React text nodes only. React escapes
 * hostile text; no source HTML, SVG, data URLs, or metadata paths are parsed. */
export function renderRichMessage(message: MessageRead): ReactNode {
  const metadata = message.metadata;
  const attachments = message.attachments ?? [];
  switch (message.messageType.toLowerCase()) {
    case "text":
      return <p className="message-body">{message.text ?? "Message content unavailable"}</p>;
    case "image":
      return MediaAttachments({ attachments, kind: "image" });
    case "sticker":
      return MediaAttachments({ attachments, kind: "sticker" });
    case "audio":
    case "voice":
      return MediaAttachments({ attachments, kind: "audio" });
    case "video":
      return MediaAttachments({ attachments, kind: "video" });
    case "document":
      return MediaAttachments({ attachments, kind: "document" });
    case "location":
      return LocationMessage({ metadata });
    case "contact":
      return ContactMessage({ metadata });
    case "reaction":
      return ReactionMessage({ metadata });
    case "system":
      return SystemMessage({ metadata });
    default:
      return UnsupportedMessage({ type: message.messageType });
  }
}

function MediaAttachments({
  attachments,
  kind,
}: {
  readonly attachments: readonly MessageAttachmentRead[];
  readonly kind: "image" | "sticker" | "audio" | "video" | "document";
}) {
  if (attachments.length === 0)
    return MediaState({ state: "missing", detail: "Attachment reference is missing." });
  return (
    <div className="rich-media-list" aria-label={`${kind} attachments`}>
      {attachments.map((attachment) => (
        <React.Fragment key={attachment.id}>{MediaAttachment({ attachment, kind })}</React.Fragment>
      ))}
    </div>
  );
}

function MediaAttachment({
  attachment,
  kind,
}: {
  readonly attachment: MessageAttachmentRead;
  readonly kind: "image" | "sticker" | "audio" | "video" | "document";
}) {
  if (attachment.availability !== "available")
    return MediaState({ state: attachment.availability });
  if (kind === "document") return DocumentAttachment({ attachment });
  if (!safePreview(attachment, kind))
    return MediaState({
      state: "unsafe",
      detail: "Preview blocked because this content is not safe to play inline.",
    });

  const url = mediaUrl(attachment.id);
  if (kind === "image" || kind === "sticker") {
    return (
      <figure className="rich-image">
        <img
          src={url}
          alt={kind === "sticker" ? "Preserved sticker" : "Preserved image"}
          loading="lazy"
          decoding="async"
        />
        {attachment.width && attachment.height ? (
          <figcaption>
            {attachment.width} × {attachment.height}
          </figcaption>
        ) : null}
      </figure>
    );
  }
  if (kind === "audio") {
    return (
      <div className="rich-player">
        <span>Preserved audio</span>
        <audio controls preload="metadata" aria-label="Preserved audio">
          <source src={url} type={attachment.mimeType} />
        </audio>
      </div>
    );
  }
  return (
    <div className="rich-player">
      <span>Preserved video</span>
      <video controls preload="metadata" aria-label="Preserved video">
        <source src={url} type={attachment.mimeType} />
      </video>
    </div>
  );
}

function DocumentAttachment({ attachment }: { readonly attachment: MessageAttachmentRead }) {
  return (
    <div className="rich-document">
      <span aria-hidden="true">▱</span>
      <a
        href={mediaUrl(attachment.id)}
        download
        className="button"
        aria-label={`Download ${attachment.originalName || "document"}`}
      >
        Download {attachment.originalName || "document"}
      </a>
    </div>
  );
}

function safePreview(
  attachment: MessageAttachmentRead,
  kind: "image" | "sticker" | "audio" | "video",
): boolean {
  const mime = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !mime ||
    !INLINE_MIME.has(mime) ||
    ACTIVE_EXTENSIONS.has(extensionOf(attachment.originalName))
  )
    return false;
  const extension = extensionOf(attachment.originalName);
  if (!extension) return true;
  if (kind === "image" || kind === "sticker")
    return mime.startsWith("image/") && IMAGE_EXTENSIONS.has(extension);
  if (kind === "audio") return mime.startsWith("audio/") && AUDIO_EXTENSIONS.has(extension);
  return mime.startsWith("video/") && VIDEO_EXTENSIONS.has(extension);
}

function extensionOf(name: string | undefined): string {
  const clean = (name ?? "").split(/[\\/]/u).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot <= 0 ? "" : clean.slice(dot).toLowerCase();
}

function MediaState({
  state,
  detail,
}: {
  readonly state: MessageAttachmentRead["availability"];
  readonly detail?: string;
}) {
  const text =
    detail ??
    (state === "missing"
      ? "Media unavailable; the message is preserved."
      : state === "unsafe"
        ? "Media marked unsafe; inline playback is blocked."
        : "Media could not be resolved safely.");
  return (
    <div className="media-state" role="status" data-media-state={state}>
      <strong>{state === "missing" ? "Media unavailable" : "Media not playable inline"}</strong>
      <span>{text}</span>
    </div>
  );
}

function LocationMessage({ metadata }: { readonly metadata?: RichMetadata }) {
  const latitude = numberMetadata(metadata, "latitude");
  const longitude = numberMetadata(metadata, "longitude");
  if (
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return MediaState({ state: "unresolved", detail: "Location details unavailable." });
  return (
    <div className="rich-location">
      <strong>Preserved location</strong>
      <span>
        {latitude}, {longitude}
      </span>
    </div>
  );
}

function ContactMessage({ metadata }: { readonly metadata?: RichMetadata }) {
  return (
    <div className="rich-contact">
      <strong>Preserved contact</strong>
      <span>{textMetadata(metadata, "contactName") ?? "Name unavailable"}</span>
      {textMetadata(metadata, "contactPhone") ? (
        <span>{textMetadata(metadata, "contactPhone")}</span>
      ) : null}
    </div>
  );
}

function ReactionMessage({ metadata }: { readonly metadata?: RichMetadata }) {
  return (
    <div className="rich-reaction">
      <span aria-label="Reaction">
        {boundedText(textMetadata(metadata, "reactionEmoji")) ?? "Reaction unavailable"}
      </span>
      <span>Reaction to preserved message</span>
    </div>
  );
}

function SystemMessage({ metadata }: { readonly metadata?: RichMetadata }) {
  return (
    <p className="rich-system">
      System event: {boundedText(textMetadata(metadata, "sourceEvent")) ?? "unavailable"}
    </p>
  );
}

function UnsupportedMessage({ type }: { readonly type: string }) {
  return (
    <div className="media-state" role="status" data-media-state="unsupported">
      <strong>Unsupported message type</strong>
      <span>{boundedText(type) ?? "Unknown content"} is preserved but cannot execute.</span>
    </div>
  );
}

function textMetadata(metadata: RichMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length <= 2_000 ? value : undefined;
}

function numberMetadata(metadata: RichMetadata | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: string | undefined): string | undefined {
  return value && value.length <= 200 ? value : undefined;
}
