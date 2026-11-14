/** Builders for Costway-feed-shaped CSV fixtures (see src/lib/costway/feed.ts). */

// The real feed header, verbatim (44 columns, "Image Src"/"Image Position" repeated 10×).
const HEADER = [
  "Handle", "Title", "Item No", "Item Link", "Vendor", "Body (HTML)", "Category", "Product Category", "Type", "Tags",
  "Option1 Name", "Option1 Value", "Variant SKU", "Variant Inventory Tracker", "1=In Stock|0=OOS",
  "Variant Inventory Qty", "US Inventory", "Canadian inventory", "Variant Inventory Policy",
  "Variant Fulfillment Service", "Variant Price", "Price Drop", "Variant Compare At Price", "Tag",
  ...Array.from({ length: 10 }, () => ["Image Src", "Image Position"]).flat(),
];

/** Column overrides by header name; `images` fills the Image Src/Image Position pairs in order. */
export type Row = { [column: string]: string | [string, string][] | undefined; images?: [string, string][] };

export function line(r: Row): string {
  const base: Record<string, string> = {
    Handle: "h", Title: "Chaise", "Item No": "111", "Item Link": "https://www.costway.ca/x.html", Vendor: "Costway",
    "Body (HTML)": "<p>desc</p>", Category: "Furniture > Chairs", Type: "Chairs", "Option1 Value": "Black",
    "Variant SKU": "111_AB1", "1=In Stock|0=OOS": "1", "Variant Inventory Qty": "5", "US Inventory": "3",
    "Canadian inventory": "2", "Variant Price": "100", "Price Drop": "", "Variant Compare At Price": "150", Tag: "",
  };
  const vals: Record<string, unknown> = { ...base, ...r };
  const out: string[] = [];
  let img = 0;
  for (let i = 0; i < HEADER.length; i++) {
    const h = HEADER[i];
    if (h === "Image Src") {
      const pair = r.images?.[img++];
      out.push(pair?.[0] ?? "", pair?.[1] ?? "");
      i++; // consumed the Image Position column too
      continue;
    }
    out.push(typeof vals[h] === "string" ? (vals[h] as string) : "");
  }
  return out.join(",");
}

export const csv = (...rows: (Row | string)[]) =>
  [HEADER.join(","), ...rows.map((r) => (typeof r === "string" ? r : line(r)))].join("\n") + "\n";
