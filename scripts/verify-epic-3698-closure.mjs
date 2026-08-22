#!/usr/bin/env node
// Epic #3698 closure verifier (child issue #3712).
//
// Verifies the acceptance surface for "Release and installation verification
// and epic closure" without performing any release/tag/publish mutation:
//   1. exact-head CI evidence for the epic's child PRs
//   2. docs/link checks for the closure documentation surface
//   3. shipped metrics vs the epic #3698 quantitative targets
//   4. migration receipts (schema-validated, machine-readable)
//   5. branch/release/security parity (this change set must not mutate
//      release/tag/publish authority)
//   6. child-issue terminality evidence
//   7. explicit remaining-risk register
//
// Exit codes: 0 = every check passed; 2 = no failures but temporal
// prerequisites remain pending; 1 = at least one check failed.
// Pending is honest non-closure evidence: the mechanism is executable now,
// but the epic cannot close while child issues, releases, or the alias
// retirement window (>= 2 minor releases AND >= 90 days, >= 95% canonical
// usage for 2 consecutive releases, zero known critical integrations) are
// unsatisfied.

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new VerificationError(message);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

// --- Epic contract configuration (issue #3712 acceptance surface) ---------

export const EPIC_CONTRACT = Object.freeze({
  epic: 3698,
  closureIssue: 3712,
  planningDoc: 'docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md',
  remainingRiskRegister: 'receipts/epic-3698/remaining-risk.json',
  receiptsDir: 'receipts/epic-3698',
  childIssues: Object.freeze([3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711]),
  // Every child issue has an explicit expected PR or a null no-dedicated-PR
  // marker. This mapping is shared by the collector and verifier; closure
  // evidence may not substitute an unrelated PR, omit a required PR, or add
  // an unknown PR.
  childPullRequests: Object.freeze({
    3702: 3721,
    3703: 3720,
    3704: 3724,
    3705: 3716,
    3706: 3715,
    3707: 3725,
    3708: 3729,
    // #3709 was closed through coordinated work and has no dedicated PR.
    // Its terminal receipt must carry commit/status evidence directly; an
    // unrelated PR (for example #3727, which closes #3726) is not a substitute.
    3709: null,
    3710: 3719,
    3711: 3723,
  }),
  // Issues whose terminality gates this closure issue per the plan dependency order.
  gateChildren: Object.freeze([3705, 3708, 3709, 3710, 3711]),
  tier0Workflows: Object.freeze(['plan', 'execute', 'review', 'verify']),
  tier0Roles: Object.freeze(['planner', 'executor', 'reviewer', 'verifier']),
  retirementPolicy: Object.freeze({
    minMinorReleases: 2,
    minDays: 90,
    minCanonicalShare: 0.95,
    consecutiveReleases: 2,
    maxCriticalIntegrations: 0,
  }),
  // Paths this epic's change set must never touch (release/tag/publish authority).
  forbiddenChangePatterns: Object.freeze([
    /^\.github\/workflows\/release/,
    /^\.github\/workflows\/.*publish/,
    /^scripts\/release/,
    /^scripts\/sync-version/,
    /^\.npmrc$/,
  ]),
});

const EXPECTED_PR_TO_CHILD = Object.freeze(
  Object.fromEntries(Object.entries(EPIC_CONTRACT.childPullRequests)
    .filter(([, number]) => number !== null)
    .map(([issue, number]) => [number, Number(issue)])),
);

function expectedPullRequest(issue) {
  return EPIC_CONTRACT.childPullRequests[issue];
}

// --- Argument parsing ------------------------------------------------------

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    base: 'origin/dev',
    evidence: null,
    receiptsDir: null,
    changedFiles: null,
    jsonOut: null,
    emitMetricsReceipt: null,
    docPaths: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`missing value for ${key}`);
      return argv[i];
    };
    switch (key) {
      case '--root': args.root = resolve(next()); break;
      case '--base': args.base = next(); break;
      case '--evidence': args.evidence = next(); break;
      case '--receipts-dir': args.receiptsDir = next(); break;
      case '--changed-files': args.changedFiles = next(); break;
      case '--json-out': args.jsonOut = next(); break;
      case '--emit-metrics-receipt': args.emitMetricsReceipt = next(); break;
      case '--docs': args.docPaths = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      default: fail(`unknown argument: ${key}`);
    }
  }
  return args;
}

// --- Measurement (public surface separated from internal modules) ----------

function walkFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

export function measureSurface(root) {
  const rel = walkFiles(root).sort();
  const skills = rel.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split('/')[1]);
  const commands = rel.filter((p) => /^commands\/[^/]+\.md$/.test(p)).map((p) => p.slice('commands/'.length, -3));
  const hookFiles = rel.filter((p) => p.startsWith('src/hooks/'));
  const workflows = rel.filter((p) => p.startsWith('.github/workflows/'));
  const agents = rel.filter((p) => /^src\/agents\/[^/]+\.ts$/.test(p)).map((p) => p.slice('src/agents/'.length, -3));
  return {
    counts: {
      skills: skills.length,
      commands: commands.length,
      hookFiles: hookFiles.length,
      workflows: workflows.length,
      agentDefinitions: agents.length,
    },
    public: { skills, commands, agents },
    measurementSha256: createHash('sha256').update(JSON.stringify(rel)).digest('hex'),
  };
}

// --- Individual checks -----------------------------------------------------
// Each check returns { id, status: 'pass' | 'fail' | 'pending', details, problems }.

