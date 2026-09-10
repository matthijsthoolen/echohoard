"use client";

import { useEffect, useState } from "react";
import type { ArchiveHealthRead } from "../../../application/health-reads";
import type { ArchiveStatisticsRead } from "../../../application/statistics";

export type OverviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly health: ArchiveHealthRead;
      readonly statistics: ArchiveStatisticsRead;
    };

export async function fetchArchiveOverview(
  fetcher: typeof fetch = fetch,
  healthEndpoint = "/api/health",
  statisticsEndpoint = "/api/statistics",
): Promise<
  | { readonly health: ArchiveHealthRead; readonly statistics: ArchiveStatisticsRead }
  | "unauthorized"
> {
  const init: RequestInit = {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  const [healthResponse, statisticsResponse] = await Promise.all([
    fetcher(healthEndpoint, init),
    fetcher(statisticsEndpoint, init),
  ]);
  if (
    [healthResponse.status, statisticsResponse.status].some(
      (status) => status === 401 || status === 403,
    )
  )
    return "unauthorized";
  if (!healthResponse.ok || !statisticsResponse.ok) throw new Error("archive overview unavailable");
  return {
    health: parseHealth(await healthResponse.json()),
    statistics: parseStatistics(await statisticsResponse.json()),
  };
}

export function parseHealth(value: unknown): ArchiveHealthRead {
  if (!isRecord(value) || !isHealthState(value.state) || !isFreshness(value.freshness))
    throw new Error("invalid archive health");
  if (!isRecord(value.counts) || !isRecord(value.media) || !Array.isArray(value.jobs))
    throw new Error("invalid archive health");
  const counts = {
    messages: count(value.counts.messages),
    conversations: count(value.counts.conversations),
    people: count(value.counts.people),
    mediaReferenced: count(value.counts.mediaReferenced),
    mediaAvailable: count(value.counts.mediaAvailable),
    unsupported: count(value.counts.unsupported),
  };
  return {
    archiveId: string(value.archiveId),
    state: value.state,
    freshness: value.freshness,
    snapshots: isRecord(value.snapshots) ? parseSnapshots(value.snapshots) : {},
    latestMessageAt: optionalString(value.latestMessageAt),
    currentJob: isRecord(value.currentJob) ? parseJob(value.currentJob) : undefined,
    lastJob: isRecord(value.lastJob) ? parseJob(value.lastJob) : undefined,
    jobs: Array.isArray(value.jobs) ? value.jobs.filter(isRecord).map(parseJob) : [],
    counts,
    media: {
      referenced: count(value.media.referenced),
      available: count(value.media.available),
      missing: count(value.media.missing),
      unsafe: count(value.media.unsafe),
      unresolved: count(value.media.unresolved),
    },
    unsupportedTypes: Array.isArray(value.unsupportedTypes)
      ? value.unsupportedTypes
          .filter(isRecord)
          .map((item) => ({ type: string(item.type), count: count(item.count) }))
      : [],
    failures: Array.isArray(value.failures)
      ? value.failures.filter(isRecord).map((item) => ({
          code: isDiagnosticCode(item.code) ? item.code : "IMPORT_FAILURE",
          message: "Import requires attention.",
          retryable: false,
        }))
      : [],
  };
}

export function parseStatistics(value: unknown): ArchiveStatisticsRead {
  if (!isRecord(value) || !isRecord(value.totals) || !isRecord(value.direction))
    throw new Error("invalid archive statistics");
  return {
    archiveId: string(value.archiveId),
    range:
      isRecord(value.range) && isBucket(value.range.bucket)
        ? { bucket: value.range.bucket }
        : { bucket: "day" },
    totals: {
      messages: count(value.totals.messages),
      conversations: count(value.totals.conversations),
      people: count(value.totals.people),
      media: count(value.totals.media),
    },
    mediaByTypeAndState: Array.isArray(value.mediaByTypeAndState)
      ? value.mediaByTypeAndState.filter(isRecord).map((item) => ({
          type: string(item.type) as ArchiveStatisticsRead["mediaByTypeAndState"][number]["type"],
          availability: string(
            item.availability,
          ) as ArchiveStatisticsRead["mediaByTypeAndState"][number]["availability"],
          count: count(item.count),
        }))
      : [],
    direction: {
      sent: count(value.direction.sent),
      received: count(value.direction.received),
      unknown: count(value.direction.unknown),
    },
    activity: Array.isArray(value.activity)
      ? value.activity
          .filter(isRecord)
          .map((item) => ({ bucketStart: string(item.bucketStart), count: count(item.count) }))
      : [],
    mostActiveConversations: Array.isArray(value.mostActiveConversations)
      ? value.mostActiveConversations.filter(isRecord).map((item) => ({
          conversationId: string(item.conversationId),
          title: optionalString(item.title),
          messageCount: count(item.messageCount),
          lastMessageAt: optionalString(item.lastMessageAt),
        }))
      : [],
  };
}

export function overviewStateLabel(state: ArchiveHealthRead["state"]): string {
  return {
    healthy: "Healthy",
    warning: "Needs attention",
    failed: "Import failed",
    empty: "No messages yet",
    "in-progress": "Import in progress",
    stale: "Archive is stale",
    unsupported: "Unsupported data found",
  }[state];
}

export function ArchiveOverview({ fetcher = fetch }: { readonly fetcher?: typeof fetch }) {
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchArchiveOverview(fetcher).then(
      (result) => {
        if (!active) return;
        setState(
          result === "unauthorized" ? { kind: "unauthorized" } : { kind: "ready", ...result },
        );
      },
      () => {
        if (active) setState({ kind: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [fetcher, reload]);

  if (state.kind === "loading") return <OverviewStatus title="Loading archive overview" busy />;
  if (state.kind === "unauthorized")
    return (
      <OverviewStatus
        title="Sign in to see your archive"
        detail="Your archive stays private."
        action="Sign in"
        href="/auth/login"
      />
    );
  if (state.kind === "error")
    return (
      <OverviewStatus
        title="Overview could not be loaded"
        detail="Try again in a moment or check the archive service."
        action="Try again"
        onAction={() => {
          setState({ kind: "loading" });
          setReload((value) => value + 1);
        }}
      />
    );

  const { health, statistics } = state;
  return (
    <section className="overview-panel" aria-labelledby="overview-heading">
      <header className="overview-header">
        <div>
          <p className="eyebrow">Archive overview</p>
          <h1 id="overview-heading">Your preserved conversations</h1>
          <p className="overview-intro">A clear, private view of what has been safely kept.</p>
        </div>
        <span className={`health-badge health-${health.state}`} role="status">
          <span aria-hidden="true">●</span> {overviewStateLabel(health.state)}
        </span>
      </header>
      <div className="health-grid">
        <HealthCard
          label="Messages"
          value={statistics.totals.messages}
          detail={`${statistics.totals.conversations} conversations`}
        />
        <HealthCard label="People" value={statistics.totals.people} detail="Across your archive" />
        <HealthCard label="Media" value={statistics.totals.media} detail={mediaDetail(health)} />
        <HealthCard
          label="Latest activity"
          value={formatDate(health.latestMessageAt)}
          detail={freshnessDetail(health)}
        />
      </div>
      <div className="overview-sections">
        <section className="overview-card" aria-labelledby="health-details-heading">
          <h2 id="health-details-heading">Archive health</h2>
          <dl className="health-details">
            <div>
              <dt>Freshness</dt>
              <dd>{health.freshness === "fresh" ? "Up to date" : "Needs a recent import"}</dd>
            </div>
            <div>
              <dt>Media coverage</dt>
              <dd>{mediaDetail(health)}</dd>
            </div>
            <div>
              <dt>Unsupported types</dt>
              <dd>{health.counts.unsupported.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Latest snapshot</dt>
              <dd>
                {health.snapshots.latestCompleted
                  ? formatDate(
                      health.snapshots.latestCompleted.completedAt ??
                        health.snapshots.latestCompleted.capturedAt,
                    )
                  : "None yet"}
              </dd>
            </div>
            <div>
              <dt>Import state</dt>
              <dd>
                {health.currentJob
                  ? "Import in progress"
                  : health.lastJob?.status === "failed"
                    ? "Last import failed"
                    : "No active import"}
              </dd>
            </div>
          </dl>
          {health.failures.length > 0 ? (
            <div className="action-state warning" role="alert">
              <strong>Import needs attention</strong>
              <span>
                Review the source and run the import again. Technical details are kept private.
              </span>
            </div>
          ) : null}
        </section>
        <section className="overview-card" aria-labelledby="activity-heading">
          <h2 id="activity-heading">Activity</h2>
          {statistics.activity.length === 0 ? (
            <p className="muted-copy">Activity will appear after the first completed import.</p>
          ) : (
            <div className="activity-list" aria-label="Message activity by period">
              {statistics.activity.slice(-7).map((item) => (
                <div className="activity-row" key={item.bucketStart}>
                  <span>{formatDate(item.bucketStart)}</span>
                  <strong>{item.count.toLocaleString()}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="overview-card overview-card-wide" aria-labelledby="distribution-heading">
        <h2 id="distribution-heading">Message distribution</h2>
        <div className="distribution-grid">
          <div>
            <span>Sent</span>
            <strong>{statistics.direction.sent.toLocaleString()}</strong>
          </div>
          <div>
            <span>Received</span>
            <strong>{statistics.direction.received.toLocaleString()}</strong>
          </div>
          <div>
            <span>Unknown direction</span>
            <strong>{statistics.direction.unknown.toLocaleString()}</strong>
          </div>
        </div>
        {statistics.mostActiveConversations.length > 0 ? (
          <div className="active-conversations">
            <h3>Most active conversations</h3>
            <ol>
              {statistics.mostActiveConversations.slice(0, 5).map((conversation) => (
                <li key={conversation.conversationId}>
                  <span>{conversation.title || "Untitled conversation"}</span>
                  <strong>{conversation.messageCount.toLocaleString()}</strong>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>
      {health.media.missing + health.media.unsafe + health.media.unresolved > 0 ? (
        <div className="action-state warning" role="status">
          <strong>Some media is unavailable</strong>
          <span>
            Messages remain searchable; unavailable files are never exposed as broken or unsafe
            links.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function HealthCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  detail: string;
}) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString() : value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function OverviewStatus({
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
    <section className="overview-status" aria-live="polite" aria-busy={busy || undefined}>
      <span className="status-icon" aria-hidden="true">
        {busy ? "…" : "◌"}
      </span>
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      {href ? (
        <a className="button" href={href}>
          {action}
        </a>
      ) : null}
      {onAction ? (
        <button className="button" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseSnapshots(value: Record<string, unknown>): ArchiveHealthRead["snapshots"] {
  const parse = (item: unknown): ArchiveHealthRead["snapshots"]["latestCompleted"] => {
    if (!isRecord(item)) return undefined;
    const id = optionalString(item.id);
    const capturedAt = optionalString(item.capturedAt);
    const lifecycle = item.lifecycle;
    if (
      !id ||
      !capturedAt ||
      !["completed", "failed", "in-progress", "discovered"].includes(lifecycle as string)
    )
      return undefined;
    return {
      id,
      capturedAt,
      lifecycle: lifecycle as NonNullable<
        ArchiveHealthRead["snapshots"]["latestCompleted"]
      >["lifecycle"],
      ...(optionalString(item.completedAt)
        ? { completedAt: optionalString(item.completedAt) }
        : {}),
    };
  };
  const latestDiscovered = parse(value.latestDiscovered);
  const latestCompleted = parse(value.latestCompleted);
  return {
    ...(latestDiscovered ? { latestDiscovered } : {}),
    ...(latestCompleted ? { latestCompleted } : {}),
  };
}
function parseJob(value: Record<string, unknown>): ArchiveHealthRead["jobs"][number] {
  const status =
    value.status === "completed" || value.status === "failed" ? value.status : "in-progress";
  const phase = optionalString(value.phase);
  const startedAt = optionalString(value.startedAt);
  const finishedAt = optionalString(value.finishedAt);
  const durationMilliseconds = count(value.durationMilliseconds);
  return {
    id: string(value.id),
    status,
    ...(phase ? { phase } : {}),
    createdAt: optionalString(value.createdAt) ?? "",
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMilliseconds > 0 ? { durationMilliseconds } : {}),
  };
}
function string(value: unknown): string {
  return typeof value === "string" && value.length <= 256 ? value : "unknown";
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 ? value : undefined;
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function isHealthState(value: unknown): value is ArchiveHealthRead["state"] {
  return ["healthy", "warning", "failed", "empty", "in-progress", "stale", "unsupported"].includes(
    value as string,
  );
}
function isDiagnosticCode(value: unknown): value is ArchiveHealthRead["failures"][number]["code"] {
  return [
    "CORRUPT_SOURCE",
    "INVALID_KEY",
    "IO_FAILURE",
    "UNSUPPORTED_SCHEMA",
    "IMPORT_FAILURE",
    "MISSING_MEDIA",
    "UNSUPPORTED_CONTENT",
  ].includes(value as string);
}
function isFreshness(value: unknown): value is ArchiveHealthRead["freshness"] {
  return value === "fresh" || value === "stale" || value === "unknown";
}
function isBucket(value: unknown): value is ArchiveStatisticsRead["range"]["bucket"] {
  return value === "day" || value === "week" || value === "month";
}
function formatDate(value: string | undefined): string {
  if (!value) return "None yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
function mediaDetail(health: ArchiveHealthRead): string {
  return `${health.media.available.toLocaleString()} available · ${health.media.missing.toLocaleString()} missing`;
}
function freshnessDetail(health: ArchiveHealthRead): string {
  return health.freshness === "fresh" ? "Archive is current" : "A new import may help";
}
