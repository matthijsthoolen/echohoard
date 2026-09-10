"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MessageRead,
  MessageReactionRead,
  MessageRevisionRead,
} from "../../../application/reads";

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
): Promise<MessagePage | "unauthorized"> {
  const query = new URLSearchParams({ limit: String(TIMELINE_PAGE_LIMIT), direction });
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
  return {
    id: message.id,
    conversationId: message.conversationId,
    ...(typeof message.senderPersonId === "string"
      ? { senderPersonId: message.senderPersonId }
      : {}),
    sentAt: message.sentAt,
    ...(typeof message.text === "string" ? { text: message.text } : {}),
    attachmentCount: message.attachmentCount,
    direction: message.direction,
    messageType: message.messageType,
    ...(replyTo ? { replyTo } : {}),
    revisions: message.revisions.map(parseRevision),
    reactions: message.reactions.map(parseReaction),
  };
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

function isDirection(value: unknown): value is MessageRead["direction"] {
  return value === "sent" || value === "received" || value === "unknown";
}

export function MessageTimeline({
  conversationId,
  endpoint,
  messageId,
}: {
  readonly conversationId: string;
  readonly endpoint?: string;
  readonly messageId?: string;
}) {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<"loading" | "ready" | "unauthorized" | "error">("loading");
  const [loading, setLoading] = useState<"older" | "newer" | undefined>();
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);

  const load = useCallback(
    async (direction: "forward" | "backward", cursor?: string) => {
      setLoading(direction === "backward" ? "older" : "newer");
      try {
        const page = await fetchMessagePage(fetch, conversationId, direction, cursor, endpoint);
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
    [conversationId, endpoint],
  );

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    void load("backward");
  }, [load]);

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
        onScroll={(event) => {
          const target = event.currentTarget;
          setViewport({ top: target.scrollTop, height: target.clientHeight });
        }}
      >
        <div style={{ height: range.start * TIMELINE_ROW_HEIGHT }} aria-hidden="true" />
        {visible.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        <div
          style={{ height: Math.max(0, (state.messages.length - range.end) * TIMELINE_ROW_HEIGHT) }}
          aria-hidden="true"
        />
      </div>
    </section>
  );
}

function MessageRow({ message }: { readonly message: MessageRead }) {
  const body = renderSafeBody(message);
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
      <p className="message-body">{body}</p>
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

function renderSafeBody(message: MessageRead): string {
  if (message.messageType === "unsupported")
    return "Unsupported message type (content preserved safely)";
  if (message.text !== undefined) return message.text;
  if (message.attachmentCount > 0)
    return "Attachment preserved; media preview is unavailable here.";
  return "Message content unavailable";
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
