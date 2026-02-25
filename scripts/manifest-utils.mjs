/**
 * Shared manifest logic used by both:
 * - update-manifest.mjs (filesystem-based, runs in update-manifest.yml)
 * - process-submission.mjs (GitHub API-based, runs inline after auto-merge)
 */

/**
 * Compute a bounding box from a zones object (geohash -> zone[]).
 * Adds ~5km padding.
 */
export function computeBbox(zones) {
  let north = -90, south = 90, east = -180, west = 180;

  for (const bucket of Object.values(zones)) {
    for (const zone of bucket) {
      const { lat, lng } = zone.center;
      if (lat > north) north = lat;
      if (lat < south) south = lat;
      if (lng > east) east = lng;
      if (lng < west) west = lng;
    }
  }

  const pad = 0.05;
  return {
    north: Math.round((north + pad) * 10) / 10,
    south: Math.round((south - pad) * 10) / 10,
    east: Math.round((east + pad) * 10) / 10,
    west: Math.round((west - pad) * 10) / 10,
  };
}

/**
 * Build a manifest object from an array of parsed zone file contents.
 * Each entry should have { country, region, zoneCount, zones }.
 */
export function buildManifest(zoneFiles) {
  const regions = [];

  for (const data of zoneFiles) {
    regions.push({
      country: data.country,
      region: data.region,
      bbox: computeBbox(data.zones),
      zoneCount: data.zoneCount,
    });
  }

  return {
    regions,
    lastUpdated: new Date().toISOString(),
  };
}
