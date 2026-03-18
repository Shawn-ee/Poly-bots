import { SimMarketTemplate } from "./types.js";

const MATCHUPS = [
  ["Red Team", "Blue Team"],
  ["North Squad", "South Squad"],
  ["Falcons", "Wolves"],
  ["Orbit", "Comets"],
];

const THRESHOLD_SERIES = [
  { subject: "Value X", thresholds: [42, 50, 58, 64] },
  { subject: "Signal Y", thresholds: [10, 15, 20, 25] },
  { subject: "Metric Z", thresholds: [70, 75, 80, 85] },
];

const EVENT_PAIRS = [
  ["Checkpoint Alpha", "Checkpoint Beta"],
  ["Event A", "Event B"],
  ["Launch Window 1", "Launch Window 2"],
  ["Milestone North", "Milestone South"],
];

export const marketTemplates: SimMarketTemplate[] = [
  {
    type: "head_to_head",
    buildVariant(index) {
      const matchup = at(MATCHUPS, index % MATCHUPS.length);
      const [teamA, teamB] = matchup;
      return {
        title: `Will ${teamA} beat ${teamB}?`,
        description: `Simulated head-to-head market for ${teamA} versus ${teamB}.`,
        marketType: "BINARY",
      };
    },
  },
  {
    type: "threshold_check",
    buildVariant(index) {
      const series = at(THRESHOLD_SERIES, index % THRESHOLD_SERIES.length);
      const threshold = at(
        series.thresholds,
        Math.floor(index / THRESHOLD_SERIES.length) % series.thresholds.length,
      );
      return {
        title: `Will ${series.subject} exceed ${threshold}?`,
        description: `Simulated threshold market tracking whether ${series.subject} finishes above ${threshold}.`,
        marketType: "BINARY",
      };
    },
  },
  {
    type: "event_ordering",
    buildVariant(index) {
      const eventPair = at(EVENT_PAIRS, index % EVENT_PAIRS.length);
      const [eventA, eventB] = eventPair;
      return {
        title: `Will ${eventA} happen before ${eventB}?`,
        description: `Simulated ordering market comparing ${eventA} against ${eventB}.`,
        marketType: "BINARY",
      };
    },
  },
];

function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Template index out of range: ${index}`);
  }
  return value;
}
