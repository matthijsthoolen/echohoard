import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Application-level read contracts. They deliberately contain no ORM or
 * delivery types, and every query is scoped to exactly one archive. */
export type ReadArchiveId = string;
export type ReadDirection = "forward" | "backward";
export type ReadKind = "conversations" | "people" | "messages" | "media" | "timeline" | "search";
export type ReadSort =
  | "createdAt,id"
  | "sentAt,id"
  | "displayNameNull,displayName,id"
  | "occurredAt,kind,id"
  | "searchScore,sentAtNull,sentAt,id";
export type MessageDirection = "sent" | "received" | "unknown";
export type SourceDeletionKind = "revoke" | "delete";
export type SearchMediaType = "image" | "video" | "audio" | "document" | "other";
export type UiReadMode = "ordinary" | "hidden" | "locked";
export interface UiReadAccess {
  readonly mode?: UiReadMode;
  /** Conversation ids for which the existing step-up grant was validated. */
  readonly authorizedConversationIds?: readonly string[];
}
/** Explicit MCP disclosure scope. MCP policy is independent from UI policy. */
export type McpReadAccess = "allowed";

export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 2048;
export const CURSOR_VERSION = 1;
export const READ_ORDER = Object.freeze({
  conversations: "createdAt,id" as const,
  people: "displayNameNull,displayName,id" as const,
  messages: "sentAt,id" as const,
  media: "createdAt,id" as const,
  timeline: "occurredAt,kind,id" as const,
  search: "searchScore,sentAtNull,sentAt,id" as const,
});
const DEFAULT_CURSOR_TTL = 24 * 60 * 60 * 1000;

export interface PageRequest {
  readonly archiveId: ReadArchiveId;
  readonly limit?: number;
  readonly cursor?: string;
  readonly direction?: ReadDirection;
  readonly uiAccess?: UiReadAccess;
  readonly mcpAccess?: McpReadAccess;
}

export interface ValidatedPageRequest {
  readonly archiveId: ReadArchiveId;
  readonly limit: number;
  readonly cursor?: string;
  readonly direction: ReadDirection;
}

export interface ReadPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface CursorPosition {
  readonly readKind: ReadKind;
  readonly resourceId?: string;
  readonly sort: ReadSort;
  readonly values: readonly CursorValue[];
  readonly filterKey: string;
}

export type CursorValue = string | number | boolean | null;

interface CursorPayload extends CursorPosition {
  readonly version: typeof CURSOR_VERSION;
  readonly archiveId: ReadArchiveId;
  readonly direction: ReadDirection;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CursorExpectation {
  readonly readKind: ReadKind;
  readonly direction: ReadDirection;
  readonly resourceId?: string;
  readonly filterKey: string;
}

export class InvalidReadRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidReadRequestError";
  }
}

export class InvalidCursorError extends InvalidReadRequestError {
  public constructor() {
    super("Invalid or expired cursor");
    this.name = "InvalidCursorError";
  }
}

export class CursorScopeError extends InvalidReadRequestError {
  public constructor() {
    super("Cursor does not belong to the requested archive");
    this.name = "CursorScopeError";
  }
}

export function validatePageRequest(input: PageRequest): ValidatedPageRequest {
  if (!input.archiveId.trim()) throw new InvalidReadRequestError("archiveId is required");
  const limit = input.limit ?? DEFAULT_READ_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT)
    throw new InvalidReadRequestError(`limit must be an integer from 1 to ${MAX_READ_LIMIT}`);
  if (input.direction && input.direction !== "forward" && input.direction !== "backward")
    throw new InvalidReadRequestError("direction is invalid");
  if (input.cursor !== undefined && input.cursor.length > MAX_CURSOR_LENGTH)
    throw new InvalidCursorError();
  return {
    archiveId: input.archiveId,
    limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    direction: input.direction ?? "forward",
  };
}

