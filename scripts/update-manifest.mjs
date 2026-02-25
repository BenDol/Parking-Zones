#!/usr/bin/env node
/**
 * Regenerates manifest.json by scanning all zones files on the local filesystem.
 * Called by the update-manifest.yml GitHub Action on push to main/dev.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest } from './manifest-utils.mjs';

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

const files = findZoneFiles(ZONES_DIR);
const zoneFiles = [];

for (const file of files) {
  try {
    zoneFiles.push(JSON.parse(readFileSync(file, 'utf-8')));
  } catch (err) {
    console.error(`Warning: Failed to parse ${file}: ${err.message}`);
  }
}

const manifest = buildManifest(zoneFiles);
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest updated with ${manifest.regions.length} region(s).`);
