import type {
  MediaDeliveryAttachment,
  MediaDeliveryPort,
} from "../../../../../../application/media-delivery";
import type { WebRuntime } from "../../../../runtime";

const SAFE_INLINE_MIME = new Set([
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
const ACTIVE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".svg",
  ".xml",
  ".js",
  ".mjs",
  ".cjs",
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".sh",
]);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav", ".weba"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".ogv", ".webm"]);

export interface MediaRouteDependencies {
  readonly getRuntime: () => MediaRouteRuntime | undefined;
}

export interface MediaRouteRuntime {
  readonly auth: Pick<WebRuntime["auth"], "principalForRequest">;
  readonly media?: MediaDeliveryPort;
}

type MediaRouteContext = {
  readonly params: { readonly attachmentId: string } | Promise<{ readonly attachmentId: string }>;
};

/** Deliver one archive-owned attachment.  The archive is selected from the
 * authenticated principal, and the attachment ID is the only media input. */
export function createMediaRoute({ getRuntime }: MediaRouteDependencies) {
  return async function GET(request: Request, context: MediaRouteContext): Promise<Response> {
    const runtime = getRuntime();
    if (!runtime) return unauthorized();
    const principal = await runtime.auth.principalForRequest(request);
    if (!principal) return unauthorized();

    const { attachmentId } = await context.params;
    if (!isAttachmentId(attachmentId)) return notFound();
    if (!runtime.media) return unavailable();
    const attachment = await runtime.media.find(principal.archiveId, attachmentId);
    if (!attachment) return notFound();
    if (attachment.state !== "available") return unavailable();
    if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 0) return unavailable();

    const policy = mediaPolicy(attachment);
    const rangeResult = parseRange(
      request.headers.get("range"),
      attachment.byteSize,
      policy.ranged,
    );
    if (rangeResult.kind === "invalid") return rangeNotSatisfiable(attachment.byteSize);
    const range = rangeResult.kind === "range" ? rangeResult.range : undefined;
    const body = attachment.open(range);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": policy.disposition,
      "Content-Length": String(range ? range.end - range.start + 1 : attachment.byteSize),
      "Content-Type": policy.contentType,
      "X-Content-Type-Options": "nosniff",
    });
    if (policy.ranged) headers.set("Accept-Ranges", "bytes");
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${attachment.byteSize}`);
      return new Response(body, { status: 206, headers });
    }
    return new Response(body, { status: 200, headers });
  };
}

function mediaPolicy(attachment: MediaDeliveryAttachment): {
  readonly contentType: string;
  readonly disposition: string;
  readonly ranged: boolean;
} {
  const mime = normalizeMime(attachment.mimeType);
  const name = attachment.originalName ?? "";
  const extension = extensionOf(name);
  const safeMime = mime !== null && SAFE_INLINE_MIME.has(mime) && !ACTIVE_EXTENSIONS.has(extension);
  const compatible = !extension || extensionCompatible(extension, mime);
  const inline = safeMime && compatible;
  const ranged = inline && (mime.startsWith("audio/") || mime.startsWith("video/"));
  return {
    contentType: inline ? mime : "application/octet-stream",
    disposition: contentDisposition(inline ? "inline" : "attachment", name),
    ranged,
  };
}

function extensionCompatible(extension: string, mime: string | null): boolean {
  if (!mime) return false;
  if (mime.startsWith("image/")) return IMAGE_EXTENSIONS.has(extension);
  if (mime.startsWith("audio/")) return AUDIO_EXTENSIONS.has(extension);
  if (mime.startsWith("video/")) return VIDEO_EXTENSIONS.has(extension);
  return false;
}

function normalizeMime(value: string | null | undefined): string | null {
  if (!value) return null;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : null;
}

function extensionOf(name: string): string {
  const clean = name.split(/[\\/]/u).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot <= 0 ? "" : clean.slice(dot).toLowerCase();
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const safeName = name
    .replace(/[\u0000-\u001f\u007f"\\/]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  const fallback = safeName || "download";
  return `${kind}; filename="${fallback}"`;
}

function parseRange(
  value: string | null,
  size: number,
  permitted: boolean,
):
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly range: { start: number; end: number } }
  | { readonly kind: "invalid" } {
  if (!value) return { kind: "none" };
  if (!permitted || size <= 0 || !/^bytes=[^,]+$/u.test(value)) return { kind: "invalid" };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { kind: "invalid" };
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "invalid" };
    const length = Math.min(suffix, size);
    return { kind: "range", range: { start: size - length, end: size - 1 } };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: "invalid" };
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
  return { kind: "range", range: { start, end: Math.min(end, size - 1) } };
}

function isAttachmentId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\u0000]/u.test(value)
  );
}

function unauthorized(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

function notFound(): Response {
  return Response.json({ error: "Media not found" }, { status: 404 });
}

function unavailable(): Response {
  return Response.json({ error: "Media unavailable" }, { status: 404 });
}

function rangeNotSatisfiable(size: number): Response {
  return Response.json(
    { error: "Requested media range is not satisfiable" },
    {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "X-Content-Type-Options": "nosniff" },
    },
  );
}
