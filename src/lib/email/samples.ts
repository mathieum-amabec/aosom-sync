/**
 * Made-up trigger data to preview every flow email in the dashboard (no real customer).
 */
import type { Locale } from "./layout";
import type { Props } from "./templates";

const S = "https://ameublodirect.ca";

export function sampleProps(flowKey: string, l: Locale): Props {
  const loc = l === "en" ? "en-CA" : "fr-CA";
  switch (flowKey) {
    case "relance-1":
    case "relance-2":
      return {
        "Customer Locale": loc,
        "Item Count": 1,
        $extra: {
          checkout_url: `${S}/checkouts/exemple`,
          line_items: [{ title: l === "en" ? "3-seat sofa, linen look" : "Canapé 3 places, aspect lin", quantity: 1, line_price: 649.99, product: { images: [] } }],
        },
      };
    case "roue-1":
    case "roue-2":
    case "roue-3":
      return {
        locale: l, code: "ROUE-EXEMPLE", prize_fr: "15 $ de rabais", prize_en: "$15 off",
        apply_url_fr: `${S}/discount/ROUE-EXEMPLE?redirect=/collections/all`,
        apply_url_en: `${S}/discount/ROUE-EXEMPLE?redirect=/en/collections/all`,
      };
    case "baisse-prix":
      return { locale: l, product_name: l === "en" ? "Patio set, 4 pieces" : "Ensemble de patio 4 pièces", old_price: 899.99, new_price: 749.99, product_url: `${S}/collections/rabais` };
    default:
      return { locale: l };
  }
}
