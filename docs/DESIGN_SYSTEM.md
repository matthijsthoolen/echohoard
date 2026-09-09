# EchoHoard design system

Status: approved V1 direction. This is the visual and interaction contract for the public application; implementation stories should consume these tokens and rules rather than inventing a parallel UI language.

## Product character

EchoHoard is a calm, human archive. The visual reference is the familiarity and density of WhatsApp Web, the navigation clarity of Telegram, and the composable utility of Discord—without copying any product or presenting EchoHoard as an “AI tool”. People, relationships, and the evidence around a conversation are always more prominent than system metadata.

Design priorities, in order:

1. **People first:** names, avatars, presence-in-archive, relationship context, and conversation history lead every screen.
2. **Trust through clarity:** provenance, freshness, missing media, and unsupported types are visible but quiet; never hide uncertainty behind decoration.
3. **Fast at archive scale:** bounded lists, virtualized timelines, optimistic chrome only where it cannot misrepresent archive state, and no entire-chat loads.
4. **Private by default:** authenticated boundaries and safe-content states look intentional, not like error pages.
5. **Warm utility:** restrained color, generous rhythm, crisp typography, and small moments of motion. No gradients, robot mascots, prompt boxes, or mysterious promises in core navigation.

## Tokens

The machine-readable source of truth is [`design-system.tokens.json`](design-system.tokens.json). Use CSS variables or the framework token adapter to consume it; do not duplicate raw hex values in components.

### Color roles

- `canvas` is the app background; `surface` is a panel or card; `surfaceMuted` is a selected row, secondary panel, or disabled backdrop.
- `ink` is primary text; `inkMuted` is supporting text. Do not use muted text for essential labels.
- `accent` marks navigation, links, selected people, and primary actions. `accentStrong` is used for filled buttons and high-contrast selected states. `accentSoft` is the quiet selected background.
- `violet` is reserved for archive/system metadata and never replaces a person’s identity color.
- `success`, `warning`, `danger`, and `unread` communicate state and always pair with text or an icon—not color alone.
- Never use red for ordinary unread counts, and never use an AI-style purple gradient as a product identity.

### Type, rhythm, and shape

- Use the token font stack; tabular numbers are preferred for counts, dates, and statistics.
- Body text is `md`/normal. Conversation metadata is `sm`; timestamps may use `xs` but remain readable at 100% zoom.
- Use the spacing scale for all layout. The default page gutter is `6`, row padding is `3`–`4`, and a message bubble never has less than `2` internal horizontal spacing.
- Use `md` radii for controls and cards, `lg` for panels/drawers, and `pill` only for status/count chips. Avoid excessive rounded “AI dashboard” cards.
- Use `subtle` for resting surfaces, `raised` for a selected/floating panel, and `overlay` only for dialogs or media lightboxes.

## Application information architecture

The shell has a persistent primary rail, a contextual list pane, and a content pane on desktop. On mobile, the rail becomes a bottom navigation and the list/content panes become push navigation with a clear back affordance.

| Area | Purpose | Primary content |
|---|---|---|
| Overview | Re-orient and show archive trust | latest snapshot, unread-to-owner review queue, activity pulse, media coverage, health alerts, recent people/conversations |
| Chats | Browse the archive | conversation list, filters, pinned/frequent people, deep timeline |
| People | Put relationships first | people index, aliases/identities, shared conversations, first/last-seen context |
| Media | Find attachments safely | media grid/list, type/availability filters, conversation and date context |
| Search | Cross-archive retrieval | query, filters, result context, provenance trail |
| Admin | Operate ingestion and access | snapshots, jobs, failures, schema support, MCP status, audit metadata |
| Settings | Configure the owner experience | profile/session, archive preferences, display, notifications, security, about/version |

Admin and Settings are not hidden behind an avatar menu on desktop: they are secondary rail destinations with distinct icons and labels. They must be visually quieter than Chats and People, but discoverable.

## Screen contracts

### Overview

The overview answers “is my archive healthy, and what should I look at?” in one viewport. Start with a human greeting and a compact “last updated” line; follow with a two-column responsive layout of recent people/conversations and health/statistics. A health alert links directly to the relevant admin job or snapshot. Never turn statistics into decorative charts without a readable value and time range.

### Deep chat

The chat header shows avatar(s), conversation name, participant count, and a secondary action to open people/media/context. The timeline is the visual center: date separators, compact sender grouping, readable bubbles, reply/edit/reaction affordances, and explicit unsupported/missing-media placeholders. Provenance is available per message through a “view source” disclosure, not repeated on every bubble. Search results open at a stable message anchor and preserve a small before/after context window.

### People

