import { Order, OrderSide, Position } from "../../api/types.js";
import { BotConfig } from "../../config/loadConfig.js";
import {
  addDecimal,
  clampDecimal,
  compareDecimal,
  decimalToUnits,
  subtractDecimal,
  unitsToDecimal,
} from "../../utils/decimal.js";
import { createId } from "../../utils/ids.js";
import { MarketView, StrategyAction, StrategyContext } from "./types.js";

type PlanQuoteParams = {
  bot: BotConfig;
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  price: string;
  size: string;
  openOrders: Order[];
  totalOpenOrders: Order[];
  now: Date;
  reason: string;
  topPrice: string | null;
  fairPrice: string;
};

export type { MarketView, StrategyAction, StrategyContext } from "./types.js";
export { getStrategyCategory, STRATEGY_CATEGORY_BY_NAME, type StrategyCategory } from "./types.js";

export function buildMarketView(bot: BotConfig, quote: StrategyContext["quote"]): MarketView {
  const bestBid = normalizePrice(bot, quote.bestBid);
  const bestAsk = normalizePrice(bot, quote.bestAsk);
  const fallback = clampPrice(bot, bot.fallbackFairPrice);

  if (bestBid && bestAsk) {
    return {
      fairPrice: midpoint(bestBid, bestAsk),
      bestBid,
      bestAsk,
      midpoint: midpoint(bestBid, bestAsk),
    };
  }

  if (bestBid) {
    const offset = ticksToDecimal(bot.tickSize, Math.max(1, Math.ceil(bot.targetSpreadTicks / 2)));
    const fairPrice = clampPrice(bot, addDecimal(bestBid, offset));
    return {
      fairPrice,
      bestBid,
      bestAsk,
      midpoint: fairPrice,
    };
  }

  if (bestAsk) {
    const offset = ticksToDecimal(bot.tickSize, Math.max(1, Math.ceil(bot.targetSpreadTicks / 2)));
    const fairPrice = clampPrice(bot, subtractDecimal(bestAsk, offset));
    return {
      fairPrice,
      bestBid,
      bestAsk,
      midpoint: fairPrice,
    };
  }

  return {
    fairPrice: fallback,
    bestBid: null,
    bestAsk: null,
    midpoint: fallback,
  };
}

export function normalizePrice(bot: BotConfig, price: string | null): string | null {
  if (!price) {
    return null;
  }
  return clampPrice(bot, roundToNearestTick(price, bot.tickSize));
}

export function clampPrice(bot: BotConfig, price: string): string {
  const bounded = clampDecimal(price, "0.01", "0.99");
  return roundToNearestTick(bounded, bot.tickSize);
}

export function roundToNearestTick(price: string, tickSize: string): string {
  const tickUnits = decimalToUnits(tickSize);
  const priceUnits = decimalToUnits(price);
  const rounded = ((priceUnits + tickUnits / 2n) / tickUnits) * tickUnits;
  return unitsToDecimal(rounded);
}

export function ticksToDecimal(tickSize: string, ticks: number): string {
  return unitsToDecimal(decimalToUnits(tickSize) * BigInt(Math.max(0, ticks)));
}

export function shiftPriceByTicks(price: string, tickSize: string, ticks: number): string {
  if (ticks === 0) {
    return price;
  }
  const delta = ticksToDecimal(tickSize, Math.abs(ticks));
  return ticks > 0 ? addDecimal(price, delta) : subtractDecimal(price, delta);
}

export function midpoint(a: string, b: string): string {
  const sum = decimalToUnits(a) + decimalToUnits(b);
  return unitsToDecimal(sum / 2n);
}

export function sampleTickOffset(bot: BotConfig): number {
  if (bot.quoteOffsetMaxTicks <= bot.quoteOffsetMinTicks) {
    return bot.quoteOffsetMinTicks;
  }

  const span = bot.quoteOffsetMaxTicks - bot.quoteOffsetMinTicks + 1;
  return bot.quoteOffsetMinTicks + Math.floor(Math.random() * span);
}