function readAccess(input: PageRequest): {
  readonly uiMode: UiReadMode;
  readonly authorizedConversationIds: readonly string[];
  readonly mcpAccess?: McpReadAccess;
} {
  if (input.mcpAccess !== undefined) {
    if (input.mcpAccess !== "allowed" || input.uiAccess !== undefined)
      throw new InvalidReadRequestError("read access scope is invalid");
    return { mcpAccess: "allowed", uiMode: "ordinary", authorizedConversationIds: [] };
  }
  const inputUiAccess = input.uiAccess;
  const mode = inputUiAccess?.mode ?? "ordinary";
  if (mode !== "ordinary" && mode !== "hidden" && mode !== "locked")
    throw new InvalidReadRequestError("ui read mode is invalid");
  const ids = inputUiAccess?.authorizedConversationIds ?? [];
  if (ids.some((id) => !id.trim()))
    throw new InvalidReadRequestError("conversation authorization is invalid");
  return { uiMode: mode, authorizedConversationIds: ids };
}

export class CursorCodec {
  public constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMilliseconds = DEFAULT_CURSOR_TTL,
  ) {
    if (!secret) throw new Error("cursor signing secret is required");
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1)
      throw new Error("cursor TTL must be a positive integer");
  }

  public encode(input: {
    readonly archiveId: ReadArchiveId;
    readonly direction: ReadDirection;
    readonly readKind: ReadKind;
    readonly resourceId?: string;
    readonly sort: ReadSort;
    readonly values: readonly CursorValue[];
    readonly filterKey: string;
  }): string {
    if (
      !input.archiveId.trim() ||
      !isReadKind(input.readKind) ||
      input.values.length === 0 ||
      !isSort(input.sort) ||
      !isCursorTuple(input.sort, input.values) ||
      !input.filterKey ||
      (input.direction !== "forward" && input.direction !== "backward")
    )
      throw new InvalidCursorError();
    const issuedAt = this.now();
    const payload: CursorPayload = {
      version: CURSOR_VERSION,
      archiveId: input.archiveId,
      direction: input.direction,
      readKind: input.readKind,
      sort: input.sort,
      values: input.values,
      issuedAt,
      expiresAt: issuedAt + this.ttlMilliseconds,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      filterKey: input.filterKey,
    };
    const body = base64url(JSON.stringify(payload));
    const cursor = `${body}.${this.sign(body)}`;
    if (cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError();
    return cursor;
  }

  public decode(
    cursor: string,
    archiveId: ReadArchiveId,
    expected?: CursorExpectation,
  ): CursorPosition & { direction: ReadDirection } {
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError();
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra) throw new InvalidCursorError();
    const expectedSignature = this.sign(body);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expectedSignature);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
      throw new InvalidCursorError();
    let payload: Partial<CursorPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as Partial<CursorPayload>;
    } catch {
      throw new InvalidCursorError();
    }
    if (
      payload.version !== CURSOR_VERSION ||
      !isReadKind(payload.readKind) ||
      (payload.direction !== "forward" && payload.direction !== "backward") ||
      !isSort(payload.sort) ||
      !Array.isArray(payload.values) ||
      payload.values.length === 0 ||
      !payload.values.every(isCursorValue) ||
      !isCursorTuple(payload.sort, payload.values) ||
      typeof payload.filterKey !== "string" ||
      !payload.filterKey ||
      !Number.isSafeInteger(payload.issuedAt) ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      this.now() >= payload.expiresAt
    )
      throw new InvalidCursorError();
    if (payload.archiveId !== archiveId) throw new CursorScopeError();
    if (
      expected &&
      (payload.readKind !== expected.readKind ||
        payload.direction !== expected.direction ||
        payload.resourceId !== expected.resourceId ||
        payload.filterKey !== expected.filterKey)
    )
      throw new InvalidCursorError();
    return {
      readKind: payload.readKind,
      ...(payload.resourceId === undefined ? {} : { resourceId: payload.resourceId }),
      sort: payload.sort,
      values: payload.values,
      direction: payload.direction,
      filterKey: payload.filterKey,
    };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

const isReadKind = (value: unknown): value is ReadKind =>
  value === "conversations" ||
  value === "people" ||
  value === "messages" ||
  value === "media" ||
  value === "timeline" ||
  value === "search";

const isSort = (value: unknown): value is ReadSort =>
  value === "createdAt,id" ||
  value === "sentAt,id" ||
  value === "displayNameNull,displayName,id" ||
  value === "occurredAt,kind,id" ||
  value === "searchScore,sentAtNull,sentAt,id";

