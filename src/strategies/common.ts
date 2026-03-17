import { Order, OrderSide } from "../api/types.js";
export function isOrderStale(order: Order, staleMs: number, now: Date): boolean {
  if (!order.createdAt) {
    return false;
  }
  return now.getTime() - new Date(order.createdAt).getTime() >= staleMs;
}

export function getStaleOrders(orders: Order[], staleMs: number, now: Date): Order[] {
  return orders.filter((order) => isOrderStale(order, staleMs, now));
}

export function countOrdersForSide(orders: Order[], side: OrderSide): number {
  return orders.filter((order) => order.side === side).length;
}

export function countNearPriceOrders(
  orders: Order[],
  side: OrderSide,
  targetPrice: string,
  tickSize: string,
  similarOrderTicks: number,
): number {
  const maxDistance = decimalToUnits(tickSize) * BigInt(similarOrderTicks);
  const targetUnits = decimalToUnits(targetPrice);

  return orders.filter((order) => {
    if (order.side !== side) {
      return false;
    }

    const distance = absBigInt(decimalToUnits(order.price) - targetUnits);
    return distance <= maxDistance;
  }).length;
}

function decimalToUnits(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const normalized = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const whole = BigInt(wholePart || "0");
  const fractional = BigInt((fractionalPart + "000000").slice(0, 6) || "0");
  const units = whole * 1_000_000n + fractional;
  return negative ? -units : units;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}