function readCiEvidence(evidencePath) {
  if (!evidencePath) return { error: 'no --evidence CI receipt supplied' };
  if (!existsSync(evidencePath)) return { error: `CI evidence file not found: ${evidencePath}` };
  try {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    return { evidence, prs: evidence.pullRequests ?? evidence.payload?.pullRequests };
  } catch (error) {
    return { error: `CI evidence is not valid JSON: ${error.message}` };
  }
}

function checkExactHeadCi(evidencePath) {
  const id = 'exactHeadCi';
  if (!evidencePath) {
    return {
      id,
      status: 'pending',
      details: 'no --evidence CI receipt supplied; exact-head CI evidence for child PRs is collected as prerequisites merge',
      problems: [],
    };
  }
  const loaded = readCiEvidence(evidencePath);
  if (loaded.error) return { id, status: 'fail', details: loaded.error, problems: [loaded.error] };
  const evidence = loaded.evidence;
  const prs = loaded.prs;
  const directIssues = evidence.directIssues ?? evidence.payload?.directIssues;
  const problems = [];
  if (evidence.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!Array.isArray(prs) || prs.length === 0) problems.push('pullRequests must be a non-empty array');
  const expectedPrs = new Set(Object.values(EPIC_CONTRACT.childPullRequests).filter((number) => number !== null));
  const seenPrs = new Set();
  for (const [index, pr] of (Array.isArray(prs) ? prs : []).entries()) {
    const label = `pullRequests[${index}]`;
    if (!isObject(pr)) { problems.push(`${label} must be an object`); continue; }
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) {
      problems.push(`${label}.number must be a positive integer`);
    } else {
      if (seenPrs.has(pr.number)) problems.push(`${label}.number duplicates PR #${pr.number}`);
      seenPrs.add(pr.number);
      if (!expectedPrs.has(pr.number)) {
        problems.push(`${label}.number PR #${pr.number} is not an expected child PR`);
      } else if (pr.childIssue !== EXPECTED_PR_TO_CHILD[pr.number]) {
        problems.push(`${label}.childIssue must equal #${EXPECTED_PR_TO_CHILD[pr.number]} for PR #${pr.number}`);
      }
    }
    if (!isSha(pr.headSha)) problems.push(`${label}.headSha must be a 40-char lowercase hex SHA`);
    if (!isSha(pr.mergeCommitSha)) problems.push(`${label}.mergeCommitSha must be a 40-char lowercase hex SHA`);
    if (pr.state !== 'MERGED') problems.push(`${label}.state must be MERGED, got ${JSON.stringify(pr.state)}`);
    if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
      problems.push(`${label}.checks must be a non-empty array (exact-head proof requires at least one check)`);
      continue;
    }
    for (const [ci, check] of pr.checks.entries()) {
      const clabel = `${label}.checks[${ci}]`;
      if (!isObject(check)) { problems.push(`${clabel} must be an object`); continue; }
      try { requiredString(check.name, `${clabel}.name`); } catch (error) { problems.push(error.message); }
      // Exact-head binding: a check may either pin the SHA it ran against
      // (check.sha) or carry an explicit exactHead: true attestation recorded
      // by a trusted collector at the PR head. Anything else is stale evidence
      // and is rejected.
      const boundBySha = isSha(check.sha);
      const boundByAttestation = check.exactHead === true && !boundBySha;
      if (boundBySha && isSha(pr.headSha) && check.sha !== pr.headSha) {
        problems.push(`${clabel} ran at ${check.sha}, not the exact PR head ${pr.headSha}`);
      } else if (!boundBySha && check.sha !== undefined) {
        problems.push(`${clabel}.sha must be a 40-char lowercase hex SHA when present`);
      } else if (!boundBySha && !boundByAttestation) {
        problems.push(`${clabel} must bind the exact head via .sha or exactHead: true`);
      }
      if (!['success', 'skipped', 'neutral'].includes(check.conclusion)) {
        problems.push(`${clabel}.conclusion must be success|skipped|neutral, got ${JSON.stringify(check.conclusion)}`);
      }
    }
  }
  for (const [issue, number] of Object.entries(EPIC_CONTRACT.childPullRequests)) {
    if (number === null) continue;
    if (!seenPrs.has(number)) problems.push(`missing expected PR #${number} for child issue #${issue}`);
  }
  if (Array.isArray(prs) && prs.length !== expectedPrs.size) {
    problems.push(`pullRequests must contain exactly ${expectedPrs.size} expected child PRs`);
  }
  if (!Array.isArray(directIssues) || directIssues.length !== 1) {
    problems.push('directIssues must contain exactly one independently collected direct issue artifact for #3709');
  } else {
    const [direct] = directIssues;
    const label = 'directIssues[0]';
    if (!isObject(direct)) {
      problems.push(`${label} must be an object`);
    } else {
      if (direct.issue !== 3709) problems.push(`${label}.issue must be 3709`);
      if (direct.state !== 'CLOSED') problems.push(`${label}.state must be CLOSED, got ${JSON.stringify(direct.state)}`);
      if (!isObject(direct.commit) || !isSha(direct.commit.sha)) problems.push(`${label}.commit.sha must be a 40-char lowercase hex SHA`);
      if (!isObject(direct.status) || !isSha(direct.status.sha)) {
        problems.push(`${label}.status.sha must be a 40-char lowercase hex SHA`);
      } else if (direct.commit?.sha !== direct.status.sha) {
        problems.push(`${label}.status.sha must equal commit.sha`);
      }
      if (direct.status?.state !== 'success') problems.push(`${label}.status.state must be success, got ${JSON.stringify(direct.status?.state)}`);
      if (!isObject(direct.source) || !isNonEmptyString(direct.source.issue) || !isNonEmptyString(direct.source.commit) || !isNonEmptyString(direct.source.status)) {
        problems.push(`${label}.source must identify independent issue, commit, and status API evidence`);
      }
    }
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `${prs.length} PR(s) verified green at exact head`, problems }
    : { id, status: 'fail', details: `${problems.length} exact-head CI problem(s)`, problems };
}

