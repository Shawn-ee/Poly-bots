/**
 * Lightweight reference arbitrage observer for poly-reference-arb.service.
 * Monitors reference prices vs local quotes and logs actionable mispricings.
 * Does NOT place orders — the actual arb runs inside the market-maker orchestrator.
 */
const BASE_URL = process.env.POLY_BASE_URL?.trim() || "http://127.0.0.1:3001";
const POLL_MS = parseInt(process.env.ARB_OBSERVER_POLL_MS ?? "30000", 10);
const THRESHOLD_TICKS = parseInt(process.env.ARB_OBSERVER_THRESHOLD_TICKS ?? "4", 10);
const TICK_SIZE = 0.01;

const REFERENCE_MARKET_IDS = [
  "1f72f326-5bd9-46db-84a3-4a558749b8a1",
  "01a2fa6c-c8bc-404b-a2f1-b627f08c52dc",
  "b77559ac-f0cd-442b-b758-3a16f21fa05e",
  "bf4fdd37-f983-4808-8d7e-a6e58ab7165d",
  "fb6e2704-90e1-48f2-bce4-8c3bd472fc08",
  "6ed2ffd1-9f95-448c-af6e-c12b5936567b",
  "a9cfd101-6cfb-4458-bb0b-b03d29d1dcb7",
  "1305f62a-d0fc-4d02-a3e2-1827f07f4899",
  "7131decd-f7bc-465b-b27d-42401a0834fc",
];

async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "arb_observer_started",
    baseUrl: BASE_URL,
    pollMs: POLL_MS,
    thresholdTicks: THRESHOLD_TICKS,
    marketsWatched: REFERENCE_MARKET_IDS.length,
  }));

  while (true) {
    let checked = 0;
    let actionable = 0;

    for (const marketId of REFERENCE_MARKET_IDS) {
      try {
        const [refData, localQuote] = await Promise.all([
          fetchJson(`${BASE_URL}/api/markets/${marketId}/reference`),
          fetchJson(`${BASE_URL}/api/markets/${marketId}/quote`),
        ]);

        const refBid = refData?.referenceBid ?? refData?.gammaBestBid;
        const refAsk = refData?.referenceAsk ?? refData?.gammaBestAsk;
        if (!refBid || !refAsk || refData?.isFresh === false) continue;
        if (refData?.qualityStatus && refData.qualityStatus !== "high_quality") continue;

        const quotes = localQuote?.quotes ?? [];
        const yesQuote = quotes.find((q: { outcomeName?: string }) =>
          q.outcomeName?.trim().toUpperCase() === "YES"
        ) ?? quotes[0];

        if (yesQuote?.bestBid && yesQuote?.bestAsk) {
          const localMid = (Number(yesQuote.bestBid) + Number(yesQuote.bestAsk)) / 2;
          const refMid = (Number(refBid) + Number(refAsk)) / 2;
          const tickDelta = Math.abs(refMid - localMid) / TICK_SIZE;

          checked++;
          if (tickDelta >= THRESHOLD_TICKS) {
            actionable++;
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              event: "arb_opportunity_observed",
              marketId,
              localMid: localMid.toFixed(4),
              refMid: refMid.toFixed(4),
              tickDelta: tickDelta.toFixed(1),
              refBid: String(refBid),
              refAsk: String(refAsk),
              localBid: yesQuote.bestBid,
              localAsk: yesQuote.bestAsk,
            }));
          }
        }
      } catch {
        // Market fetch failed — skip
      }
    }

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "arb_observer_cycle",
      marketsChecked: checked,
      actionableOpportunities: actionable,
    }));

    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("Reference arb observer failed:", error);
  process.exitCode = 1;
});