export function sampleLoopDelayMs(bot: BotConfig): number {
  if (bot.loopIntervalMaxMs <= bot.loopIntervalMinMs) {
    return bot.loopIntervalMinMs;
  }

  const span = bot.loopIntervalMaxMs - bot.loopIntervalMinMs;
  return bot.loopIntervalMinMs + Math.floor(Math.random() * (span + 1));
}

export function planMakerQuote(params: PlanQuoteParams): StrategyAction[] {
  const targetPrice = clampPrice(params.bot, params.price);
  const sameSideOrders = params.openOrders.filter((order) => order.side === params.side);
  const actions: StrategyAction[] = [];
  const keepableOrder = findKeepableQuote({
    bot: params.bot,
    sideOrders: sameSideOrders,
    targetPrice,
    targetSize: params.size,
    topPrice: params.topPrice,
    fairPrice: params.fairPrice,
    now: params.now,
  });

  const staleOrOffMarket = sameSideOrders.filter(
    (order) =>
      order.id !== keepableOrder?.id &&
      shouldCancelWorkingOrder({
        bot: params.bot,
        order,
        desiredPrice: targetPrice,
        topPrice: params.topPrice,
        fairPrice: params.fairPrice,
        now: params.now,
      }),
  );

  for (const order of staleOrOffMarket) {
    actions.push(makeCancelAction(order.id, "stale_order_cleanup", {
      side: order.side,
      existingPrice: order.price,
      desiredPrice: targetPrice,
    }));
  }

  const remainingSameSide = sameSideOrders.filter((order) => !staleOrOffMarket.some((item) => item.id === order.id));
  if (keepableOrder) {
    const overflowOrders = remainingSameSide
      .filter((order) => order.id !== keepableOrder.id)
      .sort(compareOrdersByOldestFirst)
      .slice(Math.max(0, params.bot.maxOrdersPerSide - 1));
    for (const order of overflowOrders) {
      actions.push(makeCancelAction(order.id, "side_order_limit_cleanup", { side: order.side }));
    }
    actions.push(
      makeSkipAction("keep_existing_quote_skip", params.marketId, params.outcomeId, params.side, {
        existingOrderId: keepableOrder.id,
        existingPrice: keepableOrder.price,
        targetPrice,
        existingRemaining: keepableOrder.remaining,
        targetSize: params.size,
        quoteKeepBandTicks: params.bot.dynamicMarketMaker.quoteKeepBandTicks,
        quoteKeepSizeToleranceRatio: params.bot.dynamicMarketMaker.quoteKeepSizeToleranceRatio,
      }),
    );
    return actions;
  }
  const similarOrder = remainingSameSide.find(
    (order) => priceDistanceTicks(order.price, targetPrice, params.bot.tickSize) <= params.bot.replaceThresholdTicks,
  );
  if (similarOrder) {
    actions.push(
      makeSkipAction("near_existing_order_skip", params.marketId, params.outcomeId, params.side, {
        existingPrice: similarOrder.price,
        targetPrice,
        replaceThresholdTicks: params.bot.replaceThresholdTicks,
      }),
    );
    return actions;
  }

  const overflowOrders = remainingSameSide
    .sort(compareOrdersByOldestFirst)
    .slice(Math.max(0, params.bot.maxOrdersPerSide - 1));
  for (const order of overflowOrders) {
    actions.push(makeCancelAction(order.id, "side_order_limit_cleanup", { side: order.side }));
  }

  const projectedOpenOrders =
    params.totalOpenOrders.length - staleOrOffMarket.length - overflowOrders.length + 1;
  if (projectedOpenOrders > params.bot.maxOpenOrders) {
    actions.push(
      makeSkipAction("at_total_open_order_cap_skip", params.marketId, params.outcomeId, params.side, {
        totalOpenOrders: params.totalOpenOrders.length,
        projectedOpenOrders,
        maxOpenOrders: params.bot.maxOpenOrders,
      }),
    );
    return actions;
  }

  actions.push(
    makePlaceAction({
      bot: params.bot,
      reason: params.reason,
      side: params.side,
      marketId: params.marketId,
      outcomeId: params.outcomeId,
      price: targetPrice,
      size: params.size,
    }),
  );
  return actions;
}

