import { swallowAs } from "../util/errors.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { cronIdOf } from "../sessions/session-store.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

function dmThreadTs(request: NonNullable<PendingApprovalRecord["request"]>): string | undefined {
  if (request.conversation?.kind !== "dm" || !request.deliveryTarget) return undefined;
  const [channel, threadTs] = request.deliveryTarget.split(":");
  return channel?.startsWith("D") && threadTs ? threadTs : undefined;
}

const CREDENTIAL_RESUME_SURFACES = new Set(["secret-drop", "keychain-ask"]);

function slackWorkspace(
  request: NonNullable<PendingApprovalRecord["request"]>,
): { slackAccountId?: string; slackTeamId?: string } | undefined {
  if (request.surface === "slack") {
    return request.slackSource
      ? { slackAccountId: request.slackSource.accountId, slackTeamId: request.slackSource.teamId }
      : {};
  }
  const destination = request.triggerDestination;
  if (!CREDENTIAL_RESUME_SURFACES.has(request.surface) || destination?.type !== "slack") return undefined;
  if (cronIdOf(request.conversation.threadRef)) return undefined;
  return {
    ...(destination.slackAccountId ? { slackAccountId: destination.slackAccountId } : {}),
    ...(destination.slackTeamId ? { slackTeamId: destination.slackTeamId } : {}),
  };
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    if (!record.request) return;
    const workspace = slackWorkspace(record.request);
    if (!workspace) return;
    const actorId = approvalDeliveryRecipient(record.request.actor);
    if (!actorId) return;
    const threadTs = dmThreadTs(record.request);
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...workspace,
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries()) await deliver(id, record);
    },
  };
}