const isCursorValue = (value: unknown): value is CursorValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const isCursorTuple = (sort: ReadSort, values: readonly CursorValue[]): boolean => {
  if (sort === "createdAt,id" || sort === "sentAt,id")
    return values.length === 2 && typeof values[0] === "string" && typeof values[1] === "string";
  if (sort === "displayNameNull,displayName,id")
    return (
      values.length === 3 &&
      (values[0] === 0 || values[0] === 1) &&
      ((values[0] === 0 && typeof values[1] === "string") ||
        (values[0] === 1 && values[1] === null)) &&
      typeof values[2] === "string"
    );
  if (sort === "occurredAt,kind,id")
    return (
      values.length === 3 &&
      typeof values[0] === "string" &&
      (values[1] === "message" || values[1] === "media") &&
      typeof values[2] === "string"
    );
  return (
    values.length === 4 &&
    typeof values[0] === "string" &&
    values[0].length > 0 &&
    (values[1] === 0 || values[1] === 1) &&
    ((values[1] === 0 && typeof values[2] === "string") ||
      (values[1] === 1 && values[2] === null)) &&
    typeof values[3] === "string"
  );
};

const searchCursorValues = (
  values: readonly CursorValue[],
): readonly [string, 0 | 1, string | null, string] => {
  const [score, sortSentAtNull, sortSentAt, id] = values;
  if (typeof score !== "string" || !score || (sortSentAtNull !== 0 && sortSentAtNull !== 1))
    throw new InvalidCursorError();
  if (typeof id !== "string" || !id) throw new InvalidCursorError();
  if (sortSentAtNull === 1) {
    if (sortSentAt !== null) throw new InvalidCursorError();
    return [score, sortSentAtNull, null, id];
  }
  if (typeof sortSentAt !== "string" || !sortSentAt) throw new InvalidCursorError();
  return [score, sortSentAtNull, sortSentAt, id];
};

const base64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

export interface ConversationRead {
  readonly id: string;
  readonly title: string;
  readonly participantCount: number;
  readonly lastMessageAt?: string;
}
export interface PersonRead {
  readonly id: string;
  readonly displayName: string;
  readonly identityCount: number;
}
export interface MessageRead {
  readonly id: string;
  readonly conversationId: string;
  readonly senderPersonId?: string;
  readonly sentAt: string;
  readonly text?: string;
  readonly attachmentCount: number;
  /** Attachment IDs are opaque archive-scoped handles for the media route. */
  readonly attachments?: readonly MessageAttachmentRead[];
  readonly direction: "sent" | "received" | "unknown";
  readonly messageType: string;
  /** Source metadata is evidence only; delivery treats all values as hostile text. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly replyTo?: MessageReplyRead;
  readonly revisions: readonly MessageRevisionRead[];
  readonly reactions: readonly MessageReactionRead[];
  readonly provenance?: MessageProvenanceRead;
  /** Source deletion is an evidence state, not an owner deletion request. */
  readonly sourceDeleted?: boolean;
  readonly contentUnavailable?: boolean;
  readonly sourceDeletedAt?: string;
  readonly sourceDeletionKind?: SourceDeletionKind;
}
export interface MessageProvenanceRead {
  readonly sourceAccountId: string;
  readonly sourceConversationId: string;
  readonly sourceNamespace: string;
  readonly sourceConversationKey: string;
  readonly importIds: readonly string[];
  readonly importCount: number;
  readonly importsTruncated: boolean;
}
export interface MessageAttachmentRead {
  readonly id: string;
  readonly availability: "available" | "missing" | "unsafe" | "unresolved";
  readonly mimeType?: string;
  readonly originalName?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly ordinal?: number;
  readonly role?: string;
}
export interface MessageReplyRead {
  readonly id: string;
  readonly sentAt?: string;
  readonly text?: string;
}
export interface MessageRevisionRead {
  readonly id: string;
  readonly firstSeenAt: string;
  readonly text?: string;
}
export interface MessageReactionRead {
  readonly id: string;
  readonly personId: string;
  readonly emoji: string;
}
export interface MediaRead {
  readonly id: string;
  readonly messageId: string;
  readonly mediaType: string;
  readonly availability: "available" | "missing" | "unsafe" | "unresolved";
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}
export interface TimelineRead {
  readonly id: string;
  readonly kind: "message" | "media";
  readonly occurredAt: string;
}
export interface SearchResultRead {
  readonly id: string;
  readonly kind: "message" | "person" | "conversation";
  readonly score?: number;
  /** Optional context fields let delivery open the exact stable message anchor. */
  readonly conversationId?: string;
  readonly sentAt?: string;
}
export interface StatisticsRead {
  readonly messageCount: number;
  readonly personCount: number;
  readonly conversationCount: number;
  readonly mediaCount: number;
}

