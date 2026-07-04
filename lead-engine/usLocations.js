const LOCATIONS = {
  "dallas,tx": { city: "Dallas", state: "TX", lat: 32.7767, lon: -96.797, bbox: { south: 32.55, west: -97.04, north: 33.02, east: -96.52 } },
  "houston,tx": { city: "Houston", state: "TX", lat: 29.7604, lon: -95.3698, bbox: { south: 29.52, west: -95.82, north: 30.11, east: -95.01 } },
  "austin,tx": { city: "Austin", state: "TX", lat: 30.2672, lon: -97.7431, bbox: { south: 30.08, west: -97.94, north: 30.52, east: -97.56 } },
  "san antonio,tx": { city: "San Antonio", state: "TX", lat: 29.4241, lon: -98.4936, bbox: { south: 29.19, west: -98.80, north: 29.74, east: -98.28 } },
  "phoenix,az": { city: "Phoenix", state: "AZ", lat: 33.4484, lon: -112.074, bbox: { south: 33.29, west: -112.32, north: 33.76, east: -111.86 } },
  "tucson,az": { city: "Tucson", state: "AZ", lat: 32.2226, lon: -110.9747, bbox: { south: 32.05, west: -111.16, north: 32.36, east: -110.73 } },
  "miami,fl": { city: "Miami", state: "FL", lat: 25.7617, lon: -80.1918, bbox: { south: 25.55, west: -80.42, north: 25.90, east: -80.10 } },
  "orlando,fl": { city: "Orlando", state: "FL", lat: 28.5383, lon: -81.3792, bbox: { south: 28.35, west: -81.55, north: 28.65, east: -81.20 } },
  "tampa,fl": { city: "Tampa", state: "FL", lat: 27.9506, lon: -82.4572, bbox: { south: 27.80, west: -82.65, north: 28.10, east: -82.25 } },
  "chicago,il": { city: "Chicago", state: "IL", lat: 41.8781, lon: -87.6298, bbox: { south: 41.64, west: -87.94, north: 42.03, east: -87.52 } },
  "los angeles,ca": { city: "Los Angeles", state: "CA", lat: 34.0522, lon: -118.2437, bbox: { south: 33.70, west: -118.67, north: 34.34, east: -118.15 } },
  "san diego,ca": { city: "San Diego", state: "CA", lat: 32.7157, lon: -117.1611, bbox: { south: 32.53, west: -117.28, north: 33.02, east: -116.90 } },
  "new york,ny": { city: "New York", state: "NY", lat: 40.7128, lon: -74.006, bbox: { south: 40.49, west: -74.26, north: 40.92, east: -73.70 } },
  "atlanta,ga": { city: "Atlanta", state: "GA", lat: 33.749, lon: -84.388, bbox: { south: 33.60, west: -84.55, north: 33.90, east: -84.25 } },
  "denver,co": { city: "Denver", state: "CO", lat: 39.7392, lon: -104.9903, bbox: { south: 39.60, west: -105.11, north: 39.91, east: -104.73 } },
  "seattle,wa": { city: "Seattle", state: "WA", lat: 47.6062, lon: -122.3321, bbox: { south: 47.49, west: -122.46, north: 47.74, east: -122.22 } },
  "charlotte,nc": { city: "Charlotte", state: "NC", lat: 35.2271, lon: -80.8431, bbox: { south: 35.01, west: -81.05, north: 35.40, east: -80.65 } },
  "nashville,tn": { city: "Nashville", state: "TN", lat: 36.1627, lon: -86.7816, bbox: { south: 35.97, west: -87.05, north: 36.36, east: -86.55 } },
  "las vegas,nv": { city: "Las Vegas", state: "NV", lat: 36.1699, lon: -115.1398, bbox: { south: 35.98, west: -115.38, north: 36.36, east: -114.95 } }
};

function key(city, state) {
  return `${String(city || "").trim().toLowerCase()},${String(state || "").trim().toLowerCase()}`;
}

function parseArea(area) {
  const parts = String(area || "").split(",").map(part => part.trim()).filter(Boolean);
  return {
    city: parts[0] || "",
    state: (parts[1] || "").split(/\s+/)[0] || ""
  };
}

function fallbackLocation({ area, city, state }) {
  const parsed = parseArea(area);
  const match = LOCATIONS[key(city || parsed.city, state || parsed.state)];
  if (!match) return null;
  return {
    ...match,
    displayName: `${match.city}, ${match.state}, United States`,
    source: "Local U.S. fallback"
  };
}

module.exports = { fallbackLocation };
