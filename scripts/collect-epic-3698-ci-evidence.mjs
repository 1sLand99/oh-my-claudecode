#!/usr/bin/env node
// Collects exact-head CI evidence for epic #3698 child PRs via `gh` and emits
// the JSON evidence document consumed by scripts/verify-epic-3698-closure.mjs
// (--evidence). Read-only against GitHub; never mutates PRs, branches, or
// releases. Each check is attested at the PR head OID reported by gh at
// collection time (exactHead: true); the verifier rejects checks whose
// recorded sha disagrees with the PR head.
//
// Usage:
//   node scripts/collect-epic-3698-ci-evidence.mjs --prs 3715,3716,3719,3720,3721,3723,3724,3725,3729 --out <path>
//   node scripts/collect-epic-3698-ci-evidence.mjs --all-children --out <path>

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { EPIC_CONTRACT } from './verify-epic-3698-closure.mjs';

function fail(message) {
  process.stderr.write(`collect-epic-3698-ci-evidence: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { prs: null, allChildren: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--prs': {
        const raw = argv[++i];
        if (!raw) fail('--prs requires a comma-separated PR list');
        const values = raw.split(',').map((s) => s.trim());
        if (values.some((value) => !/^\d+$/.test(value))) fail('--prs must contain only positive integer PR numbers');
        args.prs = values.map((value) => Number(value));
        break;
      }
      case '--all-children': args.allChildren = true; break;
      case '--out': args.out = argv[++i]; break;
      default: fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.out) fail('--out is required');
  if (!args.allChildren && (!args.prs || args.prs.length === 0)) fail('--prs or --all-children is required');
  return args;
}

const EXPECTED_CHILD_PR_ENTRIES = Object.entries(EPIC_CONTRACT.childPullRequests)
  .filter(([, number]) => number !== null)
  .map(([issue, number]) => ({ issue: Number(issue), number }));
const EXPECTED_PR_NUMBERS = new Set(EXPECTED_CHILD_PR_ENTRIES.map(({ number }) => number));

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function collectPr(issue, number) {
  const pr = ghJson(['pr', 'view', String(number), '--json', 'number,headRefOid,mergeCommit,state,statusCheckRollup']);
  if (pr.number !== number) fail(`gh returned PR #${pr.number} while collecting expected PR #${number} for child issue #${issue}`);
  if (pr.state !== 'MERGED') fail(`expected PR #${number} for child issue #${issue} is not merged (state: ${pr.state ?? 'missing'})`);
  if (typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) {
    fail(`PR #${number} for child issue #${issue} has no valid exact head SHA`);
  }
  const checks = (pr.statusCheckRollup ?? [])
    .filter((c) => (c.workflowName || c.context) && (c.conclusion || c.status))
    .map((c) => ({
      name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.context,
      conclusion: String(c.conclusion ?? c.status).toLowerCase(),
      sha: pr.headRefOid,
    }));
  const mergeCommitSha = pr.mergeCommit?.oid;
  if (typeof mergeCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(mergeCommitSha)) {
    fail(`merged PR #${number} for child issue #${issue} has no valid merge commit SHA`);
  }
  return { childIssue: issue, number: pr.number, headSha: pr.headRefOid, mergeCommitSha, state: pr.state, checks };
}

function collectDirectIssue(issue, repository) {
  const issueData = ghJson(['issue', 'view', String(issue), '--json', 'number,state']);
  if (issueData.number !== issue) fail(`gh returned issue #${issueData.number} while collecting expected issue #${issue}`);
  if (issueData.state !== 'CLOSED') fail(`expected direct issue #${issue} is not closed (state: ${issueData.state ?? 'missing'})`);

  const timeline = ghJson([
    'api',
    `repos/${repository}/issues/${issue}/timeline?per_page=100`,
    '--header',
    'Accept: application/vnd.github+json',
  ]);
  const commits = (Array.isArray(timeline) ? timeline : [])
    .filter((event) => event.event === 'committed' && typeof event.sha === 'string' && /^[0-9a-f]{40}$/.test(event.sha));
  const commit = commits.at(-1);
  if (!commit) fail(`direct issue #${issue} has no independently referenced commit in its timeline`);

  const status = ghJson([
    'api',
    `repos/${repository}/commits/${commit.sha}/status`,
    '--header',
    'Accept: application/vnd.github+json',
  ]);
  if (status.sha !== commit.sha) fail(`direct issue #${issue} status SHA does not match commit ${commit.sha}`);
  if (status.state !== 'success') fail(`direct issue #${issue} commit ${commit.sha} is not green (status: ${status.state ?? 'missing'})`);
  return {
    issue,
    state: issueData.state,
    commit: { sha: commit.sha },
    status: { sha: status.sha, state: status.state },
    source: {
      issue: `repos/${repository}/issues/${issue}`,
      commit: `repos/${repository}/issues/${issue}/timeline`,
      status: `repos/${repository}/commits/${commit.sha}/status`,
    },
  };
}

function findChildPrs() {
  return EXPECTED_CHILD_PR_ENTRIES.map(({ number }) => number);
}

function validateRequestedPrs(numbers) {
  const seen = new Set();
  for (const number of numbers) {
    if (seen.has(number)) fail(`duplicate PR #${number} in --prs`);
    seen.add(number);
    if (!EXPECTED_PR_NUMBERS.has(number)) fail(`unknown PR #${number}; expected exactly ${[...EXPECTED_PR_NUMBERS].join(', ')}`);
  }
  for (const expected of EXPECTED_PR_NUMBERS) {
    if (!seen.has(expected)) fail(`missing expected PR #${expected} from --prs`);
  }
}

const args = parseArgs(process.argv.slice(2));
const numbers = args.allChildren ? findChildPrs() : args.prs;
if (numbers.length === 0) fail('no child PRs found');
validateRequestedPrs(numbers);
const issueByPr = new Map(EXPECTED_CHILD_PR_ENTRIES.map(({ issue, number }) => [number, issue]));
const pullRequests = numbers.map((number) => collectPr(issueByPr.get(number), number));
const repository = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
if (typeof repository !== 'string' || repository.length === 0) fail('unable to determine repository name for direct issue evidence');
const directIssues = [collectDirectIssue(3709, repository)];
const evidence = {
  schemaVersion: 1,
  kind: 'ci-evidence',
  issue: 3712,
  createdAt: new Date().toISOString(),
  payload: {
    collector: 'scripts/collect-epic-3698-ci-evidence.mjs (gh pr view statusCheckRollup at headRefOid)',
    expectedChildPullRequests: EPIC_CONTRACT.childPullRequests,
    pullRequests,
    directIssues,
  },
};
writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`collected exact-head CI evidence for PR(s): ${numbers.join(', ')}\n`);
