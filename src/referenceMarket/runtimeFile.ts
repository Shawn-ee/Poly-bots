import fs from "node:fs/promises";
import path from "node:path";

export type ReferenceLiveRuntimeRecord = {
  marketId: string;
  slug: string | null;
  botUserId: string;
  botUsername: string | null;
  botApiCredentialId: string;
  botApiKeyId: string | null;
  botApiToken: string;
  seededAt: string;
  capitalCents: number;
  mintBudgetCents: number;
  cashReserveCents: number;
  mintedCompleteSets: number;
};

export function runtimeFilePath(cwd: string, marketId: string) {
  return path.resolve(cwd, ".runtime", `reference-liquidity-${marketId}.json`);
}

export async function writeReferenceLiveRuntimeRecord(cwd: string, record: ReferenceLiveRuntimeRecord) {
  const filePath = runtimeFilePath(cwd, record.marketId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readReferenceLiveRuntimeRecord(cwd: string, marketId: string) {
  const filePath = runtimeFilePath(cwd, marketId);
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents) as ReferenceLiveRuntimeRecord;
}
