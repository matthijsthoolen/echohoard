import { createHmac, timingSafeEqual } from "node:crypto";

/** Application-level read contracts. They deliberately contain no ORM or
 * delivery types, and every query is scoped to exactly one archive. */
export type ReadArchiveId = string;
export type ReadDirection = "forward" | "backward";
export type ReadSort =
  | "createdAt,id"
  | "sentAt,id"
  | "displayName,id"
  | "searchScore,sentAt,id";

export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 2048;
export const CURSOR_VERSION = 1;
export const READ_ORDER = Object.freeze({
  conversations: "createdAt,id" as const,
  people: "displayName,id" as const,
  messages: "sentAt,id" as const,
});
const DEFAULT_CURSOR_TTL = 24 * 60 * 60 * 1000;

export interface PageRequest {
  readonly archiveId: ReadArchiveId;
  readonly limit?: number;
  readonly cursor?: string;
  readonly direction?: ReadDirection;
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
  readonly sort: ReadSort;
  readonly values: readonly (string | number)[];
}

interface CursorPayload extends CursorPosition {
  readonly version: typeof CURSOR_VERSION;
  readonly archiveId: ReadArchiveId;
  readonly direction: ReadDirection;
  readonly issuedAt: number;
  readonly expiresAt: number;
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
    readonly sort: ReadSort;
    readonly values: readonly (string | number)[];
  }): string {
    if (
      !input.archiveId.trim() ||
      input.values.length === 0 ||
      !isSort(input.sort) ||
      (input.direction !== "forward" && input.direction !== "backward")
    )
      throw new InvalidCursorError();
    const issuedAt = this.now();
    const payload: CursorPayload = {
      version: CURSOR_VERSION,
      archiveId: input.archiveId,
      direction: input.direction,
      sort: input.sort,
      values: input.values,
      issuedAt,
      expiresAt: issuedAt + this.ttlMilliseconds,
    };
    const body = base64url(JSON.stringify(payload));
    const cursor = `${body}.${this.sign(body)}`;
    if (cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError();
    return cursor;
  }

  public decode(
    cursor: string,
    archiveId: ReadArchiveId,
  ): CursorPosition & { direction: ReadDirection } {
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError();
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra) throw new InvalidCursorError();
    const expected = this.sign(body);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
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
      (payload.direction !== "forward" && payload.direction !== "backward") ||
      !isSort(payload.sort) ||
      !Array.isArray(payload.values) ||
      payload.values.length === 0 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      this.now() >= payload.expiresAt
    )
      throw new InvalidCursorError();
    if (payload.archiveId !== archiveId) throw new CursorScopeError();
    return { sort: payload.sort, values: payload.values, direction: payload.direction };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

const isSort = (value: unknown): value is ReadSort =>
  value === "createdAt,id" ||
  value === "sentAt,id" ||
  value === "displayName,id" ||
  value === "searchScore,sentAt,id";

const searchCursorValues = (
  values: readonly (string | number)[],
): readonly [number, string, string] => {
  const [score, sortSentAt, id] = values;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    typeof sortSentAt !== "string" ||
    !sortSentAt ||
    typeof id !== "string" ||
    !id
  )
    throw new InvalidCursorError();
  return [score, sortSentAt, id];
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
  readonly direction: "sent" | "received" | "unknown";
  readonly messageType: string;
  readonly replyTo?: MessageReplyRead;
  readonly revisions: readonly MessageRevisionRead[];
  readonly reactions: readonly MessageReactionRead[];
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
  readonly sort?: "displayName,id";
  readonly search?: string;
}
export interface MessageWindowQuery extends PageRequest {
  readonly conversationId: string;
  readonly sort?: "sentAt,id";
}
export interface MediaListQuery extends PageRequest {
  readonly messageId?: string;
}
export interface TimelineQuery extends PageRequest {
  readonly from?: string;
  readonly to?: string;
}
export interface SearchQuery extends PageRequest {
  readonly query: string;
}
export interface StatisticsQuery {
  readonly archiveId: ReadArchiveId;
  readonly from?: string;
  readonly to?: string;
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
}