const MARKDOWN_INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
const REFERENCE_LABEL_ESCAPABLE = new Set(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`);

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function findClosingBracket(text, opening) {
  for (let index = opening + 1; index < text.length; index += 1) {
    if (text[index] === ']' && !isEscaped(text, index)) return index;
  }
  return -1;
}

function unescapeReferenceLabel(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length && REFERENCE_LABEL_ESCAPABLE.has(value[index + 1])) {
      result += value[index + 1];
      index += 1;
    } else {
      result += value[index];
    }
  }
  return result;
}

function referenceLabel(value) {
  return unescapeReferenceLabel(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function markdownDestination(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

function isReferenceDefinitionPosition(text, opening, closing) {
  const lineStart = text.lastIndexOf('\n', opening - 1) + 1;
  const prefix = text.slice(lineStart, opening);
  return /^ {0,3}$/.test(prefix) && text[closing + 1] === ':';
}

function parseReferenceDefinitions(text) {
  const definitions = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const leading = line.match(/^ {0,3}/)?.[0].length ?? 0;
    if (line[leading] !== '[') continue;
    const closing = findClosingBracket(line, leading);
    if (closing < 0 || line[closing + 1] !== ':') continue;
    const rest = line.slice(closing + 2).trimStart();
    if (!rest) continue;
    const destination = rest.startsWith('<')
      ? rest.slice(1, rest.indexOf('>') < 0 ? rest.length : rest.indexOf('>'))
      : rest.split(/\s+/)[0];
    if (destination) definitions.set(referenceLabel(line.slice(leading + 1, closing)), markdownDestination(destination));
  }
  return definitions;
}

function collectReferenceTargets(text, definitions, problems, docPath) {
  const targets = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[' || isEscaped(text, index)) continue;
    const firstClosing = findClosingBracket(text, index);
    if (firstClosing < 0) continue;
    if (isReferenceDefinitionPosition(text, index, firstClosing)) {
      index = firstClosing;
      continue;
    }
    const firstLabel = text.slice(index + 1, firstClosing);
    const next = text[firstClosing + 1];
    if (next === '(') {
      index = firstClosing;
      continue;
    }
    if (next === '[') {
      const secondClosing = findClosingBracket(text, firstClosing + 1);
      if (secondClosing < 0) continue;
      const secondLabel = text.slice(firstClosing + 2, secondClosing);
      const label = referenceLabel(secondLabel || firstLabel);
      const target = definitions.get(label);
      if (target === undefined) problems.push(`${docPath}: missing reference definition [${secondLabel || firstLabel}]`);
      else targets.push(target);
      index = secondClosing;
      continue;
    }
    const target = definitions.get(referenceLabel(firstLabel));
    if (target !== undefined) targets.push(target);
    index = firstClosing;
  }
  return targets;
}

function isPathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPathWithinRoot(root, candidate, label, problems) {
  if (!isPathWithin(root, candidate)) {
    problems.push(`${label} escapes repository root`);
    return null;
  }
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!isPathWithin(root, canonical)) {
    problems.push(`${label} resolves outside repository root`);
    return null;
  }
  return canonical;
}

function checkDocsLinks(root, docPaths) {
  const id = 'docsLinks';
  const problems = [];
  let scanned = 0;
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch (error) {
    return { id, status: 'fail', details: `repository root is not readable: ${error.message}`, problems: ['unreadable repository root'] };
  }
  for (const docPath of docPaths) {
    const absolute = resolve(canonicalRoot, docPath);
    if (!isPathWithin(canonicalRoot, absolute)) {
      problems.push(`document ${docPath} escapes repository root`);
      continue;
    }
    if (!existsSync(absolute)) {
      // The planning doc lives on the planning branch until PR #3701 merges;
      // a missing doc that is not owned by this issue is pending, not broken.
      if (docPath === EPIC_CONTRACT.planningDoc) continue;
      problems.push(`document not found: ${docPath}`);
      continue;
    }
    const canonicalDoc = canonicalPathWithinRoot(canonicalRoot, absolute, `document ${docPath}`, problems);
    if (!canonicalDoc) continue;
    scanned += 1;
    let text;
    try {
      text = readFileSync(canonicalDoc, 'utf8');
    } catch (error) {
      problems.push(`document ${docPath} is not readable: ${error.message}`);
      continue;
    }
    const definitions = parseReferenceDefinitions(text);
    const targets = [...text.matchAll(MARKDOWN_INLINE_LINK)].map((match) => match[1]);
    targets.push(...collectReferenceTargets(text, definitions, problems, docPath));
    // Definitions are destinations too: an unreferenced definition must not
    // hide a traversal or symlink escape from the closure document scan.
    for (const target of definitions.values()) targets.push(target);
    for (const rawTarget of targets) {
      const target = markdownDestination(rawTarget);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue; // external or anchor
      if (target.startsWith('//')) continue;
      const cleaned = target.split('#')[0];
      if (!cleaned) continue;
      const resolved = resolve(join(canonicalDoc, '..'), cleaned);
      const canonicalTarget = canonicalPathWithinRoot(canonicalRoot, resolved, `${docPath}: link ${target}`, problems);
      if (!canonicalTarget && isPathWithin(canonicalRoot, resolved)) {
        if (!existsSync(resolved)) problems.push(`${docPath}: broken relative link ${target}`);
      }
    }
  }
  if (scanned === 0) return { id, status: 'pending', details: 'no closure documents present to scan yet', problems };
  return problems.length === 0
    ? { id, status: 'pass', details: `${scanned} document(s) scanned, all relative links resolve`, problems }
    : { id, status: 'fail', details: `${problems.length} broken link(s)`, problems };
}

// Metric definitions: predicate over the measured surface plus the child
// issues that own the target. A missed target is `pending` while any owning
// child lacks terminal evidence and `fail` once every owner is terminal.
const METRICS = [
  {
    id: 'tier0WorkflowSkills',
    owners: [3703, 3705, 3708, 3710],
    describe: 'exactly the Tier-0 workflows plan/execute/review/verify exist as workflow skills',
    evaluate: (m) => EPIC_CONTRACT.tier0Workflows.every((w) => m.public.skills.includes(w)),
  },
  {
    id: 'tier0Roles',
    owners: [3703, 3705, 3708],
    describe: 'Tier-0 role agents planner/executor/reviewer/verifier are defined',
    evaluate: (m) => EPIC_CONTRACT.tier0Roles.every((r) => m.public.agents.includes(r)),
  },
  {
    id: 'commandEntrypoints',
    owners: [3703, 3705, 3708, 3710],
    describe: 'command entrypoints reduced to 12-18 canonical',
    evaluate: (m) => m.counts.commands >= 12 && m.counts.commands <= 18,
  },
  {
    id: 'githubWorkflows',
    owners: [3709, 3705, 3708],
    describe: 'GitHub workflows reduced to the smallest proven set (target 5, acceptable 5-6)',
    evaluate: (m) => m.counts.workflows >= 5 && m.counts.workflows <= 6,
  },
];

function checkShippedMetrics(measured, terminalChildren) {
  const id = 'shippedMetrics';
  const details = [];
  const problems = [];
  let worst = 'pass';
  for (const metric of METRICS) {
    const met = metric.evaluate(measured);
    if (met) {
      details.push(`${metric.id}: met`);
      continue;
    }
    const ownersTerminal = metric.owners.every((issue) => terminalChildren.has(issue));
    if (ownersTerminal) {
      worst = 'fail';
      problems.push(`${metric.id}: target unmet although owning child issue(s) ${metric.owners.join(', ')} are terminal — ${metric.describe}`);
    } else {
      if (worst === 'pass') worst = 'pending';
      details.push(`${metric.id}: not yet met; awaiting owning child issue(s) ${metric.owners.filter((i) => !terminalChildren.has(i)).join(', ')}`);
    }
  }
  return {
    id,
    status: worst,
    details: details.concat(problems).join('; ') || 'all metrics met',
    problems,
    measured: measured.counts,
  };
}

const RECEIPT_KINDS = new Set(['metrics-snapshot', 'alias-usage', 'ci-evidence', 'child-terminal', 'remaining-risk', 'install-verification']);

function validateReceipt(file, receipt, problems) {
  const label = `receipt ${file}`;
  if (!isObject(receipt)) { problems.push(`${label} must be an object`); return null; }
  if (receipt.schemaVersion !== 1) problems.push(`${label}.schemaVersion must be 1`);
  try { requiredString(receipt.kind, `${label}.kind`); } catch (error) { problems.push(error.message); }
  if (typeof receipt.kind === 'string' && !RECEIPT_KINDS.has(receipt.kind)) {
    problems.push(`${label}.kind must be one of ${[...RECEIPT_KINDS].join(', ')}`);
  }
  if (!Number.isSafeInteger(receipt.issue) || receipt.issue < 1) problems.push(`${label}.issue must be a positive integer`);
  try { requiredString(receipt.createdAt, `${label}.createdAt`); } catch (error) { problems.push(error.message); }
  if (!isObject(receipt.payload)) { problems.push(`${label}.payload must be an object`); return null; }
  if (receipt.kind === 'alias-usage') {
    const p = receipt.payload;
    const policy = EPIC_CONTRACT.retirementPolicy;
    if (typeof p.canonicalShare !== 'number' || p.canonicalShare < 0 || p.canonicalShare > 1) {
      problems.push(`${label}.payload.canonicalShare must be a number in [0,1]`);
    }
    if (!Number.isSafeInteger(p.minorReleases) || p.minorReleases < 0) problems.push(`${label}.payload.minorReleases must be a non-negative integer`);
    if (!Number.isSafeInteger(p.daysSinceDeprecation) || p.daysSinceDeprecation < 0) problems.push(`${label}.payload.daysSinceDeprecation must be a non-negative integer`);
    if (!Number.isSafeInteger(p.consecutiveReleasesAtThreshold) || p.consecutiveReleasesAtThreshold < 0) {
      problems.push(`${label}.payload.consecutiveReleasesAtThreshold must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(p.knownCriticalIntegrations) || p.knownCriticalIntegrations < 0) {
      problems.push(`${label}.payload.knownCriticalIntegrations must be a non-negative integer`);
    }
    const satisfied = problems.length === 0
      && p.minorReleases >= policy.minMinorReleases
      && p.daysSinceDeprecation >= policy.minDays
      && p.canonicalShare >= policy.minCanonicalShare
      && p.consecutiveReleasesAtThreshold >= policy.consecutiveReleases
      && p.knownCriticalIntegrations <= policy.maxCriticalIntegrations;
    return { kind: receipt.kind, issue: receipt.issue, retirementSatisfied: satisfied };
  }
  if (receipt.kind === 'child-terminal') {
    const receiptProblemsStart = problems.length;
    const p = receipt.payload;
    if (!['merged', 'closed'].includes(p.state)) problems.push(`${label}.payload.state must be merged|closed`);
    const expectedPr = expectedPullRequest(receipt.issue);
    if (expectedPr === undefined) problems.push(`${label}.issue ${receipt.issue} is not an expected child issue`);
    const evidence = p.evidence;
    const evidenceSummary = {};
    if (!isObject(evidence)) {
      problems.push(`${label}.payload.evidence must be a structured object with pullRequest, commit, and status evidence`);
    } else {
      const pullRequest = evidence.pullRequest;
      if (expectedPr === null) {
        if (pullRequest !== undefined && pullRequest !== null) {
          problems.push(`${label}.payload.evidence.pullRequest must be omitted for child issue #${receipt.issue}; no dedicated PR is expected`);
        }
        const directIssue = evidence.issue;
        if (!isObject(directIssue)) {
          problems.push(`${label}.payload.evidence.issue must be an object for child issue #${receipt.issue}`);
        } else {
          if (directIssue.number !== receipt.issue) problems.push(`${label}.payload.evidence.issue.number must equal child issue #${receipt.issue}`);
          if (directIssue.state !== 'CLOSED') problems.push(`${label}.payload.evidence.issue.state must be CLOSED`);
          evidenceSummary.issueNumber = directIssue.number;
          evidenceSummary.issueState = directIssue.state;
        }
        evidenceSummary.pullRequest = null;
      } else if (!isObject(pullRequest)) {
        problems.push(`${label}.payload.evidence.pullRequest must be an object`);
      } else {
        try { requiredPositiveInteger(pullRequest.number, `${label}.payload.evidence.pullRequest.number`); } catch (error) { problems.push(error.message); }
        if (!isSha(pullRequest.headSha)) problems.push(`${label}.payload.evidence.pullRequest.headSha must be a 40-char lowercase hex SHA`);
        if (Number.isSafeInteger(pullRequest.number) && pullRequest.number !== expectedPr) {
          problems.push(`${label}.payload.evidence.pullRequest.number ${pullRequest.number} does not match expected PR #${expectedPr} for child issue #${receipt.issue}`);
        }
        if (pullRequest.headSha) evidenceSummary.headSha = pullRequest.headSha;
        if (Number.isSafeInteger(pullRequest.number)) evidenceSummary.pullRequest = pullRequest.number;
      }
      const commit = evidence.commit;
      if (!isObject(commit)) {
        problems.push(`${label}.payload.evidence.commit must be an object`);
      } else if (!isSha(commit.sha)) {
        problems.push(`${label}.payload.evidence.commit.sha must be a 40-char lowercase hex SHA`);
      } else {
        evidenceSummary.commitSha = commit.sha;
      }
      const status = evidence.status;
      if (!isObject(status)) {
        problems.push(`${label}.payload.evidence.status must be an object`);
      } else {
        if (expectedPr === null) {
          if (status.state !== 'success') problems.push(`${label}.payload.evidence.status.state must be success when no dedicated PR is expected`);
        } else if (!['success', 'skipped', 'neutral'].includes(status.conclusion)) {
          problems.push(`${label}.payload.evidence.status.conclusion must be success|skipped|neutral`);
        }
        if (!isSha(status.sha)) {
          problems.push(`${label}.payload.evidence.status.sha must be a 40-char lowercase hex SHA`);
        } else if (evidenceSummary.headSha && status.sha !== evidenceSummary.headSha) {
          problems.push(`${label}.payload.evidence.status.sha must equal pullRequest.headSha`);
        } else if (expectedPr === null && evidenceSummary.commitSha && status.sha !== evidenceSummary.commitSha) {
          problems.push(`${label}.payload.evidence.status.sha must equal commit.sha when no dedicated PR is expected`);
        }
        evidenceSummary.statusConclusion = status.conclusion;
        evidenceSummary.statusState = status.state;
        evidenceSummary.statusSha = status.sha;
      }
    }
    return {
      kind: receipt.kind,
      issue: receipt.issue,
      state: p.state,
      valid: problems.length === receiptProblemsStart,
      childEvidence: evidenceSummary,
    };
  }
  return { kind: receipt.kind, issue: receipt.issue };
}

