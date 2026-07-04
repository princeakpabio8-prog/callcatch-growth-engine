const TRADE_CONFIG = {
  HVAC: {
    searchTerms: ["hvac", "air conditioning", "heating contractor", "furnace repair"],
    osmRegex: "hvac|heating|air conditioning|air_conditioning|furnace|ventilation",
    keywords: ["hvac", "heating", "cooling", "air", "furnace", "ventilation"]
  },
  Plumbing: {
    searchTerms: ["plumber", "plumbing contractor"],
    osmRegex: "plumb|plumber|plumbing",
    keywords: ["plumb", "drain", "pipe", "water heater"]
  },
  Electrical: {
    searchTerms: ["electrician", "electrical contractor"],
    osmRegex: "electric|electrician|electrical",
    keywords: ["electric", "electrical", "wiring", "lighting"]
  },
  Roofing: {
    searchTerms: ["roofer", "roofing contractor"],
    osmRegex: "roof|roofer|roofing",
    keywords: ["roof", "roofing", "gutter", "storm"]
  },
  "Garage Doors": {
    searchTerms: ["garage door repair", "garage door company"],
    osmRegex: "garage door|garage_door|overhead door",
    keywords: ["garage", "overhead door", "door repair"]
  },
  Landscaping: {
    searchTerms: ["landscaper", "landscaping company", "lawn care"],
    osmRegex: "landscap|lawn|garden|groundskeeping",
    keywords: ["landscap", "lawn", "garden", "yard"]
  },
  "Pest Control": {
    searchTerms: ["pest control", "exterminator"],
    osmRegex: "pest|exterminat",
    keywords: ["pest", "exterminator", "termite", "rodent"]
  },
  Cleaning: {
    searchTerms: ["cleaning service", "house cleaning", "commercial cleaning"],
    osmRegex: "clean|janitor|maid",
    keywords: ["clean", "maid", "janitor"]
  },
  Painting: {
    searchTerms: ["painter", "painting contractor"],
    osmRegex: "paint|painter",
    keywords: ["paint", "painter", "drywall"]
  },
  Locksmith: {
    searchTerms: ["locksmith", "emergency locksmith"],
    osmRegex: "locksmith|lock smith",
    keywords: ["locksmith", "lock", "key"]
  },
  "Appliance Repair": {
    searchTerms: ["appliance repair", "washer dryer repair"],
    osmRegex: "appliance|washer|dryer|refrigerator",
    keywords: ["appliance", "washer", "dryer", "refrigerator"]
  },
  "Tree Service": {
    searchTerms: ["tree service", "arborist", "tree removal"],
    osmRegex: "tree|arborist",
    keywords: ["tree", "arborist", "stump"]
  },
  Flooring: {
    searchTerms: ["flooring contractor", "floor installation"],
    osmRegex: "floor|flooring|carpet|tile",
    keywords: ["floor", "flooring", "carpet", "tile"]
  },
  Solar: {
    searchTerms: ["solar installer", "solar company"],
    osmRegex: "solar|photovoltaic",
    keywords: ["solar", "photovoltaic", "panel"]
  },
  "Pool Services": {
    searchTerms: ["pool service", "pool cleaning", "pool repair"],
    osmRegex: "pool|swimming pool",
    keywords: ["pool", "swimming"]
  },
  "Junk Removal": {
    searchTerms: ["junk removal", "hauling service"],
    osmRegex: "junk|haul|waste removal",
    keywords: ["junk", "haul", "waste"]
  }
};

function getTradeConfig(trade) {
  return TRADE_CONFIG[trade] || {
    searchTerms: [`${trade} company`, `${trade} contractor`],
    osmRegex: String(trade || "contractor").replace(/[^\w\s-]/g, ""),
    keywords: [String(trade || "contractor").toLowerCase()]
  };
}

module.exports = { TRADE_CONFIG, getTradeConfig };
