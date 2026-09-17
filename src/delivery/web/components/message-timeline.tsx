"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MessageAttachmentRead,
  MessageRead,
  MessageReactionRead,
  MessageRevisionRead,
  MessageProvenanceRead,
} from "../../../application/reads";
import { RichMessage } from "./rich-message";

export interface GroupingSource {
  readonly id: string;
  readonly title: string;
  readonly accountLabel: string;
  readonly sourceNamespace: string;
  readonly sourceConversationKey: string;
  readonly unifiedConversationId: string;
}

export interface GroupingState {
  readonly targetConversationId: string;
  readonly version: number;
  readonly sources: readonly GroupingSource[];
  readonly currentSourceIds: readonly string[];
  readonly mergeSourceIds: readonly string[];
  readonly mergeAuditId?: string;
}

export function parseGroupingState(value: unknown): GroupingState {
  if (typeof value !== "object" || value === null) throw new Error("invalid grouping state");
  const state = value as Record<string, unknown>;
  if (
    typeof state.targetConversationId !== "string" ||
    typeof state.version !== "number" ||
    !Number.isSafeInteger(state.version) ||
    state.version < 0 ||
    !Array.isArray(state.sources) ||
    !Array.isArray(state.currentSourceIds) ||
    !Array.isArray(state.mergeSourceIds) ||
    !state.currentSourceIds.every((id) => typeof id === "string") ||
    !state.mergeSourceIds.every((id) => typeof id === "string")
  )
    throw new Error("invalid grouping state");
  const sources = state.sources.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("invalid grouping source");
    const source = value as Record<string, unknown>;
    if (
      typeof source.id !== "string" ||
      typeof source.title !== "string" ||
      typeof source.accountLabel !== "string" ||
      typeof source.sourceNamespace !== "string" ||
      typeof source.sourceConversationKey !== "string" ||
      typeof source.unifiedConversationId !== "string"
    )
      throw new Error("invalid grouping source");
    return source as unknown as GroupingSource;
  });
  if (state.mergeAuditId !== undefined && typeof state.mergeAuditId !== "string")
    throw new Error("invalid grouping audit");
  return {
    targetConversationId: state.targetConversationId,
    version: state.version,
    sources,
    currentSourceIds: state.currentSourceIds,
    mergeSourceIds: state.mergeSourceIds,
    ...(typeof state.mergeAuditId === "string" ? { mergeAuditId: state.mergeAuditId } : {}),
  };
}

export const TIMELINE_PAGE_LIMIT = 50;
export const TIMELINE_ROW_HEIGHT = 88;
export const TIMELINE_OVERSCAN = 8;
export const MAX_RETAINED_MESSAGES = 300;
const MAX_TEXT_LENGTH = 16_000;

