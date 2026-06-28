import { createDefaultAgentContext, runResolutionReviewAgent } from "../src/agents/index.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const context = createDefaultAgentContext("resolutionReview", "reviewOnly", {
    runId: `resolution_proposal_${Date.now()}`,
    dryRun: true,
  });
  const result = await runResolutionReviewAgent(context, {
    marketId: options.marketId ?? "unspecified",
    marketTitle: options.marketTitle ?? "Unspecified market",
    candidateWinningOutcomeId: options.outcomeId,
    evidence: options.evidence,
    confidence: options.confidence,
    approvedByAdmin: false,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const next = argv[index + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "true");
  }
  return {
    marketId: stringArg(args.get("marketId")),
    marketTitle: stringArg(args.get("marketTitle")),
    outcomeId: stringArg(args.get("outcomeId")),
    confidence: numberArg(args.get("confidence"), 0),
    evidence: (args.get("evidence") ?? "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function numberArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}

main().catch((error) => {
  console.error("Resolution proposal bot failed.");
  console.error(error);
  process.exitCode = 1;
});
