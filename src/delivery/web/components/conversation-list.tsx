"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConversationRead } from "../../../application/reads";

const PAGE_LIMIT = 50;

export interface ConversationPage {
  readonly items: readonly ConversationRead[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export type ConversationListState =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly page: ConversationPage }
  | { readonly kind: "error" };

export async function fetchConversationPage(
  fetcher: typeof fetch = fetch,
  cursor?: string,
  endpoint = "/api/conversations",
): Promise<ConversationPage | "unauthorized"> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) query.set("cursor", cursor);
  const response = await fetcher(`${endpoint}?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error("conversation list unavailable");
  const body: unknown = await response.json();
  return parseConversationPage(body);
}

export function parseConversationPage(value: unknown): ConversationPage {
  if (typeof value !== "object" || value === null) throw new Error("invalid conversation page");
  const page = value as { items?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean")
    throw new Error("invalid conversation page");
  const items = page.items.map(parseConversation);
  const nextCursor = page.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string")
    throw new Error("invalid conversation cursor");
  return {
    items,
    hasMore: page.hasMore,
    ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}),
  };
}

function parseConversation(value: unknown): ConversationRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid conversation");
  const conversation = value as Record<string, unknown>;
  if (
    typeof conversation.id !== "string" ||
    typeof conversation.title !== "string" ||
    typeof conversation.participantCount !== "number" ||
    !Number.isSafeInteger(conversation.participantCount) ||
    conversation.participantCount < 0
  )
    throw new Error("invalid conversation");
  const lastMessageAt = conversation.lastMessageAt;
  if (lastMessageAt !== undefined && typeof lastMessageAt !== "string")
    throw new Error("invalid conversation timestamp");
  return {
    id: conversation.id,
    title: conversation.title,
    participantCount: conversation.participantCount,
    ...(typeof lastMessageAt === "string" && lastMessageAt ? { lastMessageAt } : {}),
  };
}

export function ConversationList({ endpoint = "/api/conversations" }: { endpoint?: string }) {
  const [state, setState] = useState<ConversationListState>({ kind: "loading" });
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    try {
      const page = await fetchConversationPage(fetch, cursor, endpoint);
      if (page === "unauthorized") {
        setState({ kind: "unauthorized" });
        return;
      }
      setNextCursor(page.nextCursor);
      setState((current) => {
        if (!cursor) return page.items.length === 0 ? { kind: "empty" } : { kind: "ready", page };
        if (current.kind !== "ready")
          return page.items.length === 0 ? { kind: "empty" } : { kind: "ready", page };
        const merged = { ...page, items: [...current.page.items, ...page.items] };
        return { kind: "ready", page: merged };
      });
    } catch {
      setState({ kind: "error" });
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return <ListStatus title="Loading conversations" busy />;
  if (state.kind === "unauthorized")
    return (
      <ListStatus title="Sign in to browse your archive" action="Sign in" href="/auth/login" />
    );
  if (state.kind === "error")
    return (
      <ListStatus
        title="Conversations could not be loaded"
        action="Try again"
        onAction={() => {
          setState({ kind: "loading" });
          void load();
        }}
      />
    );
  if (state.kind === "empty")
    return (
      <ListStatus
        title="No conversations archived yet"
        detail="Completed imports will appear here."
      />
    );

  return (
    <section className="conversation-panel" aria-labelledby="conversation-list-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Chats</p>
          <h2 id="conversation-list-heading">Conversations</h2>
        </div>
        <span className="count-chip" aria-label={`${state.page.items.length} conversations shown`}>
          {state.page.items.length}
        </span>
      </div>
      <ul className="conversation-list" aria-label="Archived conversations">
        {state.page.items.map((conversation) => (
          <li key={conversation.id}>
            <a
              className="conversation-row"
              href={`/?conversation=${encodeURIComponent(conversation.id)}`}
            >
              <span className="avatar" aria-hidden="true">
                {initials(conversation.title)}
              </span>
              <span className="conversation-copy">
                <span className="conversation-title">
                  {conversation.title || "Untitled conversation"}
                </span>
                <span className="conversation-meta">
                  {conversation.participantCount}{" "}
                  {conversation.participantCount === 1 ? "participant" : "participants"}
                  {conversation.lastMessageAt ? ` · ${formatDate(conversation.lastMessageAt)}` : ""}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {state.page.hasMore && nextCursor ? (
        <button
          className="load-more"
          type="button"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(nextCursor);
          }}
        >
          {loadingMore ? "Loading more…" : "Load more conversations"}
        </button>
      ) : null}
    </section>
  );
}

function ListStatus({
  title,
  detail,
  busy,
  action,
  href,
  onAction,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  action?: string;
  href?: string;
  onAction?: () => void;
}) {
  return (
    <section className="list-status" aria-live="polite" aria-busy={busy || undefined}>
      <div className="status-icon" aria-hidden="true">
        {busy ? "…" : "◌"}
      </div>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {action && href ? (
        <a className="button" href={href}>
          {action}
        </a>
      ) : null}
      {action && onAction ? (
        <button className="button" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "?")
  ).toUpperCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