export interface MessagePage {
  readonly items: readonly MessageRead[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface TimelineState {
  readonly messages: readonly MessageRead[];
  readonly olderCursor?: string;
  readonly newerCursor?: string;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export const emptyTimeline: TimelineState = {
  messages: [],
  hasOlder: false,
  hasNewer: false,
};

/** Merge a bounded page by stable message ID. Sorting after each merge means a
 * backward response can be rendered directly without changing message keys.
 * The client therefore never retains more than the requested window. */
export function mergeTimelinePage(
  state: TimelineState,
  page: MessagePage,
  direction: "forward" | "backward",
): TimelineState {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of page.items) byId.set(message.id, message);
  const ordered = [...byId.values()].sort(compareMessages);
  // Keep the active browsing window bounded even when a user walks through a
  // multi-million-message archive. Directional cursors remain available so a
  // discarded side can be fetched again without loading it into memory.
  const messages =
    ordered.length <= MAX_RETAINED_MESSAGES
      ? ordered
      : direction === "backward"
        ? ordered.slice(0, MAX_RETAINED_MESSAGES)
        : ordered.slice(-MAX_RETAINED_MESSAGES);
  if (direction === "backward") {
    return {
      ...state,
      messages,
      olderCursor: page.nextCursor,
      ...(page.nextCursor && state.messages.length === 0 ? { newerCursor: page.nextCursor } : {}),
      hasOlder: page.hasMore,
    };
  }
  return {
    ...state,
    messages,
    newerCursor: page.nextCursor,
    hasNewer: page.hasMore,
  };
}

export function compareMessages(
  left: Pick<MessageRead, "id" | "sentAt">,
  right: Pick<MessageRead, "id" | "sentAt">,
): number {
  const byTime = left.sentAt.localeCompare(right.sentAt);
  return byTime || left.id.localeCompare(right.id);
}

export function virtualRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = TIMELINE_ROW_HEIGHT,
  overscan = TIMELINE_OVERSCAN,
): { readonly start: number; readonly end: number } {
  if (itemCount <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const last = Math.min(
    itemCount,
    Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight) + overscan,
  );
  return { start: first, end: Math.max(first, last) };
}

export async function fetchMessagePage(
  fetcher: typeof fetch,
  conversationId: string,
  direction: "forward" | "backward",
  cursor?: string,
  endpoint = `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  mode: "ordinary" | "hidden" | "locked" = "ordinary",
): Promise<MessagePage | "unauthorized"> {
  const query = new URLSearchParams({ limit: String(TIMELINE_PAGE_LIMIT), direction });
  if (mode !== "ordinary") query.set("mode", mode);
  if (cursor) query.set("cursor", cursor);
  const response = await fetcher(`${endpoint}?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error("message timeline unavailable");
  return parseMessagePage(await response.json());
}

export function parseMessagePage(value: unknown): MessagePage {
  if (typeof value !== "object" || value === null) throw new Error("invalid message page");
  const page = value as { items?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean")
    throw new Error("invalid message page");
  const nextCursor = page.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string")
    throw new Error("invalid message cursor");
  return {
    items: page.items.map(parseMessage),
    hasMore: page.hasMore,
    ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}),
  };
}

function parseMessage(value: unknown): MessageRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid message");
  const message = value as Record<string, unknown>;
  if (
    typeof message.id !== "string" ||
    typeof message.conversationId !== "string" ||
    typeof message.sentAt !== "string" ||
    typeof message.attachmentCount !== "number" ||
    !Number.isSafeInteger(message.attachmentCount) ||
    message.attachmentCount < 0 ||
    !isDirection(message.direction) ||
    typeof message.messageType !== "string" ||
    !Array.isArray(message.revisions) ||
    !Array.isArray(message.reactions)
  )
    throw new Error("invalid message");
  if (
    message.text !== undefined &&
    (typeof message.text !== "string" || message.text.length > MAX_TEXT_LENGTH)
  )
    throw new Error("invalid message text");
  const replyTo = message.replyTo === undefined ? undefined : parseReply(message.replyTo);
  const attachments =
    message.attachments === undefined ? undefined : parseAttachments(message.attachments);
  const metadata = message.metadata === undefined ? undefined : parseMetadata(message.metadata);
  const provenance =
    message.provenance === undefined ? undefined : parseProvenance(message.provenance);
  const sourceDeleted = message.sourceDeleted === true;
  const contentUnavailable = message.contentUnavailable === true;
  if (
    (message.sourceDeleted !== undefined && typeof message.sourceDeleted !== "boolean") ||
    (message.contentUnavailable !== undefined && typeof message.contentUnavailable !== "boolean") ||
    (message.sourceDeletedAt !== undefined && typeof message.sourceDeletedAt !== "string") ||
    (message.sourceDeletionKind !== undefined &&
      message.sourceDeletionKind !== "revoke" &&
      message.sourceDeletionKind !== "delete")
  )
    throw new Error("invalid message deletion state");
  return {
    id: message.id,
    conversationId: message.conversationId,
    ...(typeof message.senderPersonId === "string"
      ? { senderPersonId: message.senderPersonId }
      : {}),
    sentAt: message.sentAt,
    ...(typeof message.text === "string" ? { text: message.text } : {}),
    attachmentCount: message.attachmentCount,
    ...(attachments ? { attachments } : {}),
    direction: message.direction,
    messageType: message.messageType,
    ...(metadata ? { metadata } : {}),
    ...(provenance ? { provenance } : {}),
    ...(sourceDeleted ? { sourceDeleted: true } : {}),
    ...(contentUnavailable ? { contentUnavailable: true } : {}),
    ...(typeof message.sourceDeletedAt === "string"
      ? { sourceDeletedAt: message.sourceDeletedAt }
      : {}),
    ...(message.sourceDeletionKind === "revoke" || message.sourceDeletionKind === "delete"
      ? { sourceDeletionKind: message.sourceDeletionKind }
      : {}),
    ...(replyTo ? { replyTo } : {}),
    revisions: message.revisions.map(parseRevision),
    reactions: message.reactions.map(parseReaction),
  };
}