export interface ConversationListQuery extends PageRequest {
  readonly sort?: "createdAt,id";
  readonly search?: string;
}
export interface PersonListQuery extends PageRequest {
  readonly sort?: "displayNameNull,displayName,id";
  readonly search?: string;
}
export interface MessageWindowQuery extends PageRequest {
  readonly conversationId: string;
  readonly sort?: "sentAt,id";
}
export interface MediaListQuery extends PageRequest {
  readonly messageId?: string;
  readonly attachmentId?: string;
  readonly mediaType?: SearchMediaType;
}
export interface TimelineQuery extends PageRequest {
  readonly from?: string;
  readonly to?: string;
}
export interface SearchQuery extends PageRequest {
  /** Full-text terms. Empty terms are allowed when a filter is supplied. */
  readonly query?: string;
  readonly conversationId?: string;
  /** Explicit name for the presentation/unified conversation filter. */
  readonly unifiedConversationId?: string;
  readonly personId?: string;
  /** Restricts results to messages from one owned source account. */
  readonly sourceAccountId?: string;
  /** Direction of the message sender; pagination direction remains separate. */
  readonly senderDirection?: MessageDirection;
  readonly from?: string;
  /** Inclusive lower bound and exclusive upper bound, both ISO timestamps. */
  readonly to?: string;
  readonly mediaType?: SearchMediaType;
  /** pg_trgm name matching against the sender and conversation title. */
  readonly fuzzyName?: string;
  /** pg_trgm body matching in addition to full-text terms. */
  readonly fuzzyText?: string;
  /** Aliases retained for delivery adapters that use shorter filter names. */
  readonly name?: string;
  readonly text?: string;
}
export interface StatisticsQuery {
  readonly archiveId: ReadArchiveId;
  readonly from?: string;
  readonly to?: string;
  readonly uiAccess?: UiReadAccess;
}

export interface ReadPorts {
  listConversations(query: ConversationListQuery): Promise<ReadPage<ConversationRead>>;
  listPeople(query: PersonListQuery): Promise<ReadPage<PersonRead>>;
  listMessages(query: MessageWindowQuery): Promise<ReadPage<MessageRead>>;
  listMedia(query: MediaListQuery): Promise<ReadPage<MediaRead>>;
  listTimeline(query: TimelineQuery): Promise<ReadPage<TimelineRead>>;
  search(query: SearchQuery): Promise<ReadPage<SearchResultRead>>;
  statistics(query: StatisticsQuery): Promise<StatisticsRead>;
}

/** Persistence-facing read rows. These are deliberately small, scalar DTOs;
 * Prisma records and relation graphs must not cross into the application. */
export interface ReadPersistencePort {
  listConversations(
    input: ReadConversationPersistenceQuery,
  ): Promise<readonly ConversationPersistenceRow[]>;
  listPeople(input: ReadPersonPersistenceQuery): Promise<readonly PersonPersistenceRow[]>;
  listMessages(input: ReadMessagePersistenceQuery): Promise<readonly MessagePersistenceRow[]>;
  searchMessages(input: ReadSearchPersistenceQuery): Promise<readonly SearchPersistenceRow[]>;
  listMedia?(input: ReadMediaPersistenceQuery): Promise<readonly MediaPersistenceRow[]>;
  listTimeline?(input: ReadTimelinePersistenceQuery): Promise<readonly TimelinePersistenceRow[]>;
}

