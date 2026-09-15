"use client";

import { useCallback, useEffect, useState } from "react";
import type { PersonRead } from "../../../application/reads";

const PAGE_LIMIT = 50;

export interface PeoplePage {
  readonly items: readonly PersonRead[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export type PeopleListState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly page: PeoplePage }
  | { readonly kind: "error" };

export async function fetchPeoplePage(
  fetcher: typeof fetch = fetch,
  search = "",
  cursor?: string,
  endpoint = "/api/people",
): Promise<PeoplePage | "unauthorized"> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  const response = await fetcher(`${endpoint}?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error("people list unavailable");
  return parsePeoplePage(await response.json());
}

export function parsePeoplePage(value: unknown): PeoplePage {
  if (typeof value !== "object" || value === null) throw new Error("invalid people page");
  const page = value as { items?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean")
    throw new Error("invalid people page");
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string")
    throw new Error("invalid people cursor");
  return {
    items: page.items.map(parsePerson),
    hasMore: page.hasMore,
    ...(typeof page.nextCursor === "string" && page.nextCursor
      ? { nextCursor: page.nextCursor }
      : {}),
  };
}

function parsePerson(value: unknown): PersonRead {
  if (typeof value !== "object" || value === null) throw new Error("invalid person");
  const person = value as Record<string, unknown>;
  if (
    typeof person.id !== "string" ||
    typeof person.displayName !== "string" ||
    typeof person.identityCount !== "number" ||
    !Number.isSafeInteger(person.identityCount) ||
    person.identityCount < 0
  )
    throw new Error("invalid person");
  return {
    id: person.id,
    displayName: person.displayName,
    identityCount: person.identityCount,
  };
}

export function PeopleList({ endpoint = "/api/people" }: { readonly endpoint?: string }) {
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [state, setState] = useState<PeopleListState>({ kind: "loading" });
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (query: string, cursor?: string) => {
      try {
        const page = await fetchPeoplePage(fetch, query, cursor, endpoint);
        if (page === "unauthorized") {
          setState({ kind: "error" });
          return;
        }
        setNextCursor(page.nextCursor);
        setState((current) => {
          if (!cursor || current.kind !== "ready")
            return page.items.length === 0 ? { kind: "empty" } : { kind: "ready", page };
          return {
            kind: "ready",
            page: { ...page, items: [...current.page.items, ...page.items] },
          };
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
    void load("");
  }, [load]);

  if (state.kind === "loading") return <ListStatus title="Loading people" busy />;
  if (state.kind === "error")
    return (
      <ListStatus
        title="People could not be loaded"
        action="Try again"
        onAction={() => void load(activeSearch)}
      />
    );
  if (state.kind === "empty")
    return (
      <section className="people-panel" aria-labelledby="people-heading">
        <PeopleSearch
          search={search}
          onSearch={setSearch}
          onSubmit={() => {
            setActiveSearch(search);
            setState({ kind: "loading" });
            void load(search);
          }}
        />
        <ListStatus title="No people found" detail="Observed names will appear after an import." />
      </section>
    );

  return (
    <section className="people-panel" aria-labelledby="people-heading">
      <PeopleSearch
        search={search}
        onSearch={setSearch}
        onSubmit={() => {
          setActiveSearch(search);
          setState({ kind: "loading" });
          void load(search);
        }}
      />
      <ul className="people-list" aria-label="People in the archive">
        {state.page.items.map((person) => (
          <li key={person.id}>
            <a
              className="person-row"
              href={`/?view=search&person=${encodeURIComponent(person.id)}`}
            >
              <span className="avatar" aria-hidden="true">
                {initials(person.displayName)}
              </span>
              <span className="conversation-copy">
                <strong className="conversation-title">
                  {person.displayName || "Unnamed person"}
                </strong>
                <span className="conversation-meta">
                  {person.identityCount} observed identities
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
            void load(activeSearch, nextCursor);
          }}
        >
          {loadingMore ? "Loading more…" : "Load more people"}
        </button>
      ) : null}
    </section>
  );
}

function PeopleSearch({
  search,
  onSearch,
  onSubmit,
}: {
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className="people-search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">People</p>
          <h2 id="people-heading">People in your archive</h2>
        </div>
      </div>
      <label htmlFor="people-search">Find a person</label>
      <input
        id="people-search"
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        maxLength={500}
      />
      <button className="button" type="submit">
        Search people
      </button>
    </form>
  );
}

function ListStatus({
  title,
  detail,
  busy,
  action,
  onAction,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly busy?: boolean;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <section className="list-status" aria-live="polite" aria-busy={busy || undefined}>
      <div className="status-icon" aria-hidden="true">
        {busy ? "…" : "◌"}
      </div>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {action && onAction ? (
        <button className="button" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "?")
  ).toUpperCase();
}
