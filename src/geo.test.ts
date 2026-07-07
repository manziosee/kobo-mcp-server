import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseGeopoint, isWithinBBox, toFeatureCollection } from "./geo.js";

describe("parseGeopoint", () => {
  test("parses a full geopoint string", () => {
    const point = parseGeopoint("-1.9441 30.0619 1500 5");
    assert.deepEqual(point, { lat: -1.9441, lon: 30.0619, altitude: 1500, accuracy: 5 });
  });

  test("parses lat/lon only, altitude/accuracy default to null", () => {
    const point = parseGeopoint("-1.9441 30.0619");
    assert.deepEqual(point, { lat: -1.9441, lon: 30.0619, altitude: null, accuracy: null });
  });

  test("returns null for empty, non-string, or malformed input", () => {
    assert.equal(parseGeopoint(""), null);
    assert.equal(parseGeopoint(undefined), null);
    assert.equal(parseGeopoint(null), null);
    assert.equal(parseGeopoint("not a geopoint"), null);
  });
});

describe("isWithinBBox", () => {
  const bbox = { minLat: -2, minLon: 29, maxLat: -1, maxLon: 31 };

  test("returns true when the point is inside the box", () => {
    assert.equal(isWithinBBox({ lat: -1.9441, lon: 30.0619, altitude: null, accuracy: null }, bbox), true);
  });

  test("returns false when the point is outside the box", () => {
    assert.equal(isWithinBBox({ lat: 10, lon: 30, altitude: null, accuracy: null }, bbox), false);
  });
});

describe("toFeatureCollection", () => {
  test("builds a GeoJSON FeatureCollection with [lon, lat] coordinate order", () => {
    const fc = toFeatureCollection([
      { point: { lat: -1.9441, lon: 30.0619, altitude: null, accuracy: null }, properties: { _id: 1 } },
    ]);

    assert.equal(fc.type, "FeatureCollection");
    assert.equal(fc.features.length, 1);
    assert.deepEqual(fc.features[0].geometry.coordinates, [30.0619, -1.9441]);
    assert.deepEqual(fc.features[0].properties, { _id: 1 });
  });
});
