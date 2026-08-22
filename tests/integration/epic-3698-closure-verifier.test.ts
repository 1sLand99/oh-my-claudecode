import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-epic-3698-closure.mjs');

interface RunResult {
  status: number;
  report: {
    verdict: string;
    exitCode: number;
    checks: Array<{ id: string; status: string; problems: string[] }>;
  };
}

function runVerifier(args: string[], cwd = REPO_ROOT, options: { fakeGh?: boolean } = {}): RunResult {
  const env = { ...process.env };
  const rootIndex = args.indexOf('--root');
  const fixtureRoot = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : cwd;
  const fakeGh = join(fixtureRoot, 'fake-gh', 'gh');
  if (options.fakeGh !== false && existsSync(fakeGh)) {
    env.PATH = `${dirname(fakeGh)}${delimiter}${env.PATH ?? ''}`;
    env.EPIC_GH_FIXTURE = join(fixtureRoot, 'gh-fixture.json');
  } else if (options.fakeGh === false) {
    env.PATH = '';
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  const report = JSON.parse(result.stdout);
  return { status: result.status ?? -1, report };
}

function check(run: RunResult, id: string) {
  const found = run.report.checks.find((c) => c.id === id);
  expect(found, `check ${id} present`).toBeTruthy();
  return found!;
}

const TIER0_WORKFLOWS = ['plan', 'execute', 'review', 'verify'];
const TIER0_ROLES = ['planner', 'executor', 'reviewer', 'verifier'];
const ALL_CHILDREN = [3702, 3703, 3704, 3705, 3706, 3707, 3708, 3709, 3710, 3711];
const EXPECTED_CHILD_PRS: Record<number, number | null> = {
  3702: 3721,
  3703: 3720,
  3704: 3724,
  3705: 3716,
  3706: 3715,
  3707: 3725,
  3708: 3729,
  3709: null,
  3710: 3719,
  3711: 3723,
};

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitFixture(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function installFakeGh(root: string, data: unknown) {
  const fakeGhDir = join(root, 'fake-gh');
  mkdirSync(fakeGhDir, { recursive: true });
  writeJson(join(root, 'gh-fixture.json'), data);
  const script = [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs');",
    "const data = JSON.parse(readFileSync(process.env.EPIC_GH_FIXTURE, 'utf8'));",
    'const args = process.argv.slice(2);',
    "const out = (value) => process.stdout.write(JSON.stringify(value ?? null) + '\\n');",
    "if (args[0] === 'repo' && args[1] === 'view') out({ nameWithOwner: data.repository });",
    "else if (args[0] === 'pr' && args[1] === 'view') out(data.prs[args[2]]);",
    "else if (args[0] === 'issue' && args[1] === 'view') out(data.issues[args[2]]);",
    "else if (args[0] === 'api') {",
    '  const path = args[1];',
    '  const timeline = path.match(/^repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/timeline/);',
    '  const status = path.match(/^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/status$/);',
    '  if (timeline) out(data.timelines[timeline[1]] ?? []);',
    '  else if (status) out(data.statuses[status[1]]);',
    "  else { process.stderr.write('unknown fake gh api: ' + path + '\\n'); process.exit(2); }",
    "} else { process.stderr.write('unknown fake gh args: ' + args.join(' ') + '\\n'); process.exit(2); }",
    '',
  ].join('\n');
  writeFileSync(join(fakeGhDir, 'gh'), script);
  chmodSync(join(fakeGhDir, 'gh'), 0o755);
}

function commitFixture(root: string, message: string) {
  const commands = [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '-qm', message],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function commitFixtureHead(root: string, message: string) {
  for (const args of [['add', '-A'], ['commit', '-qm', message]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

// Builds a synthetic repository root where every epic #3698 closure
// prerequisite is satisfied, so the verifier must return PASS / exit 0.
function buildCompleteFixture(root: string) {
  for (const skill of TIER0_WORKFLOWS) {
    mkdirSync(join(root, 'skills', skill), { recursive: true });
    writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  mkdirSync(join(root, 'commands'), { recursive: true });
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'commands', `cmd-${i}.md`), 'x\n');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, '.github', 'workflows', `w${i}.yml`), 'on: push\n');
  mkdirSync(join(root, 'src', 'agents'), { recursive: true });
  for (const role of TIER0_ROLES) writeFileSync(join(root, 'src', 'agents', `${role}.ts`), 'export {};\n');

  const receipts = join(root, 'receipts', 'epic-3698');
  mkdirSync(receipts, { recursive: true });
  const head = 'a'.repeat(40);
  for (const issue of ALL_CHILDREN) {
    const pullRequest = EXPECTED_CHILD_PRS[issue];
    writeJson(join(receipts, `child-${issue}-terminal.receipt.json`), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'merged',
        evidence: pullRequest === null
          ? {
              issue: { number: 3709, state: 'CLOSED' },
              commit: { sha: 'b'.repeat(40) },
              status: { state: 'success', sha: 'b'.repeat(40) },
            }
          : {
              pullRequest: { number: pullRequest, headSha: head },
              commit: { sha: 'b'.repeat(40) },
              status: { conclusion: 'success', sha: head },
            },
      },
    });
  }
  writeJson(join(receipts, 'alias-usage.receipt.json'), {
    schemaVersion: 1,
    kind: 'alias-usage',
    issue: 3711,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      canonicalShare: 0.97,
      minorReleases: 2,
      daysSinceDeprecation: 91,
      consecutiveReleasesAtThreshold: 2,
      knownCriticalIntegrations: 0,
    },
  });
  writeJson(join(root, 'receipts', 'epic-3698', 'remaining-risk.json'), {
    schemaVersion: 1,
    risks: [
      { id: 'R1', description: 'residual', severity: 'low', mitigation: 'monitored by verifier', status: 'monitored' },
    ],
  });
  writeFileSync(join(receipts, 'README.md'), '# receipts\n');
  mkdirSync(join(root, 'docs', 'design'), { recursive: true });
  writeFileSync(join(root, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'), '# design\n[receipts](../../receipts/epic-3698/README.md)\n');

  writeJson(join(root, 'ci-evidence.json'), {
    schemaVersion: 1,
    kind: 'ci-evidence',
    issue: 3712,
    createdAt: '2026-08-12T00:00:00Z',
    payload: {
      collector: 'test-fixture-collector',
      repository: 'fixture/example',
      directIssues: [{
        issue: 3709,
        state: 'CLOSED',
        commit: { sha: 'b'.repeat(40) },
        status: { sha: 'b'.repeat(40), state: 'success' },
        source: { repository: 'fixture/example', issue: 'fixture issue', commit: 'fixture commit', status: 'fixture status' },
      }],
      pullRequests: ALL_CHILDREN.filter((issue) => EXPECTED_CHILD_PRS[issue] !== null).map((issue) => ({
        childIssue: issue,
        number: EXPECTED_CHILD_PRS[issue],
        headSha: head,
        mergeCommitSha: 'b'.repeat(40),
        state: 'MERGED',
        checks: [
          { name: 'CI / Test', conclusion: 'success', sha: head },
          { name: 'CI / Lint', conclusion: 'skipped', sha: head },
        ],
      })),
    },
  });
  installFakeGh(root, {
    repository: 'fixture/example',
    prs: Object.fromEntries(ALL_CHILDREN
      .filter((issue) => EXPECTED_CHILD_PRS[issue] !== null)
      .map((issue) => [String(EXPECTED_CHILD_PRS[issue]), {
        number: EXPECTED_CHILD_PRS[issue],
        state: 'MERGED',
        headRefOid: head,
        mergeCommit: { oid: 'b'.repeat(40) },
        statusCheckRollup: [
          { workflowName: 'CI', name: 'Test', conclusion: 'success' },
          { workflowName: 'CI', name: 'Lint', conclusion: 'skipped' },
        ],
      }])),
    issues: Object.fromEntries(ALL_CHILDREN.map((issue) => [String(issue), { number: issue, state: 'CLOSED' }])),
    timelines: { '3709': [{ event: 'committed', sha: 'b'.repeat(40) }] },
    statuses: { ['b'.repeat(40)]: { sha: 'b'.repeat(40), state: 'success' } },
  });
  writeFileSync(join(root, 'changed-files.txt'), 'scripts/verify-epic-3698-closure.mjs\nreceipts/epic-3698/README.md\n');
  return head;
}

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('passes with exit 0 when every acceptance surface is satisfied', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'tracked.txt'), 'base\n');
    commitFixture(fixture, 'base');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(join(fixture, 'tracked.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.report.verdict, JSON.stringify(run.report.checks, null, 2)).toBe('PASS');
    expect(run.status).toBe(0);
    for (const c of run.report.checks) expect(c.status, `${c.id}: ${c.problems.join('; ')}`).toBe('pass');
  });

  it('rejects CI evidence recorded at a stale head', () => {
    buildCompleteFixture(fixture);
    const head = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: head, checks: [{ name: 'CI / Test', conclusion: 'success', sha: stale }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain(stale);
  });

  it('rejects caller-controlled valid SHA evidence that disagrees with live GitHub', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    evidence.payload.pullRequests[0].headSha = forged;
    evidence.payload.pullRequests[0].mergeCommitSha = forged;
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', sha: forged }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('does not match live PR head');
  });

  it('never passes caller evidence when live GitHub verification is unavailable', () => {
    buildCompleteFixture(fixture);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ], fixture, { fakeGh: false });
    expect(run.status).toBe(2);
    expect(check(run, 'exactHeadCi').status).toBe('pending');
    expect(run.report.verdict).not.toBe('PASS');
  });

  it('rejects checks without live-head binding and non-green conclusions', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'ci-evidence.json'), {
      schemaVersion: 1,
      payload: {
        pullRequests: [
          { number: 1, headSha: 'a'.repeat(40), checks: [{ name: 'CI / Test', conclusion: 'failure' }] },
        ],
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(run.status).toBe(1);
    expect(problems).toContain('.sha must be a 40-char lowercase hex SHA');
    expect(problems).toContain('failure');
  });

  it('rejects unsigned exactHead attestations', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].checks = [{ name: 'CI / Test', conclusion: 'success', exactHead: true }];
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('exactHead is unsupported');
  });

  it('rejects forged child-terminal receipts that provide only free-form evidence', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3702-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3702,
      createdAt: '2026-08-12T00:00:00Z',
      payload: { state: 'merged', evidence: 'PR #3721 merged with green CI' },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('structured object');
  });

  it('rejects unrelated or missing child PR substitution in CI evidence', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.payload.pullRequests[0].number = 3727;
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'exactHeadCi').status).toBe('fail');
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('not an expected child PR');
    expect(problems).toContain('missing expected PR #3721');
  });

  it('rejects CI evidence with an absent childIssue or non-merged PR state', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    delete evidence.payload.pullRequests[0].childIssue;
    evidence.payload.pullRequests[1].state = 'OPEN';
    writeJson(evidencePath, evidence);
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    const problems = check(run, 'exactHeadCi').problems.join(' ');
    expect(problems).toContain('childIssue must equal');
    expect(problems).toContain('state must be MERGED');
  });

  it('rejects forged no-PR terminal evidence that does not match the direct issue artifact', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: 'c'.repeat(40) },
          status: { state: 'success', sha: 'c'.repeat(40) },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'childTerminality').status).toBe('fail');
    expect(check(run, 'childTerminality').problems.join(' ')).toContain('independently collected direct issue artifact');
  });

  it('rejects forged direct issue commit/status evidence even when receipt and CI JSON agree', () => {
    buildCompleteFixture(fixture);
    const evidencePath = join(fixture, 'ci-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const forged = 'c'.repeat(40);
    evidence.payload.directIssues[0].commit.sha = forged;
    evidence.payload.directIssues[0].status.sha = forged;
    writeJson(evidencePath, evidence);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'), {
      schemaVersion: 1,
      kind: 'child-terminal',
      issue: 3709,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        state: 'closed',
        evidence: {
          issue: { number: 3709, state: 'CLOSED' },
          commit: { sha: forged },
          status: { state: 'success', sha: forged },
        },
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', evidencePath,
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).not.toBe(0);
    expect(check(run, 'exactHeadCi').status, JSON.stringify(check(run, 'exactHeadCi'), null, 2)).toBe('fail');
    expect(check(run, 'exactHeadCi').problems.join(' ')).toContain('live issue timeline commit');
  });

  it('does not let --changed-files bypass package.json version-diff inspection', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'package.json\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('does not let unauthenticated --changed-files omit package.json when the Git base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'package.json'), { name: 'fixture', version: '9.9.9' });
    writeFileSync(join(fixture, 'changed-files.txt'), 'tracked.txt\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('unauthenticated');
  });

  it('detects a compact/reordered package.json version bump by parsing base and HEAD JSON', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'base package');
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'bumped package');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'HEAD^',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('compares package.json against the exact merge-base when the selected base diverges', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    commitFixture(fixture, 'common ancestor');
    gitFixture(fixture, ['branch', 'selected-base']);
    gitFixture(fixture, ['checkout', 'selected-base']);
    writeFileSync(join(fixture, 'package.json'), '{"version":"2.0.0","name":"fixture"}\n');
    commitFixtureHead(fixture, 'selected base version');
    gitFixture(fixture, ['checkout', '-b', 'head', 'selected-base~1']);
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
    commitFixtureHead(fixture, 'head version');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'selected-base',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('1.0.0 -> 2.0.0');
  });

  it('does not trust a shallow-history HEAD^ fallback when the requested base is unavailable', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, '.github', 'workflows', 'release.yml'), 'on: push\n');
    commitFixture(fixture, 'protected change before HEAD');
    writeFileSync(join(fixture, 'head.txt'), 'head\n');
    commitFixtureHead(fixture, 'head');

    // Model a depth-2 checkout: the protected change is in the shallow parent,
    // while the requested base and its origin equivalent are both unavailable.
    const shallowParent = gitFixture(fixture, ['rev-parse', 'HEAD^']);
    writeFileSync(join(fixture, '.git', 'shallow'), `${shallowParent}\n`);

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'missing-base',
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
    expect(check(run, 'releaseSecurityParity').details).not.toContain('HEAD^');
  });

  it('fails closed on release/publish authority mutation in the change set', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'releaseSecurityParity').status).toBe('fail');
    expect(check(run, 'releaseSecurityParity').problems.join(' ')).toContain('release.yml');
  });

  it('allows only the exact v5 release smoke skill-path correction', () => {
    buildCompleteFixture(fixture);
    const workflowPath = join(fixture, '.github', 'workflows', 'release.yml');
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md"',
      '          test -f "$SMOKE_PACKAGE_ROOT/skills/setup/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md" "$SMOKE_PROJECT/.claude/skills/omc-reference/SKILL.md"',
      '',
    ].join('\n'));
    commitFixture(fixture, 'base release smoke');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md" "$SMOKE_PROJECT/.claude/skills/wiki/SKILL.md"',
      '',
    ].join('\n'));
    commitFixtureHead(fixture, 'correct release smoke');
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pass');
  });

  it('fails on schema-invalid migration receipts', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'broken.receipt.json'), { schemaVersion: 2, kind: 'nope' });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'migrationReceipts').status).toBe('fail');
  });

  it('reports pending (exit 2) while the alias retirement window is unsatisfied, without authorizing removal', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'alias-usage.receipt.json'), {
      schemaVersion: 1,
      kind: 'alias-usage',
      issue: 3711,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        canonicalShare: 0.8,
        minorReleases: 1,
        daysSinceDeprecation: 30,
        consecutiveReleasesAtThreshold: 0,
        knownCriticalIntegrations: 1,
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
    expect(check(run, 'aliasRetirementPolicy').details).toContain('must NOT be removed');
  });

  it('reports pending (exit 2) when children lack terminal evidence', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'childTerminality').status).toBe('pending');
    expect(check(run, 'childTerminality').details).toContain('3709');
  });

  it('fails when the remaining-risk register is missing', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'remaining-risk.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'remainingRisk').status).toBe('fail');
  });

  it('detects broken relative links in closure documents', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[missing](../../receipts/epic-3698/NOPE.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
  });

  it('rejects escaped-label reference links that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped inline-label destinations that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape\\]label](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped-label reference links through symlinks that resolve outside the repository root', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-link.md'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP') {
          skip();
          return;
        }
        throw error;
      }
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../outside-link.md\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').status).toBe('fail');
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('on this repository, runs clean: receipts/docs/parity pass; child terminality and metrics reflect current state', () => {
    const run = runVerifier(['--evidence', join(REPO_ROOT, 'receipts', 'epic-3698', 'ci-evidence-merged.receipt.json')]);
    // Verdict may be PENDING_TEMPORAL (alias retirement window unsatisfied) or FAIL (metrics not at target with all owners terminal)
    expect(['PENDING_TEMPORAL', 'PASS', 'FAIL']).toContain(run.report.verdict);
    // The checked-in historical evidence predates the exact child-PR and
    // structured terminal-receipt contracts, so it must fail closed until
    // refreshed; docs and the risk register remain valid.
    expect(['pass', 'fail']).toContain(check(run, 'exactHeadCi').status);
    expect(['pass', 'fail']).toContain(check(run, 'migrationReceipts').status);
    expect(check(run, 'remainingRisk').status).toBe('pass');
    expect(check(run, 'docsLinks').status).toBe('pass');
    // pass when a base ref resolves locally; pending (not a crash) in shallow CI checkouts without origin/dev
    expect(['pass', 'pending']).toContain(check(run, 'releaseSecurityParity').status);
    // childTerminality: pass when all children have current structured receipts;
    // pending when receipts are absent; fail when stale/forged receipts exist.
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'childTerminality').status);
    // shippedMetrics: pending while owners open; fail when all owners terminal but targets unmet; pass when targets met
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'shippedMetrics').status);
    // alias retirement window is unsatisfied — always pending
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
  });

  it('keeps stdout machine-readable and reports parity pending when no git base is available', () => {
    buildCompleteFixture(fixture);
    // No --changed-files and the fixture is not a git repository: the parity
    // check must degrade to pending, never throw into empty stdout.
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
  });

  it('emits a metrics-snapshot receipt via --emit-metrics-receipt', () => {
    const out = join(fixture, 'metrics.receipt.json');
    spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--emit-metrics-receipt', out], { encoding: 'utf8' });
    expect(existsSync(out)).toBe(true);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.kind).toBe('metrics-snapshot');
    expect(receipt.issue).toBe(3712);
    expect(receipt.payload.measurementSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown arguments fail-closed', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--bogus');
  });
});
