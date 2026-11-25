/**
 * Who a bank transaction was with, reduced to a key that stays the same from
 * one month to the next: lower case, punctuation gone, and every word with a
 * digit in it dropped (reference numbers, dates, store numbers). Pure.
 */

export function payeeKey(merchantName: string | null, description: string): string {
  const source = merchantName?.trim() ? merchantName : description;
  const words = source
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 1 && !/\p{N}/u.test(word));
  // A description that is nothing but numbers still needs a key of its own.
  return words.length > 0 ? words.join(" ") : source.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Words too common in bill names to mean anything about who was paid. */
const COMMON = new Set(["the", "and", "for", "bill", "bills", "pay", "payment", "payments", "inc", "llc", "company", "monthly", "account"]);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ");

/** True when the rule's name and the payee share a word of three letters or more. */
export function sharesWord(ruleName: string, key: string): boolean {
  const inKey = new Set(words(key));
  return words(ruleName).some((word) => word.length >= 3 && !COMMON.has(word) && inKey.has(word));
}