export interface ReadConversationPersistenceQuery {
  readonly archiveId: string;
  readonly limit: number;
  readonly direction: ReadDirection;
  readonly after?: readonly CursorValue[];
  readonly search?: string;
  readonly uiMode: UiReadMode;
  readonly authorizedConversationIds: readonly string[];
  readonly mcpAccess?: McpReadAccess;
}
export interface ReadPersonPersistenceQuery extends ReadConversationPersistenceQuery {}
export interface ReadMessagePersistenceQuery extends ReadConversationPersistenceQuery {
  readonly conversationId: string;
}
export interface ReadMediaPersistenceQuery extends ReadConversationPersistenceQuery {
  readonly messageId?: string;
  readonly attachmentId?: string;
  readonly mediaType?: SearchMediaType;
}
export interface ReadTimelinePersistenceQuery extends ReadConversationPersistenceQuery {
  readonly from?: string;
  readonly to?: string;
}
export interface ReadSearchPersistenceQuery {
  readonly archiveId: string;
  readonly query: string;
  readonly limit: number;
  readonly direction: ReadDirection;
  /** [rank, sent-at null rank, sortable sent-at, message id] from the previous page. */
  readonly after?: readonly CursorValue[];
  readonly conversationId?: string;
  readonly unifiedConversationId?: string;
  readonly personId?: string;
  readonly sourceAccountId?: string;
  readonly senderDirection?: MessageDirection;
  readonly from?: string;
  readonly to?: string;
  readonly mediaType?: SearchMediaType;
  readonly fuzzyName?: string;
  readonly fuzzyText?: string;
  readonly uiMode: UiReadMode;
  readonly authorizedConversationIds: readonly string[];
  readonly mcpAccess?: McpReadAccess;
}
export interface ConversationPersistenceRow {
  readonly id: string;
  readonly title?: string;
  readonly participantCount: number;
  readonly lastMessageAt?: string;
  readonly createdAt: string;
}
export interface PersonPersistenceRow {
  readonly id: string;
  readonly displayName?: string;
  readonly identityCount: number;
}
export interface SearchPersistenceRow {
  readonly id: string;
  readonly score: number;
  /** Exact PostgreSQL numeric representation used by the ordering cursor. */
  readonly scoreKey: string;
  /** Null rank is the second SQL ordering key and keeps missing sentAt rows last. */
  readonly sortSentAtNull: 0 | 1;
  /** The nullable timestamp used by the third SQL ordering key. */
  readonly sortSentAt: string;
  readonly conversationId?: string;
}
export interface MessagePersistenceRow {
  readonly id: string;
  readonly conversationId: string;
  readonly senderPersonId?: string;
  readonly sentAt?: string;
  /** Non-null deterministic ordering value; missing sentAt uses createdAt. */
  readonly sortSentAt: string;
  readonly text?: string;
  readonly attachmentCount: number;
  readonly attachments?: readonly MessageAttachmentRead[];
  readonly direction?: "sent" | "received" | "unknown";
  readonly messageType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly replyTo?: MessageReplyRead;
  readonly revisions?: readonly MessageRevisionRead[];
  readonly reactions?: readonly MessageReactionRead[];
  readonly provenance?: MessageProvenanceRead;
  readonly sourceDeleted?: boolean;
  readonly contentUnavailable?: boolean;
  readonly sourceDeletedAt?: string;
  readonly sourceDeletionKind?: SourceDeletionKind;
}
export interface MediaPersistenceRow {
  readonly id: string;
  readonly messageId: string;
  /** The unique MessageAttachment row used by pagination; id is the attachment handle. */
  readonly cursorId: string;
  readonly mimeType?: string;
  readonly availability: string;
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly createdAt: string;
}
export interface TimelinePersistenceRow {
  readonly id: string;
  readonly kind: "message" | "media";
  readonly occurredAt: string;
  /** The unique event row used by pagination; media id remains the attachment handle. */
  readonly cursorId: string;
}

export class ArchiveReadService {
  public constructor(
    private readonly persistence: ReadPersistencePort,
    private readonly cursors: CursorCodec,
  ) {}

