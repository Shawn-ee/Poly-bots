import { BotControlFileStore, BotRuntimeState } from "../src/runner/botControlFile.js";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new BotControlFileStore();

  if (args.clear) {
    store.clear({
      ...(args.bot ? { botName: args.bot } : {}),
      ...(args.allSystemLiquidity ? { systemLiquidity: true } : {}),
    });
    console.log(JSON.stringify({ ok: true, action: "cleared", file: store.getPath() }, null, 2));
    return;
  }

  if (!args.state) {
    throw new Error("Missing --state running|paused|reduce_only|emergency_stop.");
  }
  if (!args.bot && !args.allSystemLiquidity) {
    throw new Error("Specify --bot <name> or --all-system-liquidity.");
  }

  store.write({
    ...(args.bot ? { botName: args.bot } : {}),
    ...(args.allSystemLiquidity ? { systemLiquidity: true } : {}),
    state: args.state,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.cancelOpenOrders !== null ? { cancelOpenOrders: args.cancelOpenOrders } : {}),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        file: store.getPath(),
        bot: args.bot ?? null,
        allSystemLiquidity: args.allSystemLiquidity,
        state: args.state,
        reason: args.reason ?? null,
        cancelOpenOrders: args.cancelOpenOrders,
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv: string[]) {
  const result: {
    bot: string | null;
    allSystemLiquidity: boolean;
    state: BotRuntimeState | null;
    reason: string | null;
    cancelOpenOrders: boolean | null;
    clear: boolean;
  } = {
    bot: null,
    allSystemLiquidity: false,
    state: null,
    reason: null,
    cancelOpenOrders: null,
    clear: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bot") {
      result.bot = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--all-system-liquidity") {
      result.allSystemLiquidity = true;
      continue;
    }
    if (arg === "--state") {
      const next = argv[i + 1] ?? "";
      if (
        next === "running" ||
        next === "paused" ||
        next === "reduce_only" ||
        next === "emergency_stop"
      ) {
        result.state = next;
      } else {
        throw new Error(`Unsupported state: ${next}`);
      }
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      result.reason = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--cancel-open-orders") {
      const next = (argv[i + 1] ?? "").toLowerCase();
      result.cancelOpenOrders = next === "true";
      i += 1;
      continue;
    }
    if (arg === "--clear") {
      result.clear = true;
      continue;
    }
  }

  return result;
}

main();