function parseAttachments(value: unknown): readonly MessageAttachmentRead[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid message attachments");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("invalid message attachment");
    const attachment = item as Record<string, unknown>;
    if (
      typeof attachment.id !== "string" ||
      !attachment.id ||
      attachment.id.length > 128 ||
      /[\\/\u0000]/u.test(attachment.id) ||
      !isAttachmentState(attachment.availability)
    )
      throw new Error("invalid message attachment");
    const result: MessageAttachmentRead = {
      id: attachment.id,
      availability: attachment.availability,
      ...(boundedString(attachment.mimeType, 255)
        ? { mimeType: boundedString(attachment.mimeType, 255) }
        : {}),
      ...(boundedString(attachment.originalName, 255)
        ? { originalName: boundedString(attachment.originalName, 255) }
        : {}),
      ...(safeNonNegative(attachment.byteSize) !== undefined
        ? { byteSize: safeNonNegative(attachment.byteSize) }
        : {}),
      ...(safeNonNegative(attachment.width) !== undefined
        ? { width: safeNonNegative(attachment.width) }
        : {}),
      ...(safeNonNegative(attachment.height) !== undefined
        ? { height: safeNonNegative(attachment.height) }
        : {}),
      ...(safeNonNegative(attachment.durationMs) !== undefined
        ? { durationMs: safeNonNegative(attachment.durationMs) }
        : {}),
      ...(safeNonNegative(attachment.ordinal) !== undefined
        ? { ordinal: safeNonNegative(attachment.ordinal) }
        : {}),
      ...(boundedString(attachment.role, 128) ? { role: boundedString(attachment.role, 128) } : {}),
    };
    return result;
  });
}

function parseMetadata(
  value: unknown,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid message metadata");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) continue;
    if (typeof item === "string" && item.length <= 2_000) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function safeNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isAttachmentState(value: unknown): value is MessageAttachmentRead["availability"] {
  return (
    value === "available" || value === "missing" || value === "unsafe" || value === "unresolved"
  );
}

function parseReply(value: unknown): MessageRead["replyTo"] {
  if (typeof value !== "object" || value === null) throw new Error("invalid message reply");
  const reply = value as Record<string, unknown>;
  if (typeof reply.id !== "string") throw new Error("invalid message reply");
  if (
    reply.text !== undefined &&
    (typeof reply.text !== "string" || reply.text.length > MAX_TEXT_LENGTH)
  )
    throw new Error("invalid message reply");
  if (reply.sentAt !== undefined && typeof reply.sentAt !== "string")
    throw new Error("invalid message reply");
  return {
    id: reply.id,
    ...(typeof reply.sentAt === "string" ? { sentAt: reply.sentAt } : {}),
    ...(typeof reply.text === "string" ? { text: reply.text } : {}),
  };
}

function parseRevision(value: unknown): MessageRevisionRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid message revision");
  const revision = value as Record<string, unknown>;
  if (typeof revision.id !== "string" || typeof revision.firstSeenAt !== "string")
    throw new Error("invalid message revision");
  if (
    revision.text !== undefined &&
    (typeof revision.text !== "string" || revision.text.length > MAX_TEXT_LENGTH)
  )
    throw new Error("invalid message revision");
  return {
    id: revision.id,
    firstSeenAt: revision.firstSeenAt,
    ...(typeof revision.text === "string" ? { text: revision.text } : {}),
  };
}

