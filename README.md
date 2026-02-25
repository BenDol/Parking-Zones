# parking-zones

Community-contributed parking zone data, served globally via [jsDelivr CDN](https://www.jsdelivr.com/).

Zone data is stored as static JSON files keyed by [geohash](https://en.wikipedia.org/wiki/Geohash) for fast spatial lookups. Submissions are made through GitHub Issues and automatically validated, deduplicated, and converted into pull requests by GitHub Actions.

## How it works

```
Submit zone via GitHub Issue
        |
        v
  GitHub Action validates (Zod schema)
  Checks for duplicates (proximity + name similarity)
  Encodes location to geohash (precision 6, ~1.2km cells)
  Creates PR with updated zone file
        |
        v
  PR merged to main
        |
        v
  manifest.json auto-regenerated
        |
        v
  jsDelivr CDN serves data globally (free, cached)
```

Clients fetch `manifest.json` to discover regions, then load individual zone files filtered by bounding box and geohash neighbourhood.

**CDN base URL:** `https://cdn.jsdelivr.net/gh/doltech/parking-zones@main`

## Repository structure

```
manifest.json                         # Auto-generated region index
zones/
  {CC}/{region}/zones.json            # Zone data keyed by geohash
config/
  settings.json                       # Global settings (autoMerge flag)
  auto-merge-emails.json              # Trusted submitter emails
scripts/
  process-submission.mjs              # Issue -> validate -> PR pipeline
  update-manifest.mjs                 # Regenerates manifest.json
  validate-zone.mjs                   # CLI validation tool
  schemas.mjs                         # Vendored Zod schemas
.github/
  ISSUE_TEMPLATE/zone-submission.yml  # Structured submission form
  workflows/
    process-submission.yml            # Runs on issue open/label
    update-manifest.yml               # Runs on push to main (zones/**)
```

## Data format

### manifest.json

```json
{
  "regions": [
    {
      "country": "GB",
      "region": "scotland",
      "bbox": { "north": 56.0, "south": 55.9, "east": -3.1, "west": -3.3 },
      "zoneCount": 3
    }
  ],
  "lastUpdated": "2026-02-25T12:00:00.000Z"
}
```

### zones/{country}/{region}/zones.json

```json
{
  "country": "NZ",
  "region": "auckland",
  "lastUpdated": "2026-02-25T12:00:00.000Z",
  "zoneCount": 2,
  "zones": {
    "rckhqv": [
      {
        "id": "cdn-NZ-auckland-seed-001",
        "name": "Britomart Transport Centre",
        "center": { "lat": -36.8442, "lng": 174.7681 },
        "radius": 55,
        "enforcementType": "council",
        "enforcementMethod": "ticket_machine",
        "freeMinutes": 15,
        "maxStayMinutes": 120,
        "chargePerHour": 6.0,
        "currency": "NZD",
        "country": "NZ",
        "region": "auckland",
        "city": "Auckland",
        "verified": false,
        "version": 1
      }
    ]
  }
}
```

The `zones` object maps 6-character geohash keys to arrays of parking zones. This enables efficient spatial queries — clients compute the geohash for their location and look up the surrounding 9-cell neighbourhood.

## Submitting a zone

### Via GitHub Issue (recommended)

1. Go to **Issues > New Issue > Zone Submission**
2. Paste your zone data as JSON:

```json
{
  "name": "Example Car Park",
  "center": { "lat": 55.9533, "lng": -3.1883 },
  "radius": 50,
  "enforcementType": "private",
  "enforcementMethod": "camera_anpr",
  "freeMinutes": 120,
  "country": "GB",
  "region": "scotland"
}
```

3. The automation will validate the data, check for duplicates, and create a PR.

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable zone name |
| `center` | `{ lat, lng }` | Centre point (WGS84) |
| `radius` | number | Radius in metres (1-5000) |
| `enforcementType` | enum | `government`, `private`, `council`, `hospital`, `university`, `airport`, `shopping_centre`, `residential`, `other` |
| `enforcementMethod` | enum | `camera_anpr`, `physical_warden`, `ticket_machine`, `pay_and_display`, `barrier`, `clamp`, `tow`, `mixed`, `unknown` |
| `country` | string | ISO 3166-1 alpha-2 country code |
| `region` | string | Region/state slug (lowercase, hyphens) |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Additional details |
| `freeMinutes` | number | Free parking allowance |
| `maxStayMinutes` | number | Maximum stay duration |
| `chargePerHour` | number | Hourly rate |
| `currency` | string | ISO 4217 currency code |
| `city` | string | City name |
| `operatingHours` | array | Per-day enforcement schedule |

## Validating locally

```bash
npm ci

# Validate a JSON file
npm run validate -- path/to/zone.json

# Validate inline JSON
npm run validate -- '{"name":"Test","center":{"lat":0,"lng":0},"radius":50,"enforcementType":"private","enforcementMethod":"unknown","country":"XX","region":"test"}'

# Regenerate manifest.json
npm run update-manifest
```

## Duplicate detection

The automation rejects submissions that match existing zones:

- **Name + proximity:** Jaccard name similarity >= 0.6 within 50m
- **Location only:** Within 20m and radius within 30%

Rejected submissions are commented with the matching zone and closed.

## Auto-merge

Submissions can be auto-merged (skipping manual review) when:

- `config/settings.json` has `"autoMerge": true`, OR
- The submitter's email (from the optional Email field) is listed in `config/auto-merge-emails.json`

By default, auto-merge is **disabled** — all submissions require manual PR review.

## License

Zone data is contributed by the community. By submitting a zone, you agree that the data may be freely used by the ParkingWarden app and its users.
