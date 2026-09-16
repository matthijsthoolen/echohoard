import { Prisma } from "@prisma/client";
import type { UiReadMode } from "../../application/reads.js";

export interface UiPrivacyQueryInput {
  readonly uiMode: UiReadMode;
  readonly authorizedConversationIds: readonly string[];
}

/**
 * Return the effective UI policy for the presentation group containing the
 * aliased conversation. Source conversations remain policy-bearing rows, so
 * a normal presentation conversation cannot make a protected source visible.
 * The alias is always an internal SQL identifier supplied by this adapter.
 */
export function uiConversationPredicate(alias: string, input: UiPrivacyQueryInput): Prisma.Sql {
  const effectiveRank = effectivePolicyRank(alias);
  const expectedRank = input.uiMode === "ordinary" ? 0 : input.uiMode === "hidden" ? 1 : 2;
  const expected = Prisma.sql`${effectiveRank} = ${expectedRank}`;
  if (input.uiMode !== "locked") return expected;

  const groupId = presentationConversationId(alias);
  const unauthorizedLockedPolicy =
    input.authorizedConversationIds.length === 0
      ? Prisma.sql`TRUE`
      : Prisma.sql`policy.id::text NOT IN (${Prisma.join(
          input.authorizedConversationIds.map((id) => Prisma.sql`${id}`),
        )})`;
  return Prisma.sql`${expected}
    AND NOT EXISTS (
      SELECT 1
      FROM "Conversation" policy
      WHERE policy."archiveId" = ${Prisma.raw(alias)}."archiveId"
        AND ${policyBelongsToGroup("policy", groupId)}
        AND policy."uiVisibility" = 'locked'
        AND ${unauthorizedLockedPolicy}
    )`;
}

function effectivePolicyRank(alias: string): Prisma.Sql {
  const groupId = presentationConversationId(alias);
  return Prisma.sql`GREATEST(
    COALESCE((
      SELECT MAX(${policyRank("policy")})
      FROM "Conversation" policy
      WHERE policy."archiveId" = ${Prisma.raw(alias)}."archiveId"
        AND ${policyBelongsToGroup("policy", groupId)}
    ), 0),
    0
  )`;
}

function policyBelongsToGroup(policyAlias: string, groupId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    ${Prisma.raw(policyAlias)}.id = ${groupId}
    OR EXISTS (
      SELECT 1
      FROM "SourceConversation" group_source
      WHERE group_source."archiveId" = ${Prisma.raw(policyAlias)}."archiveId"
        AND group_source."unifiedConversationId" = ${groupId}
        AND (
          EXISTS (
            SELECT 1
            FROM "Message" group_message
            WHERE group_message."archiveId" = group_source."archiveId"
              AND group_message."sourceConversationId" = group_source.id
              AND group_message."conversationId" = ${Prisma.raw(policyAlias)}.id
          )
          OR EXISTS (
            SELECT 1
            FROM "ConversationParticipant" group_participant
            WHERE group_participant."archiveId" = group_source."archiveId"
              AND group_participant."sourceConversationId" = group_source.id
              AND group_participant."conversationId" = ${Prisma.raw(policyAlias)}.id
          )
        )
    )
  )`;
}

function presentationConversationId(alias: string): Prisma.Sql {
  return Prisma.sql`COALESCE(
    (
      SELECT source_for_alias."unifiedConversationId"
      FROM "SourceConversation" source_for_alias
      WHERE source_for_alias."archiveId" = ${Prisma.raw(alias)}."archiveId"
        AND (
          source_for_alias.id = ${Prisma.raw(alias)}.id
          OR EXISTS (
            SELECT 1
            FROM "Message" source_message
            WHERE source_message."archiveId" = source_for_alias."archiveId"
              AND source_message."sourceConversationId" = source_for_alias.id
              AND source_message."conversationId" = ${Prisma.raw(alias)}.id
          )
          OR EXISTS (
            SELECT 1
            FROM "ConversationParticipant" source_participant
            WHERE source_participant."archiveId" = source_for_alias."archiveId"
              AND source_participant."sourceConversationId" = source_for_alias.id
              AND source_participant."conversationId" = ${Prisma.raw(alias)}.id
          )
        )
      LIMIT 1
    ),
    ${Prisma.raw(alias)}.id
  )`;
}

function policyRank(alias: string): Prisma.Sql {
  return Prisma.sql`CASE ${Prisma.raw(alias)}."uiVisibility"
    WHEN 'locked' THEN 2
    WHEN 'hidden' THEN 1
    ELSE 0
  END`;
}
