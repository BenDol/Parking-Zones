#!/usr/bin/env node
/**
 * Regenerates manifest.json by scanning all zones files.
 * Called by the update-manifest.yml GitHub Action on push to main.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ZONES_DIR = join(process.cwd(), 'zones');
const MANIFEST_PATH = join(process.cwd(), 'manifest.json');

function findZoneFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findZoneFiles(full));
    } else if (entry === 'zones.json') {
      results.push(full);
    }
  }
  return results;
}

function computeBbox(zones) {
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

  // Add a small padding (~5km)
  const pad = 0.05;
  return {
    north: Math.round((north + pad) * 10) / 10,
    south: Math.round((south - pad) * 10) / 10,
    east: Math.round((east + pad) * 10) / 10,
    west: Math.round((west - pad) * 10) / 10,
  };
}

const files = findZoneFiles(ZONES_DIR);
const regions = [];

for (const file of files) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    const bbox = computeBbox(data.zones);
    regions.push({
      country: data.country,
      region: data.region,
      bbox,
      zoneCount: data.zoneCount,
    });
  } catch (err) {
    console.error(`Warning: Failed to parse ${file}: ${err.message}`);
  }
}

const manifest = {
  regions,
  lastUpdated: new Date().toISOString(),
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest updated with ${regions.length} region(s).`);
