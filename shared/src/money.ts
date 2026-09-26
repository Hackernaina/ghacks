import { z } from "zod";

/** Integer minor units (paise). Never a float. */
export const MinorUnits = z.number().int();
export type MinorUnits = z.infer<typeof MinorUnits>;

export const Currency = z.string().length(3);
export type Currency = z.infer<typeof Currency>;
