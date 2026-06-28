import fs from "node:fs";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };

function main() {
  const runtimeDir = path.resolve(process.cwd(), ".runtime");
  const runtimeFiles = fs.existsSync(runtimeDir)
    ? fs.readdirSync(runtimeDir).filter((name) => name.startsWith("reference-liquidity-"))
    : [];
  const scripts = packageJson.scripts as Record<string, string>;
  const finalScripts = Object.fromEntries(
    Object.entries(scripts).filter(([name]) =>
      [
        "bot:polymarket:discover",
        "bot:polymarket:reference-sync",
        "bot:polymarket:mm:dry-run",
        "bot:polymarket:mm:live-local",
        "bot:risk:stale-quotes",
        "bot:resolution:proposal",
        "bot:ops:report",
      ].includes(name),
    ),
  );

  console.log(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    runtimeRecords: runtimeFiles,
    finalBotScripts: finalScripts,
    safety: {
      noPolymarketOrderPlacement: true,
      productionDeploy: false,
      realMoneyMode: false,
      cryptoPayoutSigning: false,
    },
  }, null, 2));
}

main();