function parseReaction(value: unknown): MessageReactionRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid message reaction");
  const reaction = value as Record<string, unknown>;
  if (
    typeof reaction.id !== "string" ||
    typeof reaction.personId !== "string" ||
    typeof reaction.emoji !== "string" ||
    reaction.emoji.length > 32
  )
    throw new Error("invalid message reaction");
  return { id: reaction.id, personId: reaction.personId, emoji: reaction.emoji };
}

function parseProvenance(value: unknown): MessageProvenanceRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid message provenance");
  const item = value as Record<string, unknown>;
  if (
    typeof item.sourceAccountId !== "string" ||
    typeof item.sourceConversationId !== "string" ||
    typeof item.sourceNamespace !== "string" ||
    typeof item.sourceConversationKey !== "string" ||
    !Array.isArray(item.importIds) ||
    !item.importIds.every((id) => typeof id === "string") ||
    typeof item.importCount !== "number" ||
    !Number.isSafeInteger(item.importCount) ||
    typeof item.importsTruncated !== "boolean"
  )
    throw new Error("invalid message provenance");
  return {
    sourceAccountId: item.sourceAccountId,
    sourceConversationId: item.sourceConversationId,
    sourceNamespace: item.sourceNamespace,
    sourceConversationKey: item.sourceConversationKey,
    importIds: item.importIds,
    importCount: item.importCount,
    importsTruncated: item.importsTruncated,
  };
}

function isDirection(value: unknown): value is MessageRead["direction"] {
  return value === "sent" || value === "received" || value === "unknown";
}

