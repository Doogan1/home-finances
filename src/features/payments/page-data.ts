import "server-only";
import { getPlaidEnvironment } from "@/features/plaid/environment";
import { addDays, type IsoDate } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";
import { paymentsDiffer, type Differs } from "./differ";
import { loadMatchState, matchQuestions, toLayerPayment, type MatchQuestion } from "./queries";

/** The pages ask about transactions from the last this-many days; older ones can still be matched from their own page. */
export const QUESTION_DAYS = 100;

export type PaymentAttention = { questions: MatchQuestion[]; differ: Differs[] };

/** What Home and Transactions call out about payments: matches to confirm, and fixed bills whose payments say otherwise. */
export async function loadPaymentAttention(householdId: string, today: IsoDate): Promise<PaymentAttention> {
  const state = await loadMatchState(getDb(), householdId, {
    environment: getPlaidEnvironment(),
    today,
    since: addDays(today, -QUESTION_DAYS),
  });
  return { questions: matchQuestions(state), differ: paymentsDiffer(state.rules, state.payments.map(toLayerPayment), today) };
}
