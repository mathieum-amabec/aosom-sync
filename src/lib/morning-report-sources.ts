/**
 * Production data sources for the morning report (see morning-report.ts). Read-only: Turso
 * counts + Meta insights. Kept out of the route so it can be run locally for a preview.
 */
import { env } from "./config";
import {
  countAwaitingOperator,
  countContentFormatVideos,
  countGuidesAwaitingApproval,
  countMorningReportAlerts,
} from "./database";
import { getActiveCampaignDaySummaries, getAdAccounts } from "./meta-ads-client";
import { pickAdAccount } from "./ads-insights";
import { loadGuardStatuses } from "./guard-status";
import type { MorningReportSources } from "./morning-report";

export const VIDEO_HORIZON_DAYS = 3;

export const morningReportSources: MorningReportSources = {
  meta: async (day) => {
    if (!env.hasMetaAccessToken) throw new Error("META_ACCESS_TOKEN non configuré");
    const accountId =
      env.metaAdAccountId ?? pickAdAccount(await getAdAccounts(), null)?.id;
    if (!accountId) throw new Error("aucun compte publicitaire Meta accessible");
    return getActiveCampaignDaySummaries(accountId, day);
  },
  guides: () => countGuidesAwaitingApproval(),
  videos: async () => ({ ...(await countContentFormatVideos(VIDEO_HORIZON_DAYS)), horizonDays: VIDEO_HORIZON_DAYS }),
  alerts: async () => {
    const a = await countMorningReportAlerts();
    return [
      { label: "Produits sous le prix plancher (dernier audit)", count: a.priceBelowFloor },
      { label: "Incidents de prix plancher (24 h)", count: a.priceFloorIncidents24h },
      { label: "Images en attente de révision", count: a.imagesPendingReview },
      { label: "Imports en erreur", count: a.importErrors },
      { label: "Problèmes de cohérence du catalogue", count: a.catalogIssues },
      { label: "Notifications non lues", count: a.unreadNotifications },
    ];
  },
  guards: () => loadGuardStatuses(),
  blocked: async () => {
    const b = await countAwaitingOperator();
    return [
      { label: "Publicités séquentielles à approuver", count: b.sequentialAds },
      { label: "Imports prêts à pousser sur Shopify", count: b.importsToPush },
      { label: "Imports bloqués par le contrôle qualité", count: b.importsNeedsReview },
      { label: "Publications sociales à approuver", count: b.socialDrafts },
      { label: "Articles de blogue à approuver", count: b.blogDrafts },
    ];
  },
};
