export const ERROR_KINDS = [
  "bad-request",
  "authentication-required",
  "access-denied",
  "not-found",
  "request-timeout",
  "conflict",
  "rate-limited",
  "unexpected-failure",
  "service-unavailable",
  "unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ErrorDescriptor {
  readonly kind: ErrorKind;
  readonly status: number | null;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly imageAlt: string;
  readonly primaryAction: { readonly label: string; readonly href: string };
}

const descriptors: Record<ErrorKind, ErrorDescriptor> = {
  "bad-request": {
    kind: "bad-request",
    status: 400,
    code: "400",
    title: "That request needs another look",
    description: "EchoHoard could not understand the request. Check it and try again.",
    image: "/brand/errors/400-bad-request.png",
    imageAlt: "Saphira examines a damaged archive scroll.",
    primaryAction: { label: "Try again", href: "/" },
  },
  "authentication-required": {
    kind: "authentication-required",
    status: 401,
    code: "401",
    title: "Sign-in is required",
    description: "Sign in with an approved account to continue to EchoHoard.",
    image: "/brand/errors/401-authentication-required.png",
    imageAlt: "Saphira watches over a closed luminous archive portal.",
    primaryAction: { label: "Sign in", href: "/auth/login/start" },
  },
  "access-denied": {
    kind: "access-denied",
    status: 403,
    code: "403",
    title: "You shall not pass!",
    description: "Access denied. Sign out and try an approved account.",
    image: "/brand/errors/403-access-denied.png",
    imageAlt: "Saphira guards an archive threshold with one wing raised.",
    primaryAction: { label: "Sign out and try again", href: "/auth/logout" },
  },
  "not-found": {
    kind: "not-found",
    status: 404,
    code: "404",
    title: "That archive page is missing",
    description: "The page may have moved, or the address may be incomplete.",
    image: "/brand/errors/404-not-found.png",
    imageAlt: "Saphira searches empty archive shelves with a lantern and map.",
    primaryAction: { label: "Go to the archive", href: "/" },
  },
  "request-timeout": {
    kind: "request-timeout",
    status: 408,
    code: "408",
    title: "That took too long",
    description: "The request timed out before EchoHoard could finish it.",
    image: "/brand/errors/408-request-timeout.png",
    imageAlt: "Saphira protects a stalled hourglass and frozen archive lights.",
    primaryAction: { label: "Try again", href: "/" },
  },
  conflict: {
    kind: "conflict",
    status: 409,
    code: "409",
    title: "The archive changed underneath that request",
    description: "Reload the page and try again safely.",
    image: "/brand/errors/409-conflict.png",
    imageAlt: "Saphira separates two colliding archive records.",
    primaryAction: { label: "Reload archive", href: "/" },
  },
  "rate-limited": {
    kind: "rate-limited",
    status: 429,
    code: "429",
    title: "A short pause is needed",
    description: "EchoHoard is receiving too many requests right now. Wait a moment and try again.",
    image: "/brand/errors/429-rate-limited.png",
    imageAlt: "Saphira calms an overload of glowing message sparks.",
    primaryAction: { label: "Try again", href: "/" },
  },
  "unexpected-failure": {
    kind: "unexpected-failure",
    status: 500,
    code: "500",
    title: "EchoHoard hit an unexpected problem",
    description: "Nothing was changed by this page. Try again or return to the archive.",
    image: "/brand/errors/500-unexpected-failure.png",
    imageAlt: "Saphira repairs tangled luminous archive machinery.",
    primaryAction: { label: "Try again", href: "/" },
  },
  "service-unavailable": {
    kind: "service-unavailable",
    status: 503,
    code: "503",
    title: "EchoHoard is temporarily unavailable",
    description: "The archive is taking a short pause. Try again in a moment.",
    image: "/brand/errors/503-service-unavailable.png",
    imageAlt: "Saphira maintains a temporarily closed archive gate.",
    primaryAction: { label: "Try again", href: "/" },
  },
  unknown: {
    kind: "unknown",
    status: null,
    code: "",
    title: "Something unexpected happened",
    description: "We could not identify this problem safely. Try again or return to the archive.",
    image: "/brand/errors/unknown-fallback.png",
    imageAlt: "Saphira holds a flickering question-mark crystal.",
    primaryAction: { label: "Return to the archive", href: "/" },
  },
};

export function getErrorDescriptor(kind: string | null | undefined): ErrorDescriptor {
  return kind && kind in descriptors ? descriptors[kind as ErrorKind] : descriptors.unknown;
}

export function errorKindForStatus(status: number): ErrorKind {
  const entry = ERROR_KINDS.find((kind) => descriptors[kind].status === status);
  return entry ?? "unknown";
}

export function errorDescriptors(): readonly ErrorDescriptor[] {
  return ERROR_KINDS.map((kind) => descriptors[kind]);
}