export function maxAffordableBuySize(maxOrderSize: string, availableUSDC: string, price: string): string {
  const safePrice = compareDecimal(price, "0.000001") <= 0 ? "0.000001" : price;
  const sizeUnits = (decimalToUnits(availableUSDC) * 1_000_000n) / decimalToUnits(safePrice);
  const affordable = unitsToDecimal(sizeUnits);
  return compareDecimal(affordable, maxOrderSize) < 0 ? affordable : maxOrderSize;
}

export function capToSize(value: string, cap: string): string {
  return compareDecimal(value, cap) < 0 ? value : cap;
}

export function getPosition(positions: Position[], marketId: string, outcomeId: string): Position | undefined {
  return positions.find((position) => position.marketId === marketId && position.outcomeId === outcomeId);
}

export function getAvailableShares(positions: Position[], marketId: string, outcomeId: string): string {
  const position = getPosition(positions, marketId, outcomeId);
  if (!position) {
    return "0.000000";
  }

  const availableUnits = decimalToUnits(position.shares) - decimalToUnits(position.reservedShares);
  return availableUnits > 0n ? unitsToDecimal(availableUnits) : "0.000000";
}

export function inventorySkewTicks(bot: BotConfig, marketId: string, outcomeId: string, positions: Position[]): number {
  const position = getPosition(positions, marketId, outcomeId);
  const shares = position ? position.shares : "0";
  const maxUnits = decimalToUnits(bot.maxPositionShares);
  if (maxUnits <= 0n) {
    return 0;
  }

  const currentUnits = decimalToUnits(shares);
  const targetUnits = decimalToUnits(bot.inventoryTargetShares);
  const deviation = Number(currentUnits - targetUnits) / Number(maxUnits);
  return Math.round(deviation * bot.inventorySkewStrength);
}

export function canBuyMore(bot: BotConfig, marketId: string, outcomeId: string, positions: Position[]): boolean {
  const position = getPosition(positions, marketId, outcomeId);
  const shares = position ? position.shares : "0";
  return decimalToUnits(shares) < decimalToUnits(bot.maxPositionShares);
}

export function shouldTakeLiquidity(
  bot: BotConfig,
  side: OrderSide,
  view: MarketView,
  inventoryBiasTicks: number,
): boolean {
  if (Math.random() >= bot.takerProbability) {
    return false;
  }

  if (side === "BUY" && view.bestAsk) {
    const threshold = shiftPriceByTicks(view.fairPrice, bot.tickSize, bot.takerThresholdTicks + inventoryBiasTicks);
    return compareDecimal(view.bestAsk, threshold) <= 0;
  }

  if (side === "SELL" && view.bestBid) {
    const threshold = shiftPriceByTicks(view.fairPrice, bot.tickSize, -(bot.takerThresholdTicks - inventoryBiasTicks));
    return compareDecimal(view.bestBid, threshold) >= 0;
  }

  return false;
}

export function makerBidPrice(bot: BotConfig, view: MarketView, inventoryBiasTicks: number): string {
  const halfSpreadTicks = Math.max(1, Math.floor(bot.targetSpreadTicks / 2));
  const offsetTicks = halfSpreadTicks + sampleTickOffset(bot) + Math.max(0, inventoryBiasTicks);
  const fairAnchored = shiftPriceByTicks(view.fairPrice, bot.tickSize, -offsetTicks);
  const topImprovement = view.bestBid ? shiftPriceByTicks(view.bestBid, bot.tickSize, 1) : fairAnchored;
  const target = view.bestBid
    ? minPrice(topImprovement, shiftPriceByTicks(view.fairPrice, bot.tickSize, -1))
    : fairAnchored;
  return clampPrice(bot, minPrice(target, fairAnchored));
}

export function makerAskPrice(bot: BotConfig, view: MarketView, inventoryBiasTicks: number): string {
  const halfSpreadTicks = Math.max(1, Math.floor(bot.targetSpreadTicks / 2));
  const offsetTicks = halfSpreadTicks + sampleTickOffset(bot) + Math.max(0, -inventoryBiasTicks);
  const fairAnchored = shiftPriceByTicks(view.fairPrice, bot.tickSize, offsetTicks);
  const topImprovement = view.bestAsk ? shiftPriceByTicks(view.bestAsk, bot.tickSize, -1) : fairAnchored;
  const target = view.bestAsk
    ? maxPrice(topImprovement, shiftPriceByTicks(view.fairPrice, bot.tickSize, 1))
    : fairAnchored;
  return clampPrice(bot, maxPrice(target, fairAnchored));
}

