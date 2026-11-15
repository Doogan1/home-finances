import { z } from "zod";

/**
 * The person's answers to the importer's questions, from `imports/choices.json`.
 * A strict object: an unknown section is refused, never ignored. Whether each
 * key and value names something real in the workbook is checked by the planner.
 *
 *   {
 *     "cards":    { "<bill id>": "<card Account ID>" },          // Included in card payment: which card
 *     "pays":     { "<bill id>": "<card Account ID>" | null },   // a card-payment bill: the card it pays, or none
 *     "schedule": { "<Bill Schedule ID>": "skip" | "confirm" | "rule" }
 *   }
 */

export const SCHEDULE_ANSWERS = ["skip", "confirm", "rule"] as const;
export type ScheduleAnswer = (typeof SCHEDULE_ANSWERS)[number];

const key = z.string().trim().min(1).max(60);
const accountId = z.string().trim().min(1).max(40);

export const choicesInput = z
  .strictObject({
    cards: z.record(key, accountId).optional(),
    pays: z.record(key, accountId.nullable()).optional(),
    schedule: z.record(key, z.enum(SCHEDULE_ANSWERS)).optional(),
  })
  .transform((input) => ({ cards: input.cards ?? {}, pays: input.pays ?? {}, schedule: input.schedule ?? {} }));
export type Choices = z.infer<typeof choicesInput>;

export const NO_CHOICES: Choices = { cards: {}, pays: {}, schedule: {} };

export type ParsedChoices = { ok: true; choices: Choices } | { ok: false; problems: string[] };

/** Reads choices.json's text; every problem names where in the file it is. */
export function parseChoices(text: string): ParsedChoices {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, problems: ["choices.json is not valid JSON"] };
  }
  const parsed = choicesInput.safeParse(json);
  if (parsed.success) return { ok: true, choices: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => `choices.json ${issue.path.join(".") || "(top level)"}: ${issue.message}`),
  };
}
