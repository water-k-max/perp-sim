/**
 *  Integer square root and fixed-point helpers.
 *
 *  Ratios (Sharpe, Sortino, drawdown) are reported in basis points of their own scale so a
 *  reader never sees a float drift between two runs over the same data. Everything here is
 *  exact integer arithmetic with a documented floor.
 */

/** Floor integer square root of a non-negative bigint, by Newton's method. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** `floor(sqrt(x) * scale)`, computed exactly as `isqrt(x * scale^2)`. */
export function sqrtScaled(x: bigint, scale: bigint): bigint {
  if (x < 0n) throw new Error("sqrtScaled of a negative number");
  return isqrt(x * scale * scale);
}

/** Basis points, rounded toward zero, or null when the base is zero. */
export function bps(part: bigint, base: bigint): bigint | null {
  return base === 0n ? null : (part * 10_000n) / base;
}

/** A bigint ratio rendered as a decimal string with `places` digits, for the API edge. */
export function toDecimal(value: bigint, scale: bigint, places = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const fraction = ((abs % scale) * 10n ** BigInt(places)) / scale;
  const text = `${whole}.${fraction.toString().padStart(places, "0")}`;
  return negative ? `-${text}` : text;
}