export function sizeForMaker(bot: BotConfig, balance: StrategyContext["balance"], price: string): string {
  return maxAffordableBuySize(bot.maxOrderSize, balance.availableUSDC, price);
}

export function sizeForTaker(bot: BotConfig, balance: StrategyContext["balance"], price: string): string {
  const maxTaker = capToSize(bot.maxOrderSize, bot.maxTakerSize);
  return maxAffordableBuySize(maxTaker, balance.availableUSDC, price);
}

export function buildStateSnapshot(context: StrategyContext) {
  const view = buildMarketView(context.bot, context.quote);
  return {
    view,
    inventoryBiasTicks: inventorySkewTicks(
      context.bot,
      context.marketId,
      context.quote.outcomeId,
      context.positions,
    ),
    availableShares: getAvailableShares(context.positions, context.marketId, context.quote.outcomeId),
  };
}

export function collectStaleCleanupActions(context: StrategyContext): StrategyAction[] {
  const { bot, marketId, quote, outcomeOpenOrders, now } = context;
  const { view, inventoryBiasTicks } = buildStateSnapshot(context);
  const buyTargetPrice = makerBidPrice(bot, view, inventoryBiasTicks);
  const sellTargetPrice = makerAskPrice(bot, view, inventoryBiasTicks);

  return outcomeOpenOrders.flatMap((order) => {
    const desiredPrice = order.side === "BUY" ? buyTargetPrice : sellTargetPrice;
    const topPrice = order.side === "BUY" ? view.bestBid : view.bestAsk;
    if (
      shouldCancelWorkingOrder({
        bot,
        order,
        desiredPrice,
        topPrice,
        fairPrice: view.fairPrice,
        now,
      })
    ) {
      return [
        makeCancelAction(order.id, "stale_order_cleanup", {
          side: order.side,
          existingPrice: order.price,
          desiredPrice,
        }),
      ];
    }

    return [];
  });
}

export function makeSkipAction(
  reason: string,
  marketId: string,
  outcomeId: string,
  side?: OrderSide,
  details?: Record<string, unknown>,
): StrategyAction {
  return {
    type: "skip",
    reason,
    marketId,
    outcomeId,
    ...(side ? { side } : {}),
    ...(details ? { details } : {}),
  };
}

export function makeCancelAction(orderId: string, reason: string, details?: Record<string, unknown>): StrategyAction {
  return {
    type: "cancel",
    reason,
    orderId,
    ...(details ? { details } : {}),
  };
}

export function makePlaceAction(params: {
  bot: BotConfig;
  reason: string;
  side: OrderSide;
  marketId: string;
  outcomeId: string;
  price: string;
  size: string;
  details?: Record<string, unknown>;
}): StrategyAction {
  const id = createId(`${params.bot.name}-${params.side.toLowerCase()}`);
  return {
    type: "place",
    reason: params.reason,
    side: params.side,
    marketId: params.marketId,
    outcomeId: params.outcomeId,
    price: params.price,
    size: params.size,
    idempotencyKey: id,
    clientOrderId: id,
    ...(params.details ? { details: params.details } : {}),
  };
}

