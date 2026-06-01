import { ApiClient } from "../api/apiClient.js";
import { PolyApiError } from "../api/apiClient.js";
import type { AdminReferenceMarketItem } from "../api/types.js";

export function createAdminApi(baseUrl: string, devAdminUserId: string | null) {
  const sessionCookie = process.env.POLY_SIM_SESSION_COOKIE ?? "";
  if (!sessionCookie.trim() && !devAdminUserId?.trim()) {
    throw new Error("POLY_SIM_SESSION_COOKIE or POLY_DEV_ADMIN_USER_ID is required.");
  }
  const extraHeaders = devAdminUserId?.trim() ? { "x-dev-admin-user-id": devAdminUserId.trim() } : {};
  return new ApiClient(baseUrl, sessionCookie.trim() ? sessionCookie : "dev-admin", {
    authMode: "cookie",
    cookieName: "poly_session",
    extraHeaders,
  });
}

export async function ensureAdminApiAccess(api: ApiClient, params: {
  baseUrl: string;
  devAdminUserId: string | null;
}) {
  try {
    await api.listAdminReferenceMarkets({
      source: "polymarket",
      importStatus: "approved",
    });
  } catch (error) {
    if (error instanceof PolyApiError && error.status === 403) {
      const configuredUser = params.devAdminUserId?.trim();
      const details = configuredUser
        ? `POLY_DEV_ADMIN_USER_ID=${configuredUser} was rejected by ${params.baseUrl}.`
        : `The admin session for ${params.baseUrl} was rejected.`;
      throw new Error(
        `${details} The target app only accepts a real admin user id from its current database in non-production mode, or a valid poly_session cookie.`,
      );
    }
    throw error;
  }
}

export async function loadEventReferenceMarkets(api: ApiClient, params: {
  eventSlug: string;
  search?: string | null;
  maxMarkets?: number | null;
  allowlist?: string[] | null;
}) : Promise<AdminReferenceMarketItem[]> {
  const filters = {
    source: "polymarket",
    ...(params.search ? { search: params.search } : {}),
  };
  const response = await api.listAdminReferenceMarkets(filters);
  const allowlist = normalizeAllowlist(params.allowlist ?? []);

  return response.items
    .filter((market) => market.event?.slug === params.eventSlug)
    .filter((market) => {
      if (!allowlist.length) return true;
      const label = getReferenceMarketLabel(market);
      return allowlist.includes(label.toLowerCase());
    })
    .slice(0, params.maxMarkets && params.maxMarkets > 0 ? params.maxMarkets : undefined);
}

export function getReferenceMarketLabel(market: Pick<AdminReferenceMarketItem, "title" | "referenceMetadata">) {
  const metadata =
    market.referenceMetadata && typeof market.referenceMetadata === "object" && !Array.isArray(market.referenceMetadata)
      ? (market.referenceMetadata as Record<string, unknown>)
      : {};
  const group =
    metadata.group && typeof metadata.group === "object" && !Array.isArray(metadata.group)
      ? (metadata.group as Record<string, unknown>)
      : {};
  if (typeof group.outcomeLabel === "string" && group.outcomeLabel.trim().length > 0) {
    return group.outcomeLabel.trim();
  }
  const match = market.title.match(/^Will\s+(.+?)\s+win\b/i);
  return match?.[1]?.trim() || market.title.trim();
}

export function parseAllowlist(value: string | null) {
  if (!value) return [];
  return normalizeAllowlist(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function normalizeAllowlist(entries: string[]) {
  return entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function boolArg(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "true";
}

export function intArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function numberArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringArg(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : null;
}
