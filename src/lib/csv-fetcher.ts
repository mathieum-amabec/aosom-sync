import { parse } from "csv-parse/sync";
import type { AosomRawRow, AosomProduct } from "@/types/aosom";
import { AOSOM } from "./config";

/** Covers headers + body stream — 60s margin under Vercel 300s function limit */
const FETCH_TIMEOUT_MS = 240_000;

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

/**
 * Fetch and parse the Aosom CSV feed into normalized AosomProduct[].
 * Single attempt — no retry (240s timeout × retries would exceed Vercel 300s budget).
 * Timeout covers both the initial connection and the full body stream.
 */
export async function fetchAosomCatalog(): Promise<AosomProduct[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(AOSOM.CSV_URL, {
      next: { revalidate: 0 },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from Aosom CSV endpoint`);
    }

    const text = await response.text();
    return parseTsv(text);
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`CSV fetch exceeded ${FETCH_TIMEOUT_MS / 1000}s — likely Aosom CDN slow window`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse TSV text into normalized products.
 * Exported separately for testing with local files.
 */
export function parseTsv(text: string): AosomProduct[] {
  // Detect delimiter — Aosom uses tab-separated
  const firstLine = text.split("\n")[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";

  const rows: AosomRawRow[] = parse(text, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return rows
    .filter((row) => row.SKU && row.SKU.trim() !== "")
    .map(normalizeRow);
}

function normalizeRow(row: AosomRawRow): AosomProduct {
  const images = collectImages(row);
  const brand = extractBrand(row.Name);
  const description = row.description
    ? row.description.replace(/\[BRAND NAME\]/gi, brand)
    : "";
  const shortDescription = row.short_description
    ? row.short_description.replace(/\[BRAND NAME\]/gi, brand)
    : "";

  return {
    sku: row.SKU.trim(),
    name: row.Name?.trim() || "",
    price: parseFloat(row.Price) || 0,
    qty: parseInt(row.Qty, 10) || 0,
    color: row.color?.trim() || "",
    size: row.size?.trim() || "",
    shortDescription,
    description,
    images,
    gtin: row.Gtin?.trim() || "",
    weight: parseFloat(row.Weight) || 0,
    dimensions: {
      length: parseFloat(row.Length) || 0,
      width: parseFloat(row.Width) || 0,
      height: parseFloat(row.Height) || 0,
    },
    productType: row.Product_Type?.trim() || "",
    category: row.Category?.trim() || "",
    brand,
    material: row.Material?.trim() || "",
    psin: row.Psin?.trim() || "",
    sin: row.Sin?.trim() || "",
    video: row.Video?.trim() || "",
    estimatedArrival: row["Estimated Arrival Time"]?.trim() || "",
    outOfStockExpected: row["Out Of Stock Expected"]?.trim() || "",
    packageNum: row.Package_Num?.trim() || "",
    boxSize: row.Box_Size?.trim() || "",
    boxWeight: row.Box_Weight?.trim() || "",
    pdf: row.pdf?.trim() || "",
  };
}

/**
 * Collect all non-empty image URLs from Image, Images, and Image1-Image7.
 */
function collectImages(row: AosomRawRow): string[] {
  const urls: string[] = [];

  // Primary image
  if (row.Image?.trim()) {
    urls.push(row.Image.trim());
  }

  // Images field (comma or pipe separated)
  if (row.Images?.trim()) {
    const sep = row.Images.includes("|") ? "|" : ",";
    row.Images.split(sep).forEach((u) => {
      const trimmed = u.trim();
      if (trimmed && !urls.includes(trimmed)) urls.push(trimmed);
    });
  }

  // Image1 through Image7
  for (let i = 1; i <= 7; i++) {
    const key = `Image${i}` as keyof AosomRawRow;
    const val = row[key]?.trim();
    if (val && !urls.includes(val)) urls.push(val);
  }

  return urls;
}

/**
 * Extract brand from the product name.
 * Aosom product names typically start with the brand: "Outsunny 10x12 Gazebo..."
 * Common Aosom brands: Outsunny, HomCom, PawHut, Soozier, Vinsetto, etc.
 */
const KNOWN_BRANDS = [
  "Outsunny",
  "HomCom",
  "HOMCOM",
  "PawHut",
  "Soozier",
  "Vinsetto",
  "Aosom",
  "Qaba",
  "ShopEZ",
  "Wikinger",
  "Portland",
  "Aousthop",
];

function extractBrand(name: string): string {
  if (!name) return "Aosom";
  const nameLower = name.toLowerCase();
  for (const brand of KNOWN_BRANDS) {
    if (nameLower.startsWith(brand.toLowerCase())) {
      return brand;
    }
  }
  // Fallback: first word
  const firstWord = name.split(/\s+/)[0];
  return firstWord || "Aosom";
}
