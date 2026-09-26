import { z } from "zod";
import { Currency } from "./money.js";

/** One row of GET /statements?since= (CSV). */
export const BankStatementLine = z.object({
  statement_id: z.string(),
  line_no: z.coerce.number().int(),
  psp_ref: z.string(),
  amount: z.coerce.number().int(),
  currency: Currency,
  type: z.literal("CREDIT"),
  credited_at: z.string(),
});
export type BankStatementLine = z.infer<typeof BankStatementLine>;
export const BANK_STATEMENT_CSV_HEADER =
  "statement_id,line_no,psp_ref,amount,currency,type,credited_at";
