/**
 * Core logic for processing zone submission issues.
 * Called by process-submission.yml via actions/github-script@v7.
 *
 * @param {{ github: object, context: object, core: object }} params
 */
import ngeohash from 'ngeohash';
const { encode: geohashEncode } = ngeohash;
import { ParkingZoneSubmission, ZoneUpdatePayload, CdnZoneIndex } from './schemas.mjs';
import { buildManifest } from './manifest-utils.mjs';

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

const DEFAULT_BRANCH = 'dev';

/**
 * Extract the target branch from issue labels (e.g. "branch:dev" -> "dev").
 * Falls back to DEFAULT_BRANCH if no branch label is found.
 */
function getTargetBranch(issueLabels) {
  for (const label of issueLabels ?? []) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith('branch:')) return name.slice('branch:'.length);
  }
  return DEFAULT_BRANCH;
}

/**
 * Regenerate manifest.json via the GitHub API (no local filesystem needed).
 * Uses shared buildManifest() for bbox computation and manifest structure.
 */
async function updateManifestViaApi({ github, owner, repo, branch }) {
  // Walk the repo tree to find all zone files
  const { data: tree } = await github.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: 'true',
  });

  const zoneFilePaths = tree.tree
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith('zones/') && entry.path.endsWith('/zones.json'))
    .map((entry) => entry.path);

  // Read each zone file via API
  const zoneFiles = [];
  for (const path of zoneFilePaths) {
    const { data: file } = await github.rest.repos.getContent({ owner, repo, path, ref: branch });
    zoneFiles.push(JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8')));
  }

  const manifest = buildManifest(zoneFiles);
  const newContent = JSON.stringify(manifest, null, 2) + '\n';

  // Get current manifest SHA (needed for update)
  let existingSha;
  try {
    const { data: existing } = await github.rest.repos.getContent({ owner, repo, path: 'manifest.json', ref: branch });
    existingSha = existing.sha;
  } catch { /* file doesn't exist yet */ }

  const commitParams = {
    owner,
    repo,
    path: 'manifest.json',
    message: 'Update manifest.json [skip ci]',
    content: Buffer.from(newContent).toString('base64'),
    branch,
  };
  if (existingSha) commitParams.sha = existingSha;

  await github.rest.repos.createOrUpdateFileContents(commitParams);
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
  const targetBranch = getTargetBranch(issue.labels);

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
      existingFile = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: targetBranch });
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
    const branchName = `zone-submission/${targetBranch}/${issueNumber}`;
    const baseRef = await github.rest.git.getRef({ owner, repo, ref: `heads/${targetBranch}` });
    const baseSha = baseRef.data.object.sha;

    // Delete stale branch if it exists from a previous failed run
    try {
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
    } catch { /* branch doesn't exist — that's fine */ }

    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
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
      base: targetBranch,
    });

    // 11. Check auto-merge eligibility
    let shouldAutoMerge = false;

    try {
      const settingsFile = await github.rest.repos.getContent({ owner, repo, path: 'config/settings.json', ref: targetBranch });
      const settings = JSON.parse(Buffer.from(settingsFile.data.content, 'base64').toString('utf-8'));
      if (settings.autoMerge) shouldAutoMerge = true;
    } catch { /* ignore */ }

    if (!shouldAutoMerge) {
      // Check email-based auto-merge
      const emailMatch = issue.body.match(/### Email\s*\n\s*(\S+@\S+)/);
      if (emailMatch) {
        try {
          const emailsFile = await github.rest.repos.getContent({ owner, repo, path: 'config/auto-merge-emails.json', ref: targetBranch });
          const trustedEmails = JSON.parse(Buffer.from(emailsFile.data.content, 'base64').toString('utf-8'));
          if (trustedEmails.includes(emailMatch[1])) shouldAutoMerge = true;
        } catch { /* ignore */ }
      }
    }

    if (shouldAutoMerge) {
      try {
        await github.rest.pulls.merge({ owner, repo, pull_number: pr.data.number, merge_method: 'squash' });

        // Regenerate manifest inline — the merge was done via GITHUB_TOKEN so
        // the push event won't trigger update-manifest.yml (GitHub Actions limitation).
        try {
          await updateManifestViaApi({ github, owner, repo, branch: targetBranch });
        } catch (manifestErr) {
          core.warning(`Manifest update failed (non-fatal): ${manifestErr.message}`);
        }

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

/**
 * Resolve an issue from context (shared by processSubmission & processUpdate).
 */
async function resolveIssue({ github, context, owner, repo }) {
  if (context.payload.issue) return context.payload.issue;
  const issueNum = parseInt(context.payload.inputs?.issue_number, 10);
  if (!issueNum) throw new Error('No issue found in event and no issue_number input provided');
  const resp = await github.rest.issues.get({ owner, repo, issue_number: issueNum });
  return resp.data;
}

/**
 * Process a zone-update issue: apply partial changes to an existing zone.
 */
export async function processUpdate({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const issue = await resolveIssue({ github, context, owner, repo });
  const issueNumber = issue.number;
  const targetBranch = getTargetBranch(issue.labels);

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
      await addComment(`**Error:** ${err.message}\n\nPlease ensure your update data is in a JSON code block.`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    let updateData;
    try {
      updateData = JSON.parse(rawJson);
    } catch (err) {
      await addComment(`**Error:** Invalid JSON: ${err.message}`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    // 2. Validate against update schema
    const validation = ZoneUpdatePayload.safeParse(updateData);
    if (!validation.success) {
      const errors = validation.error.issues
        .map((i) => `- \`${i.path.join('.')}\`: ${i.message}`)
        .join('\n');
      await addComment(`**Validation failed:**\n\n${errors}`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    const { zoneId, changes } = validation.data;

    if (Object.keys(changes).length === 0) {
      await addComment('**Error:** No changes provided in the update payload.');
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    // 3. Walk zone files to find the existing zone
    const { data: tree } = await github.rest.git.getTree({
      owner,
      repo,
      tree_sha: targetBranch,
      recursive: 'true',
    });

    const zoneFilePaths = tree.tree
      .filter((entry) => entry.type === 'blob' && entry.path.startsWith('zones/') && entry.path.endsWith('/zones.json'))
      .map((entry) => entry.path);

    let foundFilePath = null;
    let existingContent = null;
    let existingFile = null;
    let foundGeohash = null;
    let foundIndex = -1;

    for (const filePath of zoneFilePaths) {
      const { data: file } = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: targetBranch });
      const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));

      for (const [geohash, bucket] of Object.entries(content.zones)) {
        const idx = bucket.findIndex((z) => z.id === zoneId);
        if (idx !== -1) {
          foundFilePath = filePath;
          existingContent = content;
          existingFile = file;
          foundGeohash = geohash;
          foundIndex = idx;
          break;
        }
      }
      if (foundFilePath) break;
    }

    if (!foundFilePath || !existingContent || !existingFile) {
      await addComment(`**Error:** Zone with ID \`${zoneId}\` not found in the repository.`);
      await addLabel('status:invalid');
      await closeIssue();
      return;
    }

    // 4. Apply changes
    const existingZone = existingContent.zones[foundGeohash][foundIndex];
    const updatedZone = {
      ...existingZone,
      ...changes,
      id: existingZone.id,           // Never allow ID changes
      verified: existingZone.verified, // Preserve verified status
      version: existingZone.version + 1,
    };

    // If center changed, the geohash bucket may need to move
    const newGeohash = changes.center
      ? geohashEncode(updatedZone.center.lat, updatedZone.center.lng, GEOHASH_PRECISION)
      : foundGeohash;

    if (newGeohash !== foundGeohash) {
      // Remove from old bucket
      existingContent.zones[foundGeohash].splice(foundIndex, 1);
      if (existingContent.zones[foundGeohash].length === 0) {
        delete existingContent.zones[foundGeohash];
      }
      // Add to new bucket
      if (!existingContent.zones[newGeohash]) {
        existingContent.zones[newGeohash] = [];
      }
      existingContent.zones[newGeohash].push(updatedZone);
    } else {
      existingContent.zones[foundGeohash][foundIndex] = updatedZone;
    }

    existingContent.lastUpdated = new Date().toISOString();

    const newContent = JSON.stringify(existingContent, null, 2) + '\n';

    // 5. Create branch
    const branchName = `zone-update/${targetBranch}/${issueNumber}`;
    const baseRef = await github.rest.git.getRef({ owner, repo, ref: `heads/${targetBranch}` });
    const baseSha = baseRef.data.object.sha;

    try {
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
    } catch { /* branch doesn't exist — that's fine */ }

    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    // 6. Commit the file
    const changedFields = Object.keys(changes).join(', ');
    const commitMessage = `Update zone: ${existingZone.name} (${changedFields})\n\nCloses #${issueNumber}`;

    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: foundFilePath,
      message: commitMessage,
      content: Buffer.from(newContent).toString('base64'),
      sha: existingFile.sha,
      branch: branchName,
    });

    // 7. Create PR
    const pr = await github.rest.pulls.create({
      owner,
      repo,
      title: `Update zone: ${existingZone.name}`,
      body: `Updates parking zone **${existingZone.name}** (ID: \`${zoneId}\`).\n\n**Changed fields:** ${changedFields}\nVersion: ${existingZone.version} → ${updatedZone.version}\n\nCloses #${issueNumber}`,
      head: branchName,
      base: targetBranch,
    });

    // 8. Check auto-merge eligibility (same logic as submissions)
    let shouldAutoMerge = false;

    try {
      const settingsFile = await github.rest.repos.getContent({ owner, repo, path: 'config/settings.json', ref: targetBranch });
      const settings = JSON.parse(Buffer.from(settingsFile.data.content, 'base64').toString('utf-8'));
      if (settings.autoMerge) shouldAutoMerge = true;
    } catch { /* ignore */ }

    if (shouldAutoMerge) {
      try {
        await github.rest.pulls.merge({ owner, repo, pull_number: pr.data.number, merge_method: 'squash' });

        try {
          await updateManifestViaApi({ github, owner, repo, branch: targetBranch });
        } catch (manifestErr) {
          core.warning(`Manifest update failed (non-fatal): ${manifestErr.message}`);
        }

        await addComment(`Zone updated and auto-merged! PR: ${pr.data.html_url}`);
      } catch (err) {
        await addComment(`Zone update PR created but auto-merge failed: ${err.message}\n\nPR: ${pr.data.html_url}`);
      }
    } else {
      await addComment(`Zone update PR created for review: ${pr.data.html_url}`);
    }

    await addLabel('status:completed');
    await closeIssue();

  } catch (err) {
    core.setFailed(`Failed to process zone update: ${err.message}`);
    await addComment(`**Internal error:** ${err.message}\n\nPlease try again or contact a maintainer.`);
    await addLabel('status:error');
  }
}
