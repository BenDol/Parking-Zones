/**
 * Core logic for processing zone submission issues.
 * Called by process-submission.yml via actions/github-script@v7.
 *
 * @param {{ github: object, context: object, core: object }} params
 */
import { encode as geohashEncode } from 'ngeohash';
import { ParkingZoneSubmission, CdnZoneIndex } from './schemas.mjs';

const GEOHASH_PRECISION = 6;

/**
 * Jaccard similarity on lowercased whitespace-split tokens.
 */
function nameSimilarity(a, b) {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Haversine distance in meters.
 */
function distanceMeters(a, b) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Extract JSON from a markdown code block in the issue body.
 */
function extractJsonFromBody(body) {
  const match = body.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!match) throw new Error('No JSON code block found in issue body');
  return match[1].trim();
}

/**
 * Check for duplicate zones in the existing file.
 */
function findDuplicate(candidate, existingZones) {
  for (const [, bucket] of Object.entries(existingZones)) {
    for (const zone of bucket) {
      const dist = distanceMeters(candidate.center, zone.center);

      // Name-based: within 50m and names are similar
      if (dist <= 50) {
        const sim = nameSimilarity(candidate.name, zone.name);
        if (sim >= 0.6) return zone;
      }

      // Location-only: within 20m and similar radius
      if (dist <= 20) {
        const maxRadius = Math.max(candidate.radius, zone.radius);
        const radiusDiff = Math.abs(candidate.radius - zone.radius);
        if (maxRadius > 0 && radiusDiff / maxRadius <= 0.3) return zone;
      }
    }
  }
  return null;
}

/**
 * Generate a unique zone ID.
 */
function generateZoneId(country, region) {
  const uuid = crypto.randomUUID();
  return `cdn-${country}-${region}-${uuid}`;
}