export function MessageTimeline({
  conversationId,
  endpoint,
  messageId,
  mode = "ordinary",
}: {
  readonly conversationId: string;
  readonly endpoint?: string;
  readonly messageId?: string;
  readonly mode?: "ordinary" | "hidden" | "locked";
}) {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<"loading" | "ready" | "unauthorized" | "error">("loading");
  const [loading, setLoading] = useState<"older" | "newer" | undefined>();
  const [groupingVersion, setGroupingVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);

  const load = useCallback(
    async (direction: "forward" | "backward", cursor?: string) => {
      setLoading(direction === "backward" ? "older" : "newer");
      try {
        const page = await fetchMessagePage(
          fetch,
          conversationId,
          direction,
          cursor,
          endpoint,
          mode,
        );
        if (page === "unauthorized") {
          setStatus("unauthorized");
          return;
        }
        setState((current) => mergeTimelinePage(current, page, direction));
        setStatus("ready");
      } catch {
        setStatus("error");
      } finally {
        setLoading(undefined);
      }
    },
    [conversationId, endpoint, mode],
  );

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    void load("backward");
  }, [load]);

  useEffect(() => {
    if (groupingVersion === 0) return;
    setState(emptyTimeline);
    setStatus("loading");
    void load("backward");
  }, [groupingVersion, load]);

  const range = virtualRange(state.messages.length, viewport.top, viewport.height);
  const visible = useMemo(
    () => state.messages.slice(range.start, range.end),
    [range.end, range.start, state.messages],
  );

  useEffect(() => {
    if (!messageId) return;
    const target = document.getElementById(`message-${messageId}`);
    target?.scrollIntoView({ block: "center" });
  }, [messageId, visible]);

  if (status === "loading") return <TimelineStatus title="Loading messages" busy />;
  if (status === "unauthorized")
    return <TimelineStatus title="Sign in to browse this conversation" />;
  if (status === "error")
    return (
      <TimelineStatus
        title="Messages could not be loaded"
        detail="Try again to fetch this conversation."
      />
    );

  const loadOlder = () => {
    if (state.hasOlder && state.olderCursor && !loading) {
      const node = viewportRef.current;
      const beforeHeight = node?.scrollHeight ?? 0;
      const beforeTop = node?.scrollTop ?? 0;
      void load("backward", state.olderCursor).then(() => {
        requestAnimationFrame(() => {
          if (node) node.scrollTop = beforeTop + node.scrollHeight - beforeHeight;
        });
      });
    }
  };
  const loadNewer = () => {
    if (state.newerCursor && !loading) void load("forward", state.newerCursor);
  };

  return (
    <section className="timeline-panel" aria-labelledby="timeline-heading">
      <div className="timeline-heading">
        <div>
          <p className="eyebrow">Conversation</p>
          <h2 id="timeline-heading">Preserved messages</h2>
        </div>
        <span className="count-chip" aria-label={`${state.messages.length} messages loaded`}>
          {state.messages.length}
        </span>
      </div>
      <GroupingControls
        conversationId={conversationId}
        onGroupingChanged={() => setGroupingVersion((version) => version + 1)}
      />
      <div className="timeline-actions">
        <button
          type="button"
          className="load-more"
          onClick={loadOlder}
          disabled={!state.hasOlder || Boolean(loading)}
        >
          {loading === "older"
            ? "Loading older…"
            : state.hasOlder
              ? "Load older messages"
              : "Beginning of conversation"}
        </button>
        {state.newerCursor ? (
          <button
            type="button"
            className="load-more"
            onClick={loadNewer}
            disabled={Boolean(loading)}
          >
            {loading === "newer" ? "Loading newer…" : "Load newer messages"}
          </button>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className="timeline-viewport"
        role="log"
        aria-label="Message history"
        tabIndex={0}
        onScroll={(event) => {
          const target = event.currentTarget;
          setViewport({ top: target.scrollTop, height: target.clientHeight });
        }}
      >
        <div style={{ height: range.start * TIMELINE_ROW_HEIGHT }} aria-hidden="true" />
        {visible.map((message) => (
          <MessageRow key={`${groupingVersion}-${message.id}`} message={message} mode={mode} />
        ))}
        <div
          style={{ height: Math.max(0, (state.messages.length - range.end) * TIMELINE_ROW_HEIGHT) }}
          aria-hidden="true"
        />
      </div>
    </section>
  );
}

function MessageRow({
  message,
  mode,
}: {
  readonly message: MessageRead;
  readonly mode: "ordinary" | "hidden" | "locked";
}) {
  return (
    <article
      id={`message-${message.id}`}
      className={`message-row message-${message.direction}`}
      data-message-id={message.id}
    >
      <div className="message-meta">
        <span>
          {message.direction === "sent"
            ? "You"
            : message.direction === "received"
              ? "Received"
              : "Unknown sender"}
        </span>
        <time dateTime={message.sentAt}>{formatTimestamp(message.sentAt)}</time>
      </div>
      {message.replyTo ? (
        <div className="message-reply">Reply to {message.replyTo.text || "preserved message"}</div>
      ) : null}
      <RichMessage message={message} privacyMode={mode} />
      {message.provenance ? (
        <details className="message-provenance">
          <summary>Show source provenance</summary>
          <dl>
            <dt>Receiving account</dt>
            <dd>{message.provenance.sourceAccountId}</dd>
            <dt>Source chat</dt>
            <dd>{message.provenance.sourceConversationId}</dd>
            <dt>Source</dt>
            <dd>{message.provenance.sourceNamespace}</dd>
            <dt>Source key</dt>
            <dd>{message.provenance.sourceConversationKey}</dd>
            <dt>Imports</dt>
            <dd>
              {message.provenance.importCount}
              {message.provenance.importsTruncated ? " (more available)" : ""}
            </dd>
            <dt>Import IDs</dt>
            <dd>{message.provenance.importIds.join(", ") || "none reported"}</dd>
          </dl>
        </details>
      ) : null}
      {message.revisions.length > 0 ? (
        <details className="message-edits">
          <summary>Edited ({message.revisions.length})</summary>
          <ul>
            {message.revisions.map((revision) => (
              <li key={revision.id}>{revision.text || "Content unavailable"}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {message.reactions.length > 0 ? (
        <ul className="message-reactions" aria-label="Reactions">
          {message.reactions.map((reaction) => (
            <li key={reaction.id}>{reaction.emoji}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function GroupingControls({
  conversationId,
  onGroupingChanged,
}: {
  readonly conversationId: string;
  readonly onGroupingChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [grouping, setGrouping] = useState<GroupingState>();
  const [status, setStatus] = useState<string>();
  const loadGrouping = useCallback(async () => {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/grouping`,
      { credentials: "same-origin", headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error("grouping state unavailable");
    const next = parseGroupingState(await response.json());
    setGrouping(next);
    setSelected([...next.mergeSourceIds]);
    return next;
  }, [conversationId]);
  useEffect(() => {
    if (!open) return;
    void loadGrouping().catch(() => setStatus("Source chats could not be loaded."));
  }, [loadGrouping, open]);
  const submit = async (action: "merge" | "unmerge") => {
    if (!grouping || (action === "merge" && selected.length === 0)) return;
    const explanation =
      action === "merge"
        ? "Merge these exact source chats for presentation? Source messages and imports remain retained."
        : "Reverse this presentation merge? Source messages and imports remain retained.";
    if (!window.confirm(explanation)) return;
    setStatus("Saving grouping…");
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/grouping`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          sourceConversationIds: selected,
          expectedVersion: grouping.version,
          ...(action === "unmerge" && grouping.mergeAuditId
            ? { auditId: grouping.mergeAuditId }
            : {}),
        }),
      },
    );
    if (response.status === 409) {
      setStatus(
        "This chat changed in another tab. The current grouping was kept; review it and retry.",
      );
      await loadGrouping().catch(() => undefined);
      return;
    }
    if (!response.ok) {
      setStatus("Grouping could not be saved. Your source data was not changed.");
      return;
    }
    await loadGrouping().catch(() => undefined);
    setStatus(
      action === "merge"
        ? "Chats merged for presentation; source data remains preserved."
        : "Chat unmerged; source data remains preserved.",
    );
    onGroupingChanged();
    setOpen(false);
  };
  const selectableSources =
    grouping?.sources.filter((source) => !grouping.currentSourceIds.includes(source.id)) ?? [];
  return (
    <section className="grouping-controls" aria-labelledby="grouping-heading">
      <button
        className="button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Manage source chats
      </button>
      {open ? (
        <div className="grouping-panel">
          <h3 id="grouping-heading">Combine source chats</h3>
          <p>
            Select exact source chats. This changes presentation only; archived messages and imports
            are retained.
          </p>
          <fieldset>
            <legend>Source-chat selection</legend>
            {selectableSources.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() =>
                    setSelected((ids) =>
                      ids.includes(item.id)
                        ? ids.filter((id) => id !== item.id)
                        : [...ids, item.id],
                    )
                  }
                />{" "}
                {item.accountLabel} · {item.title || "Untitled chat"}
              </label>
            ))}
            {grouping?.mergeSourceIds.length ? (
              <p>
                Currently merged source chats: {grouping.mergeSourceIds.length}. Unmerge reverses
                presentation only and retains all source data.
              </p>
            ) : null}
          </fieldset>
          <div className="grouping-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={!selected.length}
              onClick={() => void submit("merge")}
            >
              Confirm merge
            </button>
            <button
              className="button"
              type="button"
              disabled={!grouping?.mergeSourceIds.length || !grouping.mergeAuditId}
              onClick={() => void submit("unmerge")}
            >
              Unmerge selected
            </button>
          </div>
          {status ? <p role="status">{status}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function TimelineStatus({
  title,
  detail,
  busy,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly busy?: boolean;
}) {
  return (
    <section className="list-status" aria-live="polite" aria-busy={busy || undefined}>
      <div className="status-icon" aria-hidden="true">
        {busy ? "…" : "◌"}
      </div>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
    </section>
  );
}