function readReceipts(receiptsDir) {
  const receipts = [];
  const problems = [];
  if (!existsSync(receiptsDir)) {
    return { receipts, problems, missing: true };
  }
  for (const file of readdirSync(receiptsDir).filter((f) => f.endsWith('.receipt.json')).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
    } catch (error) {
      problems.push(`receipt ${file} is not valid JSON: ${error.message}`);
      continue;
    }
    const summary = validateReceipt(file, parsed, problems);
    if (summary) receipts.push({ file, ...summary });
  }
  return { receipts, problems, missing: false };
}

function checkMigrationReceipts(receiptsDir) {
  const id = 'migrationReceipts';
  const { receipts, problems, missing } = readReceipts(receiptsDir);
  if (missing) {
    return { id, status: 'pending', details: `receipts directory ${receiptsDir} does not exist yet`, problems };
  }
  if (problems.length > 0) {
    return { id, status: 'fail', details: `${problems.length} receipt problem(s)`, problems };
  }
  if (receipts.length === 0) {
    return { id, status: 'pending', details: 'no migration receipts recorded yet', problems };
  }
  return { id, status: 'pass', details: `${receipts.length} schema-valid receipt(s)`, problems };
}

function checkRetirementPolicy(receiptsDir) {
  const id = 'aliasRetirementPolicy';
  const { receipts, missing } = readReceipts(receiptsDir);
  if (missing || receipts.filter((r) => r.kind === 'alias-usage').length === 0) {
    return {
      id,
      status: 'pending',
      details: 'no alias-usage receipts; retirement requires >= 2 minor releases AND >= 90 days, >= 95% canonical usage for 2 consecutive releases, and zero known critical integrations',
      problems: [],
    };
  }
  const unsatisfied = receipts.filter((r) => r.kind === 'alias-usage' && !r.retirementSatisfied);
  return unsatisfied.length === 0
    ? { id, status: 'pass', details: 'all alias-usage receipts satisfy the retirement policy', problems: [] }
    : {
        id,
        status: 'pending',
        details: `${unsatisfied.length} alias-usage receipt(s) do not yet satisfy the retirement window; aliases must NOT be removed`,
        problems: [],
      };
}