  public async listConversations(
    query: ConversationListQuery,
  ): Promise<ReadPage<ConversationRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    const filterKey = readContextKey({ search: query.search ?? null, ...access });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "conversations",
          direction: request.direction,
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "createdAt,id") throw new InvalidCursorError();
    const rows = await this.persistence.listConversations({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      title: row.title ?? "",
      participantCount: row.participantCount,
      ...(row.lastMessageAt ? { lastMessageAt: row.lastMessageAt } : {}),
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1) ? [rows[items.length - 1].createdAt, items.at(-1)!.id] : undefined,
      "createdAt,id",
      filterKey,
      "conversations",
    );
  }

  public async listPeople(query: PersonListQuery): Promise<ReadPage<PersonRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    const filterKey = readContextKey({ search: query.search ?? null, ...access });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "people",
          direction: request.direction,
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "displayNameNull,displayName,id")
      throw new InvalidCursorError();
    const rows = await this.persistence.listPeople({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      displayName: row.displayName ?? "",
      identityCount: row.identityCount,
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1)
        ? [
            rows[items.length - 1].displayName === undefined ? 1 : 0,
            rows[items.length - 1].displayName ?? null,
            items.at(-1)!.id,
          ]
        : undefined,
      "displayNameNull,displayName,id",
      filterKey,
      "people",
    );
  }

  public async listMessages(query: MessageWindowQuery): Promise<ReadPage<MessageRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    if (!query.conversationId.trim())
      throw new InvalidReadRequestError("conversationId is required");
    const filterKey = readContextKey({ ...access });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "messages",
          direction: request.direction,
          resourceId: query.conversationId,
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "sentAt,id") throw new InvalidCursorError();
    const rows = await this.persistence.listMessages({
      archiveId: request.archiveId,
      conversationId: query.conversationId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      ...(row.senderPersonId ? { senderPersonId: row.senderPersonId } : {}),
      sentAt: row.sentAt ?? "",
      ...(row.text !== undefined ? { text: row.text } : {}),
      attachmentCount: row.attachmentCount,
      attachments: row.attachments ?? [],
      direction: row.direction ?? "unknown",
      messageType: row.messageType ?? "unsupported",
      ...(row.metadata ? { metadata: row.metadata } : {}),
      ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      revisions: row.revisions ?? [],
      reactions: row.reactions ?? [],
      ...(row.provenance ? { provenance: row.provenance } : {}),
      ...(row.sourceDeleted
        ? { sourceDeleted: true, contentUnavailable: row.contentUnavailable ?? false }
        : {}),
      ...(row.sourceDeletedAt ? { sourceDeletedAt: row.sourceDeletedAt } : {}),
      ...(row.sourceDeletionKind ? { sourceDeletionKind: row.sourceDeletionKind } : {}),
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1) ? [rows[items.length - 1].sortSentAt, items.at(-1)!.id] : undefined,
      "sentAt,id",
      filterKey,
      "messages",
      query.conversationId,
    );
  }

  public async listMedia(query: MediaListQuery): Promise<ReadPage<MediaRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    const resourceId = query.messageId ?? query.attachmentId;
    const filterKey = readContextKey({
      messageId: query.messageId ?? null,
      attachmentId: query.attachmentId ?? null,
      mediaType: query.mediaType ?? null,
      ...access,
    });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "media",
          direction: request.direction,
          ...(resourceId === undefined ? {} : { resourceId }),
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "createdAt,id") throw new InvalidCursorError();
    if (!this.persistence.listMedia) throw new Error("Media reads are unavailable");
    const rows = await this.persistence.listMedia({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(query.messageId ? { messageId: query.messageId } : {}),
      ...(query.attachmentId ? { attachmentId: query.attachmentId } : {}),
      ...(query.mediaType ? { mediaType: query.mediaType } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      messageId: row.messageId,
      mediaType: mediaType(row.mimeType),
      availability: mediaAvailability(row.availability),
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      ...(row.byteSize !== undefined ? { byteSize: safeOptionalCount(row.byteSize) } : {}),
      ...(row.width !== undefined ? { width: safeOptionalCount(row.width) } : {}),
      ...(row.height !== undefined ? { height: safeOptionalCount(row.height) } : {}),
      ...(row.durationMs !== undefined ? { durationMs: safeOptionalCount(row.durationMs) } : {}),
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1)
        ? [rows[items.length - 1].createdAt, rows[items.length - 1].cursorId]
        : undefined,
      "createdAt,id",
      filterKey,
      "media",
      resourceId,
    );
  }
  public async listTimeline(query: TimelineQuery): Promise<ReadPage<TimelineRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    const from = parseReadDate(query.from, "from");
    const to = parseReadDate(query.to, "to");
    if (from && to && from > to) throw new InvalidReadRequestError("from must be before to");
    const filterKey = readContextKey({
      from: from === undefined ? null : new Date(from).toISOString(),
      to: to === undefined ? null : new Date(to).toISOString(),
      ...access,
    });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "timeline",
          direction: request.direction,
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "occurredAt,kind,id") throw new InvalidCursorError();
    if (!this.persistence.listTimeline) throw new Error("Timeline reads are unavailable");
    const rows = await this.persistence.listTimeline({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(to).toISOString() } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurredAt,
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1)
        ? [
            rows[items.length - 1].occurredAt,
            rows[items.length - 1].kind,
            rows[items.length - 1].cursorId,
          ]
        : undefined,
      "occurredAt,kind,id",
      filterKey,
      "timeline",
    );
  }
  public async search(query: SearchQuery): Promise<ReadPage<SearchResultRead>> {
    const request = validatePageRequest(query);
    const access = readAccess(query);
    if (query.query !== undefined && typeof query.query !== "string")
      throw new InvalidReadRequestError("query must be a string");
    const textQuery = query.query?.trim() ?? "";
    const fuzzyName = query.fuzzyName ?? query.name;
    const fuzzyText = query.fuzzyText ?? query.text;
    const unifiedConversationId = query.unifiedConversationId ?? query.conversationId;
    validateSearchFilters({ ...query, fuzzyName, fuzzyText });
    const normalizedFrom =
      query.from === undefined ? undefined : new Date(query.from).toISOString();
    const normalizedTo = query.to === undefined ? undefined : new Date(query.to).toISOString();
    const filterKey = searchFilterKey({
      query: textQuery,
      conversationId: unifiedConversationId,
      unifiedConversationId,
      sourceAccountId: query.sourceAccountId,
      personId: query.personId,
      senderDirection: query.senderDirection,
      from: normalizedFrom ?? null,
      to: normalizedTo ?? null,
      mediaType: query.mediaType,
      fuzzyName,
      fuzzyText,
      uiMode: access.uiMode,
      authorizedConversationIds: access.authorizedConversationIds,
    });
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId, {
          readKind: "search",
          direction: request.direction,
          ...(unifiedConversationId === undefined ? {} : { resourceId: unifiedConversationId }),
          filterKey,
        })
      : undefined;
    if (position && position.sort !== "searchScore,sentAtNull,sentAt,id")
      throw new InvalidCursorError();
    if (position && position.direction !== request.direction) throw new InvalidCursorError();
    const after = position ? searchCursorValues(position.values) : undefined;

    // A completely empty search remains a deterministic empty page. Filters
    // may still be used without text terms (for example media-only search).
    if (
      !textQuery &&
      fuzzyName === undefined &&
      fuzzyText === undefined &&
      unifiedConversationId === undefined &&
      query.personId === undefined &&
      query.sourceAccountId === undefined &&
      query.senderDirection === undefined &&
      query.from === undefined &&
      query.to === undefined &&
      query.mediaType === undefined
    )
      return { items: [], hasMore: false };

    const rows = await this.persistence.searchMessages({
      archiveId: request.archiveId,
      query: textQuery,
      limit: request.limit + 1,
      direction: request.direction,
      ...(after ? { after } : {}),
      ...(unifiedConversationId ? { conversationId: unifiedConversationId } : {}),
      ...(unifiedConversationId ? { unifiedConversationId } : {}),
      ...(query.sourceAccountId ? { sourceAccountId: query.sourceAccountId } : {}),
      ...(query.personId ? { personId: query.personId } : {}),
      ...(query.senderDirection ? { senderDirection: query.senderDirection } : {}),
      ...(query.from ? { from: new Date(query.from).toISOString() } : {}),
      ...(query.to ? { to: new Date(query.to).toISOString() } : {}),
      ...(query.mediaType ? { mediaType: query.mediaType } : {}),
      ...(fuzzyName ? { fuzzyName } : {}),
      ...(fuzzyText ? { fuzzyText } : {}),
      ...access,
    });
    const items = rows.slice(0, request.limit).map((row) => {
      const sortSentAtNull = searchSortSentAtNull(row);
      return {
        id: row.id,
        kind: "message" as const,
        score: row.score,
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
        ...(sortSentAtNull === 1 ? {} : { sentAt: row.sortSentAt }),
      };
    });
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1)
        ? [
            searchScoreKey(rows[items.length - 1]),
            searchSortSentAtNull(rows[items.length - 1]),
            searchSortSentAtNull(rows[items.length - 1]) === 1
              ? null
              : rows[items.length - 1].sortSentAt,
            items.at(-1)!.id,
          ]
        : undefined,
      "searchScore,sentAtNull,sentAt,id",
      filterKey,
      "search",
      unifiedConversationId,
    );
  }
  public statistics(): Promise<StatisticsRead> {
    throw new Error("Not implemented in EH-06-02");
  }

  private page<T extends { readonly id: string }>(
    items: readonly T[],
    hasMore: boolean,
    request: ValidatedPageRequest,
    values: readonly CursorValue[] | undefined,
    sort: ReadSort,
    filterKey: string,
    readKind: ReadKind,
    resourceId?: string,
  ): ReadPage<T> {
    return {
      items,
      hasMore,
      ...(hasMore && values
        ? {
            nextCursor: this.cursors.encode({
              archiveId: request.archiveId,
              direction: request.direction,
              readKind,
              ...(resourceId === undefined ? {} : { resourceId }),
              sort,
              values,
              filterKey,
            }),
          }
        : {}),
    };
  }
}

