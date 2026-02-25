#!/usr/bin/env node
/**
 * CLI tool to validate a zone JSON file or inline JSON against the ParkingZone schema.
 *
 * Usage:
 *   node scripts/validate-zone.mjs '{"name":"Test",...}'
 *   node scripts/validate-zone.mjs path/to/zone.json
 */
import { readFileSync } from 'node:fs';
import { ParkingZoneSubmission } from './schemas.mjs';

const input = process.argv[2];

if (!input) {
  console.error('Usage: validate-zone.mjs <json-string-or-file-path>');
  process.exit(1);
}

let raw;
try {
  // Try reading as file first
  raw = readFileSync(input, 'utf-8');
} catch {
  // Assume it's inline JSON
  raw = input;
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error('Invalid JSON:', err.message);
  process.exit(1);
}

const result = ParkingZoneSubmission.safeParse(data);

if (result.success) {
  console.log('Valid zone data.');
  console.log(JSON.stringify(result.data, null, 2));
  process.exit(0);
} else {
  console.error('Validation errors:');
  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
