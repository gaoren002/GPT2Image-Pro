/** consumeCredits 专用同事务写入：消费、Key、钱包和财务认领一起提交或回滚。 */
import type { db } from "@repo/database";
import { relayInitialCharge } from "@repo/database/schema";
import {
  type RelayInitialCaptureIntent,
  validateRelayInitialCapture,
} from "./relay-initial-charge-contract";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 不创建独立事务或扣款；只接受 core 已规范化的正数消费及其本次 transactionId。 */
export async function recordRelayInitialCaptureInTransaction(
  tx: Transaction,
  intent: RelayInitialCaptureIntent,
  payment: {
    userId: string;
    amount: number;
    sourceRef?: string;
    externalApiKeyId?: string;
    metadata?: Record<string, unknown>;
    transactionId: string;
  }
): Promise<void> {
  const parsed = validateRelayInitialCapture(intent, payment);
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    throw new Error("Pure relay initial capture requires a positive charge");
  }
  await tx.insert(relayInitialCharge).values({
    id: parsed.captureId,
    userId: payment.userId,
    generationId: parsed.generationId,
    consumptionTransactionId: payment.transactionId,
    apiKeyId: payment.externalApiKeyId ?? null,
    amount: payment.amount,
    state: "captured",
    expiresAt: parsed.expiresAt,
  });
}
