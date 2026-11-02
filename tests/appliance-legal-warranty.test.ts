import { describe, it, expect } from "vitest";
import { classifyAppliance } from "@/lib/appliance-legal-warranty";

const c = (handle: string, productType = "", tags: string[] = []) => classifyAppliance({ handle, productType, tags });

describe("classifyAppliance (LPC art. 38.1)", () => {
  it("6 years: fridges (incl. mini / beverage / wine), freezers, air conditioners", () => {
    expect(c("mini-refrigerateur-compact-avec-congelateur-218l", "Holiday & Seasonal")).toBe(6);
    expect(c("refroidisseur-a-vin-8-bouteilles")).toBe(6);
    expect(c("mini-congeleuro-horizontal-99l", "Home Furnishings > Appliances > Small Kitchen Appliances")).toBe(6);
    expect(c("climatiseur-mobile-10000-btu-deshumidificateur", "Home Furnishings > Appliances > Air Conditioner")).toBe(6);
    expect(c("climatiseur-mini-split-inverseur-12000-btu-wifi")).toBe(6);
  });
  it("5 years: washers, dryers, dishwashers", () => {
    expect(c("laveuse-portative-automatique-compact", "Appliances")).toBe(5);
    expect(c("secheuse-compacte-portable-3-kg")).toBe(5);
    expect(c("lave-vaisselle-comptoir-portable-4-couverts")).toBe(5);
  });
  it("12 V car fridge sold as glacière only when tagged as a refrigerator", () => {
    expect(c("glaciere-portable-pour-voiture-30-litres", "", ["car refrigerator", "frigo portable"])).toBe(6);
    expect(c("glaciere-rigide-45-litres", "", ["camping"])).toBeNull();
  });
  it("not appliances: dehumidifiers, fans, ice makers, toys, furniture, drying racks, microwaves", () => {
    expect(c("deshumidificateur-30-pintes")).toBeNull();
    expect(c("ventilateur-colonne-oscillant")).toBeNull();
    expect(c("machine-a-glacons-comptoir-12-kg")).toBeNull();
    expect(c("cuisiniere-jouet-pour-enfants-avec-lave-vaisselle")).toBeNull();
    expect(c("meuble-tv-avec-foyer-electrique")).toBeNull();
    expect(c("armoire-pour-laveuse-et-secheuse")).toBeNull();
    expect(c("sechoir-a-linge-pliant-en-acier")).toBeNull();
    expect(c("four-micro-ondes-compact")).toBeNull();
    expect(c("canape-3-places-en-lin")).toBeNull();
  });
});