const SEARCH_TERM_MAX_LENGTH = 5000;
const FUZZY_TERM_MAX_LENGTH = 200;

function validateSearchFilters(
  input: SearchQuery & { readonly fuzzyName?: string; readonly fuzzyText?: string },
): void {
  for (const [name, value, max] of [
    ["query", input.query, SEARCH_TERM_MAX_LENGTH],
    ["fuzzyName", input.fuzzyName, FUZZY_TERM_MAX_LENGTH],
    ["fuzzyText", input.fuzzyText, FUZZY_TERM_MAX_LENGTH],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > max))
      throw new InvalidReadRequestError(`${name} is too long`);
  }
  for (const [name, value] of [
    ["conversationId", input.conversationId],
    ["personId", input.personId],
    ["sourceAccountId", input.sourceAccountId],
  ] as const) {
    if (value !== undefined && (!value.trim() || value.length > 200))
      throw new InvalidReadRequestError(`${name} is invalid`);
  }
  if (
    input.senderDirection !== undefined &&
    input.senderDirection !== "sent" &&
    input.senderDirection !== "received" &&
    input.senderDirection !== "unknown"
  )
    throw new InvalidReadRequestError("senderDirection is invalid");
  if (input.mediaType !== undefined && !isSearchMediaType(input.mediaType))
    throw new InvalidReadRequestError("mediaType is invalid");
  const from = parseSearchDate(input.from, "from");
  const to = parseSearchDate(input.to, "to");
  if (from && to && from > to) throw new InvalidReadRequestError("from must be before to");
}