People cards lead with avatar/initials, preferred observed name, stable-identity confidence, and conversation count. Alias history and identifiers are secondary disclosures. Similar names never appear merged unless the archive explicitly records a verified identity mapping. Empty state copy should invite searching conversations, not suggest importing contacts from another service.

### Media

Use a dense but breathable grid for visual media and a list for audio/documents. Each item shows a safe preview or inert placeholder, type, date, conversation, and availability. Missing and unsafe content are first-class states with explanation and a link back to the message; never show a broken browser image icon as the only signal.

### Admin

Admin is an operations workspace, not a developer console. Its first view is a snapshot/job timeline with status, duration, item counts, and sanitized failure detail. Separate panels cover source manifests, schema adapter support, media coverage, authentication sessions, and MCP allowlist/last-call metadata. Secrets, raw message content, filesystem paths, and arbitrary logs never appear.

### Settings

Settings use grouped sections with a sticky local navigation on desktop and accordions on mobile: Account and sessions, Archive display, Search behavior, Notifications, Security, and About. Destructive or irreversible controls are absent in V1; future hide/delete or retention controls must get their own audited design before appearing. Every setting states its scope and whether it changes only this browser or the archive.

## Reusable component contracts

- **AppShell:** rail + list + content regions; exposes landmarks and a skip link; maintains route context on resize.
- **PersonRow / PersonCard:** avatar, display name, optional alias, relationship metadata, unread/status indicator, keyboard target.
- **ConversationRow:** avatar stack, name, last archived message preview (escaped), timestamp, unread count, media indicator, pinned/frequent affordance.
- **MessageBubble:** sender/direction, time, safe text, reply/edit/reaction summaries, source disclosure; never injects source HTML or turns URLs into automatic navigation.
- **MessageContext:** date separator plus bounded before/after loading and a stable anchor highlight.
- **AttachmentCard:** safe preview/download policy, availability badge, metadata, conversation link, and explicit unsafe/missing state.
- **SearchBar + FilterChips:** bounded input, removable chips, keyboard navigation, URL-safe state, clear empty/error/no-result variants.
- **StatCard:** one metric, label, period/source, optional trend; no unlabeled dashboards.
- **HealthBanner / JobRow:** severity icon + text, last updated, actionable destination, sanitized detail.
- **DataTable:** for admin manifests/jobs only; sortable columns must preserve stable pagination and have a mobile card representation.
- **Drawer / Dialog:** focus trap, escape/back close, explicit title, destructive confirmation only when a future feature defines it.
- **Toast:** transient confirmation for non-critical UI actions; never the only place an ingestion failure or security denial is explained.

## States and interaction rules

Every data surface defines loading, empty, populated, partial/missing, unsupported, failed, unauthorized, and stale states. Skeletons preserve the eventual geometry; they do not animate indefinitely. Empty states explain what is absent and offer one useful next action. Failed states provide a sanitized reason and retry/review destination. Unauthorized states do not reveal whether a requested person, message, or archive exists.

Use hover for affordance, not essential information. Keyboard focus uses a 2px `focus` ring with at least 2px offset. Touch targets are at least 44px. Preserve scroll position and message anchors when loading adjacent pages. Reduce motion when `prefers-reduced-motion` is set; motion is limited to row selection, drawer transitions, and media preview changes.

## Responsive behavior

- **Mobile (<720px):** bottom navigation for Overview, Chats, People, Search; Admin and Settings live under a “More” destination. One pane at a time, with push navigation and a persistent back affordance. Composer-like controls are never used for archive search.
- **Tablet (720–1023px):** collapsible rail and list pane; content remains primary while browsing a chat.
- **Desktop (≥1024px):** persistent rail, resizable list pane with a sensible min/max width, content pane, and optional context drawer.
- **Wide (≥1440px):** allow a third context drawer for people/media/provenance; do not stretch message bubbles or reading measure indefinitely.

## Accessibility and content safety

Semantic landmarks, heading hierarchy, visible focus, keyboard parity, reduced motion, and contrast are release gates. The automated check must keep the color pairs in the token file at WCAG AA contrast for normal text (4.5:1). Human checks still cover screen-reader names, focus order, mobile reachability, and 200% zoom.

All message text, names, filenames, metadata, and URLs are hostile source data. Escape text, use an explicit safe MIME allowlist, force HTML/SVG to inert download/text, use `noopener` for any intentionally opened external link, and label model-facing results as untrusted evidence. A visual design decision never weakens those rules.

## Verification checklist

Run `node docs/check-design-system.mjs` from the repository root. It validates the token schema, color contrast, ordered spacing, required navigation/component/state vocabulary, and the absence of accidental “AI dashboard” language in the design contract. Browser/component stories should later add screenshots and keyboard checks for each screen contract; those are implementation-level tests, not a replacement for this document check.