export interface ReadConversationPersistenceQuery {
  readonly archiveId: string;
  readonly limit: number;
  readonly direction: ReadDirection;
  readonly after?: readonly (string | number)[];
  readonly search?: string;
}
export interface ReadPersonPersistenceQuery extends ReadConversationPersistenceQuery {}
export interface ReadMessagePersistenceQuery extends ReadConversationPersistenceQuery {
  readonly conversationId: string;
}
export interface ReadSearchPersistenceQuery {
  readonly archiveId: string;
  readonly query: string;
  readonly limit: number;
  readonly direction: ReadDirection;
  /** [rank, sortable sent-at, message id] from the previous page. */
  readonly after?: readonly (string | number)[];
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
  /** A non-null sortable timestamp; messages without sentAt use a high sentinel. */
  readonly sortSentAt: string;
}
export interface MessagePersistenceRow {
  readonly id: string;
  readonly conversationId: string;
  readonly senderPersonId?: string;
  readonly sentAt?: string;
  readonly text?: string;
  readonly attachmentCount: number;
  readonly direction?: "sent" | "received" | "unknown";
  readonly messageType?: string;
  readonly replyTo?: MessageReplyRead;
  readonly revisions?: readonly MessageRevisionRead[];
  readonly reactions?: readonly MessageReactionRead[];
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
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId)
      : undefined;
    if (position && position.sort !== "createdAt,id") throw new InvalidCursorError();
    const rows = await this.persistence.listConversations({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(query.search ? { search: query.search } : {}),
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
    );
  }

  public async listPeople(query: PersonListQuery): Promise<ReadPage<PersonRead>> {
    const request = validatePageRequest(query);
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId)
      : undefined;
    if (position && position.sort !== "displayName,id") throw new InvalidCursorError();
    const rows = await this.persistence.listPeople({
      archiveId: request.archiveId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
      ...(query.search ? { search: query.search } : {}),
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
      items.at(-1) ? [rows[items.length - 1].displayName ?? "", items.at(-1)!.id] : undefined,
      "displayName,id",
    );
  }

  public async listMessages(query: MessageWindowQuery): Promise<ReadPage<MessageRead>> {
    const request = validatePageRequest(query);
    if (!query.conversationId.trim())
      throw new InvalidReadRequestError("conversationId is required");
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId)
      : undefined;
    if (position && position.sort !== "sentAt,id") throw new InvalidCursorError();
    const rows = await this.persistence.listMessages({
      archiveId: request.archiveId,
      conversationId: query.conversationId,
      limit: request.limit + 1,
      direction: request.direction,
      ...(position ? { after: position.values } : {}),
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      ...(row.senderPersonId ? { senderPersonId: row.senderPersonId } : {}),
      sentAt: row.sentAt ?? "",
      ...(row.text !== undefined ? { text: row.text } : {}),
      attachmentCount: row.attachmentCount,
      direction: row.direction ?? "unknown",
      messageType: row.messageType ?? "unsupported",
      ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      revisions: row.revisions ?? [],
      reactions: row.reactions ?? [],
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1) ? [rows[items.length - 1].sentAt ?? "", items.at(-1)!.id] : undefined,
      "sentAt,id",
    );
  }

  public listMedia(): Promise<ReadPage<MediaRead>> {
    throw new Error("Not implemented in EH-06-02");
  }
  public listTimeline(): Promise<ReadPage<TimelineRead>> {
    throw new Error("Not implemented in EH-06-02");
  }
  public async search(query: SearchQuery): Promise<ReadPage<SearchResultRead>> {
    const request = validatePageRequest(query);
    if (typeof query.query !== "string")
      throw new InvalidReadRequestError("query must be a string");
    const position = request.cursor
      ? this.cursors.decode(request.cursor, request.archiveId)
      : undefined;
    if (position && position.sort !== "searchScore,sentAt,id") throw new InvalidCursorError();
    const after = position ? searchCursorValues(position.values) : undefined;

    // An empty tsquery matches no rows, and skipping the database call also
    // keeps empty input deterministic across PostgreSQL versions/configuration.
    if (!query.query.trim()) return { items: [], hasMore: false };

    const rows = await this.persistence.searchMessages({
      archiveId: request.archiveId,
      query: query.query,
      limit: request.limit + 1,
      direction: request.direction,
      ...(after ? { after } : {}),
    });
    const items = rows.slice(0, request.limit).map((row) => ({
      id: row.id,
      kind: "message" as const,
      score: row.score,
    }));
    return this.page(
      items,
      rows.length > request.limit,
      request,
      items.at(-1)
        ? [rows[items.length - 1].score, rows[items.length - 1].sortSentAt, items.at(-1)!.id]
        : undefined,
      "searchScore,sentAt,id",
    );
  }
  public statistics(): Promise<StatisticsRead> {
    throw new Error("Not implemented in EH-06-02");
  }

  private page<T extends { readonly id: string }>(
    items: readonly T[],
    hasMore: boolean,
    request: ValidatedPageRequest,
    values: readonly (string | number)[] | undefined,
    sort: ReadSort,
  ): ReadPage<T> {
    return {
      items,
      hasMore,
      ...(hasMore && values
        ? {
            nextCursor: this.cursors.encode({
              archiveId: request.archiveId,
              direction: request.direction,
              sort,
              values,
            }),
          }
        : {}),
    };
  }
}
