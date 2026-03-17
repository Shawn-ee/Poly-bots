const DEFAULT_SCALE = 6n;

export function decimalToUnits(value: string, scale: bigint = DEFAULT_SCALE): bigint {
  const normalized = value.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");

  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(fraction)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }

  const paddedFraction = (fraction + "0".repeat(Number(scale))).slice(0, Number(scale));
  const units = BigInt(whole || "0") * 10n ** scale + BigInt(paddedFraction || "0");
  return negative ? -units : units;
}

export function unitsToDecimal(units: bigint, scale: bigint = DEFAULT_SCALE): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const base = 10n ** scale;
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(Number(scale), "0");
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${trimmed ? `.${trimmed}` : ""}`;
}

export function addDecimal(a: string, b: string): string {
  return unitsToDecimal(decimalToUnits(a) + decimalToUnits(b));
}

export function subtractDecimal(a: string, b: string): string {
  return unitsToDecimal(decimalToUnits(a) - decimalToUnits(b));
}

export function multiplyDecimal(a: string, b: string, scale: bigint = DEFAULT_SCALE): string {
  const product = (decimalToUnits(a, scale) * decimalToUnits(b, scale)) / 10n ** scale;
  return unitsToDecimal(product, scale);
}

export function compareDecimal(a: string, b: string): number {
  const left = decimalToUnits(a);
  const right = decimalToUnits(b);
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

export function clampDecimal(value: string, min: string, max: string): string {
  if (compareDecimal(value, min) < 0) {
    return min;
  }
  if (compareDecimal(value, max) > 0) {
    return max;
  }
  return value;
}
