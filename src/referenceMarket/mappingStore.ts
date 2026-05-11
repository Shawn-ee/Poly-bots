import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReferenceMarketMapping } from "./types.js";

export async function readReferenceMappings(filePath: string): Promise<ReferenceMarketMapping[]> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    return Array.isArray(parsed) ? (parsed as ReferenceMarketMapping[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeReferenceMappings(
  filePath: string,
  mappings: ReferenceMarketMapping[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(mappings, null, 2)}\n`, "utf8");
}

export function upsertReferenceMappings(
  current: ReferenceMarketMapping[],
  next: ReferenceMarketMapping[],
): ReferenceMarketMapping[] {
  const index = new Map<string, ReferenceMarketMapping>();
  for (const mapping of current) {
    index.set(mappingKey(mapping), mapping);
  }
  for (const mapping of next) {
    index.set(mappingKey(mapping), mapping);
  }
  return Array.from(index.values()).sort((a, b) => {
    return (
      a.externalMarketId.localeCompare(b.externalMarketId) ||
      a.polymarketOutcome.localeCompare(b.polymarketOutcome) ||
      a.localMarketId.localeCompare(b.localMarketId)
    );
  });
}

function mappingKey(mapping: ReferenceMarketMapping) {
  return [
    mapping.source,
    mapping.externalMarketId,
    mapping.conditionId ?? "",
    mapping.polymarketTokenId,
    mapping.localMarketId,
    mapping.localOutcome,
  ].join(":");
}

