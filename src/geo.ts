export interface GeoPoint {
  lat: number;
  lon: number;
  altitude: number | null;
  accuracy: number | null;
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Parses an ODK/Kobo geopoint string: "lat lon altitude accuracy" (space-separated). */
export function parseGeopoint(raw: unknown): GeoPoint | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  const parts = raw.trim().split(/\s+/).map(Number);
  const [lat, lon, altitude, accuracy] = parts;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    altitude: Number.isFinite(altitude) ? altitude : null,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
  };
}

export function isWithinBBox(point: GeoPoint, bbox: BoundingBox): boolean {
  return point.lat >= bbox.minLat && point.lat <= bbox.maxLat && point.lon >= bbox.minLon && point.lon <= bbox.maxLon;
}

export interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export function toFeatureCollection(
  items: Array<{ point: GeoPoint; properties: Record<string, unknown> }>,
): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map(({ point, properties }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
      properties,
    })),
  };
}