export async function processSubmission({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  // Support manual workflow_dispatch with issue_number input
  let issue;
  if (context.payload.issue) {
    issue = context.payload.issue;
  } else {
    const issueNum = parseInt(context.payload.inputs?.issue_number, 10);
    if (!issueNum) throw new Error('No issue found in event and no issue_number input provided');
    const resp = await github.rest.issues.get({ owner, repo, issue_number: issueNum });
    issue = resp.data;
  }
  const issueNumber = issue.number;

  async function addComment(body) {
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }

  async function addLabel(label) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] });
  }

  async function closeIssue() {
    await github.rest.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
  }

  try {
    await addLabel('status:processing');

    // 1. Parse JSON from issue body
    let rawJson;
    try {
      rawJson = extractJsonFromBody(issue.body);
    } catch (err) {
      await addComment(`**Error:** ${err.message}\n\nPlease ensure your zone data is in a JSON code block.`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    let zoneData;
    try {
      zoneData = JSON.parse(rawJson);
    } catch (err) {
      await addComment(`**Error:** Invalid JSON: ${err.message}`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    // 2. Validate against schema
    const validation = ParkingZoneSubmission.safeParse(zoneData);
    if (!validation.success) {
      const errors = validation.error.issues
        .map((i) => `- \`${i.path.join('.')}\`: ${i.message}`)
        .join('\n');
      await addComment(`**Validation failed:**\n\n${errors}`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    const zone = validation.data;

    // 3. Determine file path
    const country = zone.country;
    const region = zone.region;
    const filePath = `zones/${country}/${region}/zones.json`;

    // 4. Read existing file or create empty index
    let existingContent;
    let existingFile;
    try {
      existingFile = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: 'main' });
      existingContent = JSON.parse(Buffer.from(existingFile.data.content, 'base64').toString('utf-8'));
    } catch (err) {
      if (err.status === 404) {
        existingContent = {
          country,
          region,
          lastUpdated: new Date().toISOString(),
          zoneCount: 0,
          zones: {},
        };
      } else {
        throw err;
      }
    }

    // 5. Check for duplicates
    const duplicate = findDuplicate(zone, existingContent.zones);
    if (duplicate) {
      await addComment(
        `**Possible duplicate detected:**\n\nExisting zone: **${duplicate.name}** (ID: \`${duplicate.id}\`)\n\n` +
        `The submitted zone is very close to an existing one. Please verify this isn't a duplicate.`
      );
      await addLabel('status:duplicate');
      await closeIssue();
      return;
    }

    // 6. Generate geohash and zone ID
    const geohash = geohashEncode(zone.center.lat, zone.center.lng, GEOHASH_PRECISION);
    const zoneId = generateZoneId(country, region);

    const fullZone = {
      ...zone,
      id: zoneId,
      verified: false,
      version: 1,
    };

    // 7. Insert into geohash bucket
    if (!existingContent.zones[geohash]) {
      existingContent.zones[geohash] = [];
    }
    existingContent.zones[geohash].push(fullZone);

    // Update metadata
    let totalCount = 0;
    for (const bucket of Object.values(existingContent.zones)) {
      totalCount += bucket.length;
    }
    existingContent.zoneCount = totalCount;
    existingContent.lastUpdated = new Date().toISOString();

    const newContent = JSON.stringify(existingContent, null, 2) + '\n';

    // 8. Create branch
    const branchName = `zone-submission/${issueNumber}`;
    const mainRef = await github.rest.git.getRef({ owner, repo, ref: 'heads/main' });
    const mainSha = mainRef.data.object.sha;

    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: mainSha,
    });

    // 9. Commit the file
    const commitMessage = `Add zone: ${zone.name} (${country}/${region})\n\nCloses #${issueNumber}`;

    if (existingFile) {
      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
        sha: existingFile.data.sha,
        branch: branchName,
      });
    } else {
      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
        branch: branchName,
      });
    }

    // 10. Create PR
    const pr = await github.rest.pulls.create({
      owner,
      repo,
      title: `Add zone: ${zone.name}`,
      body: `Adds parking zone **${zone.name}** to \`${country}/${region}\`.\n\nGeohash: \`${geohash}\`\nZone ID: \`${zoneId}\`\n\nCloses #${issueNumber}`,
      head: branchName,
      base: 'main',
    });

    // 11. Check auto-merge eligibility
    let shouldAutoMerge = false;

    try {
      const settingsFile = await github.rest.repos.getContent({ owner, repo, path: 'config/settings.json', ref: 'main' });
      const settings = JSON.parse(Buffer.from(settingsFile.data.content, 'base64').toString('utf-8'));
      if (settings.autoMerge) shouldAutoMerge = true;
    } catch { /* ignore */ }

    if (!shouldAutoMerge) {
      // Check email-based auto-merge
      const emailMatch = issue.body.match(/### Email\s*\n\s*(\S+@\S+)/);
      if (emailMatch) {
        try {
          const emailsFile = await github.rest.repos.getContent({ owner, repo, path: 'config/auto-merge-emails.json', ref: 'main' });
          const trustedEmails = JSON.parse(Buffer.from(emailsFile.data.content, 'base64').toString('utf-8'));
          if (trustedEmails.includes(emailMatch[1])) shouldAutoMerge = true;
        } catch { /* ignore */ }
      }
    }

    if (shouldAutoMerge) {
      try {
        await github.rest.pulls.merge({ owner, repo, pull_number: pr.data.number, merge_method: 'squash' });
        await addComment(`Zone submitted and auto-merged! PR: ${pr.data.html_url}`);
      } catch (err) {
        await addComment(`Zone PR created but auto-merge failed: ${err.message}\n\nPR: ${pr.data.html_url}`);
      }
    } else {
      await addComment(`Zone PR created for review: ${pr.data.html_url}`);
    }

    await addLabel('status:completed');
    await closeIssue();

  } catch (err) {
    core.setFailed(`Failed to process submission: ${err.message}`);
    await addComment(`**Internal error:** ${err.message}\n\nPlease try again or contact a maintainer.`);
    await addLabel('status:error');
  }
}
