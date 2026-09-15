import type { PersistenceRecord } from "./persistence.js";

export type ConversationUiVisibility = "normal" | "hidden" | "locked";
export type ConversationMcpAccess = "allowed" | "denied";

export interface ConversationPrivacyPolicy {
  readonly archiveId: string;
  readonly conversationId: string;
  readonly uiVisibility: ConversationUiVisibility;
  readonly mcpAccess: ConversationMcpAccess;
  /** Optional source observation; it never changes EchoHoard policy. */
  readonly sourceLockMetadata?: PersistenceRecord;
}

export interface UpdateConversationPrivacyRequest {
  readonly archiveId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly uiVisibility?: ConversationUiVisibility;
  readonly mcpAccess?: ConversationMcpAccess;
  readonly requestedAt?: Date;
}

export interface ConversationPrivacyAudit {
  readonly id: string;
  readonly archiveId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly action: "set-ui-visibility" | "set-mcp-access";
  readonly createdAt: Date;
}

export interface ConversationPrivacyPersistence {
  findPolicy(archiveId: string, conversationId: string): Promise<ConversationPrivacyPolicy | null>;
  updatePolicy(request: UpdateConversationPrivacyRequest): Promise<{
    readonly policy: ConversationPrivacyPolicy;
    readonly audit: readonly ConversationPrivacyAudit[];
  }>;
}

export class UpdateConversationPrivacyService {
  public constructor(private readonly persistence: ConversationPrivacyPersistence) {}

  public execute(request: UpdateConversationPrivacyRequest) {
    validateRequest(request);
    return this.persistence.updatePolicy(request);
  }
}

export function validatePolicy(policy: ConversationPrivacyPolicy): ConversationPrivacyPolicy {
  requireId(policy.archiveId, "archiveId");
  requireId(policy.conversationId, "conversationId");
  if (!isUiVisibility(policy.uiVisibility)) throw new Error("Invalid conversation UI visibility");
  if (!isMcpAccess(policy.mcpAccess)) throw new Error("Invalid conversation MCP access");
  return policy;
}

export function transitionConversationPrivacy(
  current: ConversationPrivacyPolicy,
  request: UpdateConversationPrivacyRequest,
): ConversationPrivacyPolicy {
  validatePolicy(current);
  validateRequest(request);
  if (current.archiveId !== request.archiveId || current.conversationId !== request.conversationId)
    throw new Error("Conversation privacy policy is archive-scoped");
  return {
    ...current,
    ...(request.uiVisibility ? { uiVisibility: request.uiVisibility } : {}),
    ...(request.mcpAccess ? { mcpAccess: request.mcpAccess } : {}),
  };
}

function validateRequest(request: UpdateConversationPrivacyRequest): void {
  requireId(request.archiveId, "archiveId");
  requireId(request.conversationId, "conversationId");
  requireId(request.actorId, "actorId");
  if (request.uiVisibility === undefined && request.mcpAccess === undefined)
    throw new Error("At least one privacy policy field is required");
  if (request.uiVisibility !== undefined && !isUiVisibility(request.uiVisibility))
    throw new Error("Invalid conversation UI visibility");
  if (request.mcpAccess !== undefined && !isMcpAccess(request.mcpAccess))
    throw new Error("Invalid conversation MCP access");
}

function requireId(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

const isUiVisibility = (value: string): value is ConversationUiVisibility =>
  value === "normal" || value === "hidden" || value === "locked";
const isMcpAccess = (value: string): value is ConversationMcpAccess =>
  value === "allowed" || value === "denied";
