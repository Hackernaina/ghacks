import { z } from "zod";
import { Currency, MinorUnits } from "./money.js";
import { ReportedStatus } from "./enums.js";

/** Status values a PSP sync/query response can report (subset of ReportedStatus). */
export const PspSyncStatus = z.enum(["SUCCEEDED", "FAILED", "PROCESSING"]);
export type PspSyncStatus = z.infer<typeof PspSyncStatus>;

export const CreatePaymentRequest = z.object({
  amount: MinorUnits,
  currency: Currency,
  orderId: z.string(),
  merchantPaymentId: z.string(),
  customerId: z.string(),
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequest>;

export const PspPaymentResponse = z.object({
  pspRef: z.string(),
  idempotencyKey: z.string(),
  status: PspSyncStatus,
  amount: MinorUnits,
  currency: Currency,
  createdAt: z.string().datetime({ offset: true }),
});
export type PspPaymentResponse = z.infer<typeof PspPaymentResponse>;

export const PspErrorResponse = z.object({
  error: z.string(),
  message: z.string(),
});
export type PspErrorResponse = z.infer<typeof PspErrorResponse>;

export const PspNotFoundResponse = z.object({
  error: z.literal("NOT_FOUND"),
});
export type PspNotFoundResponse = z.infer<typeof PspNotFoundResponse>;

export const CreateRefundRequest = z.object({
  pspRef: z.string(),
  amount: MinorUnits,
});
export type CreateRefundRequest = z.infer<typeof CreateRefundRequest>;

export const PspRefundResponse = z.object({
  refundRef: z.string(),
  pspRef: z.string(),
  status: PspSyncStatus,
  amount: MinorUnits,
});
export type PspRefundResponse = z.infer<typeof PspRefundResponse>;

/** One row of GET /v1/settlements?since= (CSV). */
export const SettlementLine = z.object({
  batch_id: z.string(),
  line_no: z.coerce.number().int(),
  psp_ref: z.string(),
  idempotency_key: z.string(),
  order_id: z.string(),
  amount: z.coerce.number().int(),
  currency: Currency,
  status: z.literal("SETTLED"),
  settled_at: z.string(),
});
export type SettlementLine = z.infer<typeof SettlementLine>;
export const SETTLEMENT_CSV_HEADER =
  "batch_id,line_no,psp_ref,idempotency_key,order_id,amount,currency,status,settled_at";

export const WebhookType = z.enum([
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
]);
export type WebhookType = z.infer<typeof WebhookType>;

export const WebhookPayload = z.object({
  eventId: z.string(),
  type: WebhookType,
  createdAt: z.string().datetime({ offset: true }),
  data: z.object({
    pspRef: z.string(),
    idempotencyKey: z.string(),
    orderId: z.string(),
    amount: MinorUnits,
    currency: Currency,
    status: ReportedStatus,
  }),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