function parseSearchDate(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new InvalidReadRequestError(`${name} is invalid`);
  return parsed;
}

function parseReadDate(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new InvalidReadRequestError(`${name} is invalid`);
  return parsed;
}

function mediaAvailability(value: string): MediaRead["availability"] {
  if (value === "available" || value === "unsafe" || value === "unresolved") return value;
  return "missing";
}

function mediaType(mimeType: string | undefined): string {
  if (!mimeType) return "other";
  const category = mimeType.split("/", 1)[0]?.toLowerCase();
  return category === "image" || category === "video" || category === "audio"
    ? category
    : "document";
}

function safeOptionalCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function searchSortSentAtNull(row: SearchPersistenceRow): 0 | 1 {
  return row.sortSentAtNull ?? (row.sortSentAt.startsWith("9999-") ? 1 : 0);
}

function searchScoreKey(row: SearchPersistenceRow): string {
  return row.scoreKey ?? String(row.score);
}

const isSearchMediaType = (value: unknown): value is SearchMediaType =>
  value === "image" ||
  value === "video" ||
  value === "audio" ||
  value === "document" ||
  value === "other";

function searchFilterKey(input: Record<string, unknown>): string {
  return readContextKey(input);
}

/** Hash the complete normalized read context so cursors stay opaque and
 * bounded even when a valid search term is near its input limit. */
function readContextKey(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest("base64url");
}
