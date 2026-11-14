/**
 * Turns money as people type it ("$1,500", "2431.07", "-12.40") into a canonical
 * decimal string for Prisma's Decimal columns. Strings only, so no amount ever
 * passes through floating point. At most two decimal places and 15 whole digits
 * (what Decimal(19, 4) holds); thousands separators must be real groups of three.
 */

const PLAIN = /^\d{1,15}(\.\d{1,2})?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

export function parseMoney(input: string, options: { allowNegative: boolean }): string | null {
  let text = input.trim();
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith("$")) text = text.slice(1);
  if (!PLAIN.test(text) && !GROUPED.test(text)) return null;

  const digits = text.replace(/,/g, "");
  if (digits.split(".")[0].length > 15) return null;
  const normalised = digits.replace(/^0+(?=\d)/, "");
  const isZero = /^0(\.0{1,2})?$/.test(normalised);
  if (negative && !isZero && !options.allowNegative) return null;
  return negative && !isZero ? `-${normalised}` : isZero ? "0" : normalised;
}
