"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  MessageDirection,
  SearchMediaType,
  SearchResultRead,
} from "../../../application/reads";

export const SEARCH_PAGE_LIMIT = 50;
export const SEARCH_MEDIA_TYPES: readonly SearchMediaType[] = [
  "image",
  "video",
  "audio",
  "document",
  "other",
];
export const SEARCH_DIRECTIONS: readonly MessageDirection[] = ["sent", "received", "unknown"];

export interface SearchFilters {
  readonly query: string;
  readonly conversationId: string;
  readonly personId: string;
  readonly direction: MessageDirection | "";
  readonly from: string;
  readonly to: string;
  readonly mediaType: SearchMediaType | "";
}

export interface SearchPage {
  readonly items: readonly SearchResultRead[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly page: SearchPage }
  | { readonly kind: "error" };

export const emptySearchFilters: SearchFilters = {
  query: "",
  conversationId: "",
  personId: "",
  direction: "",
  from: "",
  to: "",
  mediaType: "",
};

export function filtersFromSearchParams(params: URLSearchParams): SearchFilters {
  const direction = params.get("direction") ?? "";
  const mediaType = params.get("media") ?? params.get("mediaType") ?? "";
  return {
    query: params.get("q") ?? params.get("query") ?? "",
    conversationId: params.get("conversation") ?? params.get("conversationId") ?? "",
    personId: params.get("person") ?? params.get("personId") ?? "",
    direction: SEARCH_DIRECTIONS.includes(direction as MessageDirection)
      ? (direction as MessageDirection)
      : "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    mediaType: SEARCH_MEDIA_TYPES.includes(mediaType as SearchMediaType)
      ? (mediaType as SearchMediaType)
      : "",
  };
}

export function searchParamsFromFilters(filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  setIfPresent(params, "q", filters.query);
  setIfPresent(params, "conversation", filters.conversationId);
  setIfPresent(params, "person", filters.personId);
  setIfPresent(params, "direction", filters.direction);
  setIfPresent(params, "from", filters.from);
  setIfPresent(params, "to", filters.to);
  setIfPresent(params, "media", filters.mediaType);
  return params;
}

export function buildSearchRequestUrl(
  filters: SearchFilters,
  cursor?: string,
  endpoint = "/api/search",
): string {
  const params = searchParamsFromFilters(filters);
  params.set("limit", String(SEARCH_PAGE_LIMIT));
  if (cursor) params.set("cursor", cursor);
  return `${endpoint}?${params.toString()}`;
}

export async function fetchSearchPage(
  fetcher: typeof fetch = fetch,
  filters: SearchFilters = emptySearchFilters,
  cursor?: string,
  endpoint = "/api/search",
): Promise<SearchPage | "unauthorized"> {
  const response = await fetcher(buildSearchRequestUrl(filters, cursor, endpoint), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error("search unavailable");
  return parseSearchPage(await response.json());
}

export function parseSearchPage(value: unknown): SearchPage {
  if (typeof value !== "object" || value === null) throw new Error("invalid search page");
  const page = value as { items?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean")
    throw new Error("invalid search page");
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string")
    throw new Error("invalid search cursor");
  return {
    items: page.items.map(parseSearchResult),
    hasMore: page.hasMore,
    ...(typeof page.nextCursor === "string" && page.nextCursor
      ? { nextCursor: page.nextCursor }
      : {}),
  };
}

function parseSearchResult(value: unknown): SearchResultRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid search result");
  const result = value as Record<string, unknown>;
  if (
    typeof result.id !== "string" ||
    !result.id ||
    (result.kind !== "message" && result.kind !== "person" && result.kind !== "conversation")
  )
    throw new Error("invalid search result");
  if (
    result.score !== undefined &&
    (typeof result.score !== "number" || !Number.isFinite(result.score))
  )
    throw new Error("invalid search score");
  if (result.conversationId !== undefined && typeof result.conversationId !== "string")
    throw new Error("invalid search conversation");
  if (result.sentAt !== undefined && typeof result.sentAt !== "string")
    throw new Error("invalid search timestamp");
  return {
    id: result.id,
    kind: result.kind,
    ...(typeof result.score === "number" ? { score: result.score } : {}),
    ...(typeof result.conversationId === "string" ? { conversationId: result.conversationId } : {}),
    ...(typeof result.sentAt === "string" ? { sentAt: result.sentAt } : {}),
  };
}

export function resultContextHref(result: SearchResultRead): string {
  const query = new URLSearchParams();
  if (result.conversationId) query.set("conversation", result.conversationId);
  query.set("message", result.id);
  return `/?${query.toString()}#message-${encodeURIComponent(result.id)}`;
}

export function SearchPanel({ endpoint = "/api/search" }: { readonly endpoint?: string }) {
  const initialFilters = useMemo(
    () =>
      typeof window === "undefined"
        ? emptySearchFilters
        : filtersFromSearchParams(new URLSearchParams(window.location.search)),
    [],
  );
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [activeFilters, setActiveFilters] = useState<SearchFilters | undefined>(
    hasFilters(initialFilters) ? initialFilters : undefined,
  );
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (nextFilters: SearchFilters, cursor?: string) => {
      try {
        const page = await fetchSearchPage(fetch, nextFilters, cursor, endpoint);
        if (page === "unauthorized") {
          setState({ kind: "unauthorized" });
          return;
        }
        setState((current) => {
          if (!cursor || current.kind !== "ready")
            return page.items.length === 0 ? { kind: "empty" } : { kind: "ready", page };
          const items = [...current.page.items, ...page.items];
          return { kind: "ready", page: { ...page, items } };
        });
      } catch {
        setState({ kind: "error" });
      } finally {
        setLoadingMore(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    if (activeFilters) void load(activeFilters);
  }, []); // Restore a bookmarked search once, without fetching on every keystroke.

  useEffect(() => {
    const onPopState = () => {
      const restored = filtersFromSearchParams(new URLSearchParams(window.location.search));
      setFilters(restored);
      setActiveFilters(hasFilters(restored) ? restored : undefined);
      setState({ kind: "idle" });
      if (hasFilters(restored)) void load(restored);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [load]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchParamsFromFilters(filters);
    const url = query.toString() ? `/?${query.toString()}` : "/";
    window.history.pushState({}, "", url);
    setActiveFilters(filters);
    setState({ kind: "loading" });
    void load(filters);
  };

  const update = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  return (
    <section className="search-panel" aria-labelledby="search-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Archive search</p>
          <h2 id="search-heading">Find a preserved message</h2>
        </div>
      </div>
      <form className="search-form" onSubmit={submit}>
        <label htmlFor="search-query">Words or phrase</label>
        <input
          id="search-query"
          name="q"
          value={filters.query}
          onChange={(event) => update("query", event.target.value)}
          maxLength={5000}
        />
        <div className="search-filter-grid">
          <label>
            Conversation ID
            <input
              name="conversation"
              value={filters.conversationId}
              onChange={(event) => update("conversationId", event.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            Person ID
            <input
              name="person"
              value={filters.personId}
              onChange={(event) => update("personId", event.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            Direction
            <select
              name="direction"
              value={filters.direction}
              onChange={(event) =>
                update("direction", event.target.value as SearchFilters["direction"])
              }
            >
              <option value="">Any direction</option>
              {SEARCH_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {direction}
                </option>
              ))}
            </select>
          </label>
          <label>
            Media
            <select
              name="media"
              value={filters.mediaType}
              onChange={(event) =>
                update("mediaType", event.target.value as SearchFilters["mediaType"])
              }
            >
              <option value="">Any media</option>
              {SEARCH_MEDIA_TYPES.map((media) => (
                <option key={media} value={media}>
                  {media}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              name="from"
              type="datetime-local"
              value={filters.from}
              onChange={(event) => update("from", event.target.value)}
            />
          </label>
          <label>
            To
            <input
              name="to"
              type="datetime-local"
              value={filters.to}
              onChange={(event) => update("to", event.target.value)}
            />
          </label>
        </div>
        <button className="button" type="submit">
          Search archive
        </button>
      </form>
      <div className="search-results" aria-live="polite">
        {state.kind === "loading" ? <p>Searching…</p> : null}
        {state.kind === "unauthorized" ? <p>Sign in to search your archive.</p> : null}
        {state.kind === "error" ? <p>Search is temporarily unavailable.</p> : null}
        {state.kind === "empty" ? <p>No matching messages.</p> : null}
        {state.kind === "ready" ? (
          <>
            <p className="search-result-summary">{state.page.items.length} results shown</p>
            <ol className="search-result-list">
              {state.page.items.map((result) => (
                <li key={result.id}>
                  <a href={resultContextHref(result)}>
                    {result.kind === "message" ? "Message" : result.kind} <code>{result.id}</code>
                    {result.sentAt ? ` · ${result.sentAt}` : ""}
                  </a>
                </li>
              ))}
            </ol>
            {state.page.hasMore && state.page.nextCursor ? (
              <button
                className="load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void load(activeFilters ?? filters, state.page.nextCursor);
                }}
              >
                {loadingMore ? "Loading more…" : "Load more results"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function setIfPresent(params: URLSearchParams, key: string, value: string): void {
  if (value) params.set(key, value);
}

function hasFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some(Boolean);
}
