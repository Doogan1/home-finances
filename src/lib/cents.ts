/**
 * Exact money arithmetic in whole cents. Amounts arrive as decimal strings
 * (from parseMoney, or Prisma's Decimal(19, 4) via toFixed()), become BigInt
 * cents, and leave as decimal strings, so nothing passes through floating point.
 */

export type Cents = bigint;

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;
const PERCENT = /^(\d+)(?:\.(\d{1,4}))?$/;

export function toCents(amount: string): Cents {
  const match = DECIMAL.exec(amount.trim());
  if (!match) throw new RangeError(`Not a decimal amount: ${amount}`);
  const fraction = (match[3] ?? "").padEnd(4, "0");
  if (fraction.slice(2) !== "00") throw new RangeError(`More than two decimal places: ${amount}`);
  const cents = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2));
  return match[1] === "-" ? -cents : cents;
}

export function fromCents(cents: Cents): string {
  const negative = cents < 0n;
  const size = negative ? -cents : cents;
  const fraction = (size % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${size / 100n}.${fraction}`;
}

/** `percent` (such as "70" or "12.5", up to 4 decimals) of an amount, rounded half up to the cent. */
export function percentOf(cents: Cents, percent: string): Cents {
  const match = PERCENT.exec(percent.trim());
  if (!match || cents < 0n) throw new RangeError(`Cannot take ${percent}% of ${cents}`);
  // The percentage in ten-thousandths of a percent, so 12.5% is 125000.
  const scaled = BigInt(match[1]) * 10000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  // cents × percent / 100 = cents × scaled / 1,000,000; adding half the divisor rounds half up.
  return (cents * scaled + 500000n) / 1000000n;
}