function shouldCancelWorkingOrder(params: {
  bot: BotConfig;
  order: Order;
  desiredPrice: string;
  topPrice: string | null;
  fairPrice: string;
  now: Date;
}): boolean {
  let ageMs: number | null = null;
  if (params.order.createdAt) {
    ageMs = params.now.getTime() - new Date(params.order.createdAt).getTime();
  }

  const desiredDistanceTicks = priceDistanceTicks(params.order.price, params.desiredPrice, params.bot.tickSize);
  const topDistanceTicks = params.topPrice
    ? priceDistanceTicks(params.order.price, params.topPrice, params.bot.tickSize)
    : 0;
  const fairDistanceTicks = priceDistanceTicks(params.order.price, params.fairPrice, params.bot.tickSize);
  const protectedLifetime =
    ageMs !== null &&
    ageMs < params.bot.minQuoteLifetimeMs &&
    desiredDistanceTicks <= params.bot.staleDistanceTicks + params.bot.replaceThresholdTicks &&
    topDistanceTicks <= params.bot.staleDistanceTicks + 1 &&
    fairDistanceTicks <= params.bot.staleDistanceTicks + params.bot.targetSpreadTicks + 1;

  if (protectedLifetime) {
    return false;
  }

  const staleByAge = ageMs !== null && ageMs >= params.bot.staleOrderMs;
  const hardExpiry = ageMs !== null && ageMs >= params.bot.staleOrderMs * 3;
  if (hardExpiry) {
    return true;
  }

  if (desiredDistanceTicks > params.bot.staleDistanceTicks) {
    return true;
  }

  if (params.topPrice) {
    if (topDistanceTicks > params.bot.staleDistanceTicks) {
      return true;
    }
  }

  if (fairDistanceTicks > params.bot.staleDistanceTicks + params.bot.targetSpreadTicks) {
    return true;
  }

  if (!staleByAge) {
    return false;
  }

  return (
    desiredDistanceTicks > params.bot.replaceThresholdTicks ||
    topDistanceTicks > params.bot.replaceThresholdTicks + 1 ||
    fairDistanceTicks > params.bot.targetSpreadTicks + params.bot.replaceThresholdTicks + 1
  );
}

function findKeepableQuote(params: {
  bot: BotConfig;
  sideOrders: Order[];
  targetPrice: string;
  targetSize: string;
  topPrice: string | null;
  fairPrice: string;
  now: Date;
}): Order | null {
  const keepBandTicks = Math.max(0, params.bot.dynamicMarketMaker.quoteKeepBandTicks ?? 0);
  const sizeToleranceRatio = Math.max(0, params.bot.dynamicMarketMaker.quoteKeepSizeToleranceRatio ?? 0);
  if (keepBandTicks <= 0 && sizeToleranceRatio <= 0) {
    return null;
  }

  const candidates = params.sideOrders
    .filter(
      (order) =>
        !shouldCancelWorkingOrder({
          bot: params.bot,
          order,
          desiredPrice: params.targetPrice,
          topPrice: params.topPrice,
          fairPrice: params.fairPrice,
          now: params.now,
        }),
    )
    .filter((order) => priceDistanceTicks(order.price, params.targetPrice, params.bot.tickSize) <= keepBandTicks)
    .filter((order) => withinSizeTolerance(order.remaining, params.targetSize, sizeToleranceRatio))
    .sort(compareOrdersByClosestMatch);

  return candidates[0] ?? null;
}

function withinSizeTolerance(existingSize: string, targetSize: string, toleranceRatio: number): boolean {
  if (toleranceRatio <= 0) {
    return compareDecimal(existingSize, targetSize) === 0;
  }
  const existing = Number(existingSize);
  const target = Number(targetSize);
  if (!Number.isFinite(existing) || !Number.isFinite(target)) {
    return false;
  }
  const scale = Math.max(existing, target, 0.000001);
  return Math.abs(existing - target) / scale <= toleranceRatio;
}

function compareOrdersByClosestMatch(a: Order, b: Order): number {
  const aRemaining = Number(a.remaining);
  const bRemaining = Number(b.remaining);
  if (Number.isFinite(aRemaining) && Number.isFinite(bRemaining) && aRemaining !== bRemaining) {
    return bRemaining - aRemaining;
  }
  return compareOrdersByOldestFirst(a, b);
}

function priceDistanceTicks(a: string, b: string, tickSize: string): number {
  const diff = decimalToUnits(a) - decimalToUnits(b);
  const ticks = absBigInt(diff) / decimalToUnits(tickSize);
  return Number(ticks);
}

function compareOrdersByOldestFirst(a: Order, b: Order): number {
  const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return aTime - bTime;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function minPrice(a: string, b: string): string {
  return compareDecimal(a, b) <= 0 ? a : b;
}

function maxPrice(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? a : b;
}

export function minDecimal(a: string, b: string): string {
  return minPrice(a, b);
}

export function maxDecimal(a: string, b: string): string {
  return maxPrice(a, b);
}