// Returns { files } when the change set is computable, or { unavailable }
// when git/base refs are absent (e.g. shallow CI checkouts). An unavailable
// change set must surface as pending evidence, never as a thrown error that
// empties the machine-readable stdout report.
function normalizeChangedFile(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function gitDiffNames(root, base) {
  for (const candidate of [base, base.startsWith('origin/') ? base : `origin/${base}`, 'HEAD^']) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', candidate, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!isSha(mergeBase)) continue;
      const out = execFileSync('git', ['diff', '--name-only', mergeBase, 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return {
        files: out.split('\n').map((line) => line.trim()).filter(Boolean).map(normalizeChangedFile),
        resolvedBase: candidate,
        mergeBase,
      };
    } catch {
      // try the next base candidate
    }
  }
  return null;
}

function listChangedFiles(root, base, changedFilesArg) {
  if (changedFilesArg) {
    let supplied;
    try {
      supplied = readFileSync(changedFilesArg, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).map(normalizeChangedFile);
    } catch (error) {
      return { files: [], inputError: `unable to read --changed-files input: ${error.message}` };
    }
    const exact = gitDiffNames(root, base);
    return exact
      ? { files: supplied, exactFiles: exact.files, resolvedBase: exact.resolvedBase, mergeBase: exact.mergeBase }
      : { files: supplied, suppliedOnly: true };
  }
  const exact = gitDiffNames(root, base);
  return exact ?? { unavailable: true };
}

function checkReleaseSecurityParity(root, base, changedFilesArg) {
  const id = 'releaseSecurityParity';
  const problems = [];
  const changeSet = listChangedFiles(root, base, changedFilesArg);
  if (changeSet.unavailable) {
    return {
      id,
      status: 'pending',
      details: `change set unavailable (no usable git base among ${base}, origin/${base}, HEAD^); run with --changed-files or a fetchable base ref to prove release/security parity`,
      problems,
    };
  }
  if (changeSet.inputError) problems.push(changeSet.inputError);
  const suppliedFiles = [...new Set(changeSet.files)];
  const exactFiles = changeSet.exactFiles ? [...new Set(changeSet.exactFiles)] : null;
  if (exactFiles) {
    const suppliedSet = new Set(suppliedFiles);
    const exactSet = new Set(exactFiles);
    const omitted = exactFiles.filter((file) => !suppliedSet.has(file));
    const extra = suppliedFiles.filter((file) => !exactSet.has(file));
    if (omitted.length > 0 || extra.length > 0) {
      problems.push(`--changed-files does not match exact git diff (omitted: ${omitted.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
    }
  }
  const files = exactFiles ?? suppliedFiles;
  for (const file of files) {
    for (const pattern of EPIC_CONTRACT.forbiddenChangePatterns) {
      if (pattern.test(file)) problems.push(`change set touches release/publish authority surface: ${file}`);
    }
  }
  if (changeSet.suppliedOnly) {
    if (problems.length > 0) {
      return { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
    }
    return {
      id,
      status: 'pending',
      details: 'changed-files input is unauthenticated because no exact Git base/head diff is available; parity cannot be established from caller-supplied paths alone',
      problems: ['exact Git diff unavailable for --changed-files input'],
    };
  }
  // Version bumps are release mutations; inspect package.json content diff.
  const packageClaimedChanged = files.includes('package.json') || suppliedFiles.includes('package.json');
  if (packageClaimedChanged) {
    if (!changeSet.mergeBase) {
      problems.push('package.json is listed as changed but the exact package.json git diff is unavailable; --changed-files cannot bypass version inspection');
    } else {
      let basePackage;
      let headPackage;
      try {
        basePackage = JSON.parse(execFileSync('git', ['show', `${changeSet.mergeBase}:package.json`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        headPackage = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (error) {
        problems.push(`unable to parse package.json at the exact base/head refs: ${error.message}`);
        basePackage = null;
        headPackage = null;
      }
      if (!isObject(basePackage) || !isObject(headPackage)) {
        problems.push('package.json must be a JSON object at both exact base and HEAD refs');
      } else {
        if (typeof basePackage.version !== 'string' || typeof headPackage.version !== 'string') {
          problems.push('package.json version must be a string at both exact base and HEAD refs');
        } else if (basePackage.version !== headPackage.version) {
          problems.push(`change set mutates package.json "version" (${basePackage.version} -> ${headPackage.version}) (release mutation)`);
        }
      }
    }
  }
  if (changeSet.inputError) {
    return { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `no release/tag/publish mutation across ${files.length} changed file(s)`, problems }
    : { id, status: 'fail', details: `${problems.length} release/security parity violation(s)`, problems };
}

function checkChildTerminality(receiptsDir, evidencePath) {
  const id = 'childTerminality';
  const { receipts, problems: receiptProblems, missing } = readReceipts(receiptsDir);
  const problems = [...receiptProblems];
  const terminal = new Set();
  const seenIssues = new Set();
  if (!missing) {
    for (const r of receipts) {
      if (r.kind !== 'child-terminal') continue;
      if (seenIssues.has(r.issue)) problems.push(`duplicate terminal receipt for child issue #${r.issue}`);
      seenIssues.add(r.issue);
      if (r.valid && ['merged', 'closed'].includes(r.state)) terminal.add(r.issue);
    }
  }
  const pendingIssues = [];
  for (const issue of EPIC_CONTRACT.childIssues) {
    if (!terminal.has(issue)) pendingIssues.push(issue);
  }
  const loadedCi = readCiEvidence(evidencePath);
  const ciByNumber = new Map();
  const directIssueByNumber = new Map();
  if (!loadedCi.error && Array.isArray(loadedCi.prs)) {
    for (const pr of loadedCi.prs) {
      if (isObject(pr) && Number.isSafeInteger(pr.number) && !ciByNumber.has(pr.number)) ciByNumber.set(pr.number, pr);
    }
  }
  const directIssues = loadedCi.evidence?.directIssues ?? loadedCi.evidence?.payload?.directIssues;
  if (!loadedCi.error && Array.isArray(directIssues)) {
    for (const direct of directIssues) {
      if (isObject(direct) && Number.isSafeInteger(direct.issue) && !directIssueByNumber.has(direct.issue)) {
        directIssueByNumber.set(direct.issue, direct);
      }
    }
  }
  const ciRequiredReceipts = receipts.filter((receipt) => (
    receipt.kind === 'child-terminal'
      && receipt.valid
      && ['merged', 'closed'].includes(receipt.state)
      && expectedPullRequest(receipt.issue) !== null
      && expectedPullRequest(receipt.issue) !== undefined
  ));
  const directRequiredReceipts = receipts.filter((receipt) => (
    receipt.kind === 'child-terminal'
      && receipt.valid
      && ['merged', 'closed'].includes(receipt.state)
      && expectedPullRequest(receipt.issue) === null
  ));
  if (!loadedCi.error) {
    for (const receipt of receipts) {
      if (receipt.kind !== 'child-terminal' || !receipt.valid || !['merged', 'closed'].includes(receipt.state)) continue;
      const expectedPr = expectedPullRequest(receipt.issue);
      if (expectedPr === null) {
        const evidence = receipt.childEvidence ?? {};
        const direct = directIssueByNumber.get(receipt.issue);
        if (!direct) {
          problems.push(`child issue #${receipt.issue} terminal receipt requires independently collected direct issue/commit/status evidence`);
          continue;
        }
        if (evidence.issueNumber !== direct.issue || evidence.issueState !== direct.state) {
          problems.push(`child issue #${receipt.issue} terminal receipt issue evidence does not match the independently collected direct issue artifact`);
        }
        if (evidence.commitSha !== direct.commit?.sha) {
          problems.push(`child issue #${receipt.issue} terminal receipt commit does not match the independently collected direct issue artifact`);
        }
        if (evidence.statusSha !== direct.status?.sha || evidence.statusState !== direct.status?.state) {
          problems.push(`child issue #${receipt.issue} terminal receipt status does not match the independently collected direct issue artifact`);
        }
        continue;
      }
      if (expectedPr === undefined) continue;
      const evidence = receipt.childEvidence ?? {};
      const ciPr = ciByNumber.get(expectedPr);
      if (!ciPr) {
        problems.push(`child issue #${receipt.issue} terminal receipt references expected PR #${expectedPr}, which is missing from CI evidence`);
        continue;
      }
      if (evidence.pullRequest !== expectedPr) {
        problems.push(`child issue #${receipt.issue} terminal receipt PR #${evidence.pullRequest ?? 'missing'} does not match expected PR #${expectedPr}`);
      }
      if (evidence.headSha !== ciPr.headSha) {
        problems.push(`child issue #${receipt.issue} terminal receipt head ${evidence.headSha ?? 'missing'} does not match CI evidence head ${ciPr.headSha ?? 'missing'} for PR #${expectedPr}`);
      }
      if (evidence.commitSha !== ciPr.mergeCommitSha) {
        problems.push(`child issue #${receipt.issue} terminal receipt commit ${evidence.commitSha ?? 'missing'} does not match CI evidence merge commit ${ciPr.mergeCommitSha} for PR #${expectedPr}`);
      }
      if (!Array.isArray(ciPr.checks) || ciPr.checks.length === 0) {
        problems.push(`CI evidence for expected PR #${expectedPr} has no structured status checks for child issue #${receipt.issue}`);
      }
    }
  } else if (ciRequiredReceipts.length > 0 || directRequiredReceipts.length > 0) {
    problems.push(`child terminal receipts require independently verifiable CI evidence: ${loadedCi.error}`);
  }
  const gatesOpen = EPIC_CONTRACT.gateChildren.filter((issue) => !terminal.has(issue));
  const details = pendingIssues.length === 0
    ? 'all child issues have terminal evidence'
    : `awaiting terminal evidence for child issue(s): ${pendingIssues.join(', ')}`;
  return {
    id,
    status: problems.length > 0 ? 'fail' : pendingIssues.length === 0 ? 'pass' : 'pending',
    details: gatesOpen.length > 0 ? `${details}; gate children still open: ${gatesOpen.join(', ')}` : details,
    problems,
    terminal: [...terminal],
  };
}

function checkRemainingRisk(root) {
  const id = 'remainingRisk';
  const registerPath = join(root, EPIC_CONTRACT.remainingRiskRegister);
  if (!existsSync(registerPath)) {
    return { id, status: 'fail', details: `remaining-risk register missing: ${EPIC_CONTRACT.remainingRiskRegister}`, problems: ['missing register'] };
  }
  let register;
  try {
    register = JSON.parse(readFileSync(registerPath, 'utf8'));
  } catch (error) {
    return { id, status: 'fail', details: `remaining-risk register is not valid JSON: ${error.message}`, problems: ['invalid JSON'] };
  }
  const problems = [];
  if (register.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!Array.isArray(register.risks) || register.risks.length === 0) {
    problems.push('risks must be a non-empty array (explicit remaining-risk evidence is required, even if every entry is monitored)');
  }
  for (const [index, risk] of (Array.isArray(register.risks) ? register.risks : []).entries()) {
    const label = `risks[${index}]`;
    if (!isObject(risk)) { problems.push(`${label} must be an object`); continue; }
    for (const field of ['id', 'description', 'severity', 'mitigation', 'status']) {
      try { requiredString(risk[field], `${label}.${field}`); } catch (error) { problems.push(error.message); }
    }
    if (typeof risk.severity === 'string' && !['low', 'medium', 'high', 'critical'].includes(risk.severity)) {
      problems.push(`${label}.severity must be low|medium|high|critical`);
    }
    if (typeof risk.status === 'string' && !['open', 'monitored', 'mitigated', 'accepted'].includes(risk.status)) {
      problems.push(`${label}.status must be open|monitored|mitigated|accepted`);
    }
  }
  return problems.length === 0
    ? { id, status: 'pass', details: `${register.risks.length} remaining risk(s) explicitly registered`, problems }
    : { id, status: 'fail', details: `${problems.length} register problem(s)`, problems };
}

// --- Driver ----------------------------------------------------------------

export function runVerification(args) {
  const root = args.root;
  const receiptsDir = args.receiptsDir ?? join(root, EPIC_CONTRACT.receiptsDir);
  const measured = measureSurface(root);

  if (args.emitMetricsReceipt) {
    const receipt = {
      schemaVersion: 1,
      kind: 'metrics-snapshot',
      issue: EPIC_CONTRACT.closureIssue,
      createdAt: new Date().toISOString(),
      payload: { ...measured.counts, measurementSha256: measured.measurementSha256, base: args.base },
    };
    writeFileSync(args.emitMetricsReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  const childCheck = checkChildTerminality(receiptsDir, args.evidence);
  const terminalChildren = new Set(childCheck.terminal ?? []);
  const docPaths = args.docPaths ?? [
    EPIC_CONTRACT.planningDoc,
    'docs/design/ISSUE-3712-RELEASE-VERIFICATION.md',
    'receipts/epic-3698/README.md',
  ];

  const checks = [
    checkExactHeadCi(args.evidence),
    checkDocsLinks(root, docPaths),
    checkShippedMetrics(measured, terminalChildren),
    checkMigrationReceipts(receiptsDir),
    checkRetirementPolicy(receiptsDir),
    checkReleaseSecurityParity(root, args.base, args.changedFiles),
    childCheck,
    checkRemainingRisk(root),
  ];

  const failed = checks.filter((c) => c.status === 'fail');
  const pending = checks.filter((c) => c.status === 'pending');
  const verdict = failed.length > 0 ? 'FAIL' : pending.length > 0 ? 'PENDING_TEMPORAL' : 'PASS';
  return {
    schemaVersion: 1,
    kind: 'epic-3698-closure-verdict',
    epic: EPIC_CONTRACT.epic,
    issue: EPIC_CONTRACT.closureIssue,
    generatedAt: new Date().toISOString(),
    verdict,
    exitCode: verdict === 'PASS' ? 0 : verdict === 'PENDING_TEMPORAL' ? 2 : 1,
    checks,
    temporalConditions: pending.map((c) => ({ check: c.id, details: c.details })),
    note: 'No release/tag/publish mutation is performed or authorized by this verifier. Pending temporal conditions record why epic #3698 must remain open; they are not failures of the mechanism.',
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = runVerification(args);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonOut) writeFileSync(args.jsonOut, json);
  process.stdout.write(json);
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'PENDING';
    process.stderr.write(`[${mark}] ${check.id}: ${check.details}\n`);
    for (const problem of check.problems) process.stderr.write(`  - ${problem}\n`);
  }
  process.stderr.write(`verdict: ${report.verdict}\n`);
  return report.exitCode;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`verify-epic-3698-closure: ${error.message}\n`);
    process.exitCode = 1;
  }
}
