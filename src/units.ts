/**
 *  Decimal <-> raw conversions that never route a protocol quantity through a float.
 *  `oneBase` spans 1e6..1e24 across the live pools, so float rounding is not a rounding
 *  error here — it changes an order quantity.
 */
export function toRaw(whole: string | number, decimals: number): bigint {
  const text = String(whole).trim();
  const neg = text.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? text.slice(1) : text).split(".");
  if (intPart === "" && fracPart === "") throw new Error(`not a number: ${text}`);
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(padded)) throw new Error(`not a decimal number: ${text}`);
  const base = BigInt(intPart === "" ? "0" : intPart) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return neg ? -base : base;
}

export function fromRaw(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}.${frac.replace(/0+$/, "") || "0"}`;
}

export const utc = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16);
