import fs from "node:fs";

const tokenPath = new URL("./design-system.tokens.json", import.meta.url);
const docPath = new URL("./DESIGN_SYSTEM.md", import.meta.url);
const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
const doc = fs.readFileSync(docPath, "utf8");
const errors = [];

const requiredColors = [
  "ink",
  "inkMuted",
  "canvas",
  "surface",
  "surfaceMuted",
  "line",
  "accent",
  "accentStrong",
  "accentSoft",
  "violet",
  "success",
  "warning",
  "danger",
  "focus",
  "unread",
];
const hex = /^#[0-9A-Fa-f]{6}$/;
for (const name of requiredColors) {
  if (!hex.test(tokens.colors?.[name] ?? ""))
    errors.push(`colors.${name} must be a six-digit hex value`);
}

const luminance = (value) => {
  const rgb = value
    .slice(1)
    .match(/../g)
    .map((channel) => parseInt(channel, 16) / 255);
  const linear = rgb.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
for (const [foreground, background] of tokens.contrastPairs ?? []) {
  const ratio =
    (Math.max(luminance(tokens.colors[foreground]), luminance(tokens.colors[background])) + 0.05) /
    (Math.min(luminance(tokens.colors[foreground]), luminance(tokens.colors[background])) + 0.05);
  if (ratio < 4.5)
    errors.push(
      `contrast ${foreground}/${background} is ${ratio.toFixed(2)}:1; needs at least 4.5:1`,
    );
}

const spacingKeys = Object.keys(tokens.spacing ?? {}).map(Number);
if (spacingKeys.some((value, index) => index > 0 && value <= spacingKeys[index - 1]))
  errors.push("spacing keys must be strictly increasing");
if (
  tokens.breakpoints?.mobile !== "0px" ||
  !tokens.breakpoints?.tablet ||
  !tokens.breakpoints?.desktop
)
  errors.push("mobile, tablet, and desktop breakpoints are required");
if (!tokens.motion?.easing || !tokens.motion?.fast || !tokens.motion?.normal)
  errors.push("motion fast/normal/easing tokens are required");

for (const heading of [
  "## Product character",
  "## Tokens",
  "## Application information architecture",
  "## Screen contracts",
  "## Reusable component contracts",
  "## States and interaction rules",
  "## Responsive behavior",
  "## Accessibility and content safety",
  "## Verification checklist",
]) {
  if (!doc.includes(heading)) errors.push(`design document missing ${heading}`);
}
for (const term of [
  "Overview",
  "Chats",
  "People",
  "Media",
  "Search",
  "Admin",
  "Settings",
  "MessageBubble",
  "AttachmentCard",
  "loading",
  "empty",
  "unsupported",
  "unauthorized",
  "stale",
]) {
  if (!doc.includes(term)) errors.push(`design document missing required term ${term}`);
}
if (
  /(?:use|build|add|make|show|present).{0,40}(?:AI dashboard|robot mascot|prompt box|magic claim)/i.test(
    doc,
  )
)
  errors.push("design document contains prohibited AI-product framing");

if (errors.length) {
  console.error(
    `Design-system check failed (${errors.length} issue${errors.length === 1 ? "" : "s"})`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Design-system check passed: ${requiredColors.length} color roles, ${spacingKeys.length} spacing tokens, ${tokens.contrastPairs.length} contrast pairs, and required UX surfaces/states are present.`,
  );
}
