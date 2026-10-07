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
  countReelsStock,
  getReelResultRows,
} from "./database";
import { getActiveCampaignDaySummaries, getAdAccounts } from "./meta-ads-client";
import { pickAdAccount } from "./ads-insights";
import { loadGuardStatuses } from "./guard-status";
import { summarizeReels } from "./reel-insights";
import { summarizePhotos } from "./photo-insights";
import { getInstagramViews, getPhotoResultRows } from "./photo-insights-store";
import type { MorningReportSources } from "./morning-report";

export const VIDEO_HORIZON_DAYS = 3;
export const REEL_RESULTS_DAYS = 7;

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
  reelsStock: () => countReelsStock(),
  reelResults: async () => {
    const days = REEL_RESULTS_DAYS;
    const rows = await getReelResultRows(days);
    const sum = summarizeReels(rows);
    const watch = rows.map((r) => r.avgWatchMs).filter((x): x is number => x != null && x > 0);
    const best = sum.byStyle.find((g) => !g.lowSample);
    return {
      days,
      measured: sum.measured,
      totalPlays: sum.totalPlays,
      avgWatchS: watch.length ? watch.reduce((a, b) => a + b, 0) / watch.length / 1000 : null,
      bestStyle: best ? { key: best.key, avgPlays: best.avgPlays, n: best.n } : null,
      lastMeasuredOn: sum.lastMeasuredOn,
    };
  },
  photoResults: async () => {
    const days = REEL_RESULTS_DAYS;
    const sum = summarizePhotos(await getPhotoResultRows(days));
    const best = sum.byFormat.find((g) => !g.lowSample);
    return {
      days,
      measured: sum.measured,
      totalViews: sum.totalViews,
      totalReactions: sum.totalReactions,
      totalComments: sum.totalComments,
      totalShares: sum.totalShares,
      instagramViews: await getInstagramViews(days),
      bestFormat: best ? { key: best.key, avgViews: best.avgViews, n: best.n } : null,
      lastMeasuredOn: sum.lastMeasuredOn,
    };
  },
  alerts: async () => {
    const a = await countMorningReportAlerts();
    return [
      { label: "Produits sous le prix plancher (dernier audit)", count: a.priceBelowFloor },
      { label: "Incidents de prix plancher (24 h)", count: a.priceFloorIncidents24h },
      { label: "Images en attente de révision", count: a.imagesPendingReview },
      { label: "Imports en erreur", count: a.importErrors },
      { label: "Problèmes de cohérence du catalogue", count: a.catalogIssues },
      { label: "Publications en échec (récentes ou à venir)", count: a.failedPublications },
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
