import { ApiClient } from "../api/apiClient.js";
import { BotConfig, loadConfig } from "../config/loadConfig.js";
import { normalizeLocalReferenceMarket } from "../referenceMarket/localReferenceMarkets.js";
import { ReferenceAwareSystemLiquidityBot } from "./referenceAwareSystemLiquidityBot.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const referenceBots = config.bots.filter((bot) => bot.strategy === "referenceAwareSystemLiquidity");
  if (referenceBots.length === 0) {
    throw new Error("No referenceAwareSystemLiquidity bots are configured.");
  }

  const selected = await selectBot(referenceBots, args.slug, args.botName);
  if (!selected) {
    throw new Error(
      args.slug
        ? `No configured referenceAwareSystemLiquidity bot covers slug ${args.slug}.`
        : "No matching referenceAwareSystemLiquidity bot found.",
    );
  }

  const runner = new ReferenceAwareSystemLiquidityBot(
    {
      ...selected.bot,
      marketIds: selected.marketIds,
      referenceAwareSystemLiquidity: {
        ...selected.bot.referenceAwareSystemLiquidity,
        dryRun: true,
      },
    },
    `${process.cwd()}\\logs`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.durationSeconds * 1000);

  try {
    console.log(
      JSON.stringify(
        {
          bot: selected.bot.name,
          marketIds: selected.marketIds,
          slug: args.slug ?? null,
          durationSeconds: args.durationSeconds,
          dryRun: true,
        },
        null,
        2,
      ),
    );
    await runner.run(controller.signal);
  } finally {
    clearTimeout(timer);
    runner.shutdown();
  }
}

async function selectBot(
  bots: BotConfig[],
  slug: string | null,
  botName: string | null,
): Promise<{ bot: BotConfig; marketIds: string[] } | null> {
  const filteredBots = botName ? bots.filter((bot) => bot.name === botName) : bots;
  for (const bot of filteredBots) {
    if (!slug) {
      return { bot, marketIds: bot.marketIds };
    }

    const api = new ApiClient(bot.baseUrl, bot.apiKey);
    const matchingMarketIds: string[] = [];
    for (const marketId of bot.marketIds) {
      try {
        const response = await api.getMarket(marketId);
        const market = normalizeLocalReferenceMarket(response);
        if (market.externalSlug === slug) {
          matchingMarketIds.push(marketId);
        }
      } catch {
        continue;
      }
    }

    if (matchingMarketIds.length > 0) {
      return { bot, marketIds: matchingMarketIds };
    }
  }

  return null;
}

function parseArgs(args: string[]) {
  const getValue = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] ?? null : null;
  };

  return {
    slug: getValue("--slug"),
    botName: getValue("--bot"),
    durationSeconds: Number(getValue("--durationSeconds") ?? "60"),
  };
}

main().catch((error) => {
  console.error("reference-aware dry-run failed", error);
  process.exitCode = 1;
});
