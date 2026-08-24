# oh-my-claudecode v5.0.0: Workflow Retirement and npm Trusted Publishing

## Release Notes

Major release that trims the public workflow surface to four canonical workflows and **removes 17 legacy names outright** rather than keeping them as compatibility aliases. npm publication now uses **Trusted Publishing** from `.github/workflows/ci.yml` (OIDC, no npm token fallback).

See the [Migration Guide](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/MIGRATION.md#v4x--v50-workflow-retirement) for the full replacement table and migration steps.

Release with **14 new features**, **6 security improvements**, **104 bug fixes**, **224 other changes** across **99 merged PRs**.

### ⚠️ Breaking Changes

- **Retired 14 skills and 7 commands.** `ultrawork`, `ultraqa`, `ultrapilot`, `swarm`, `pipeline`, `merge-readiness`, `deep-dive`, `sciomc`, `ccg`, `omc-teams`, `setup`, `mcp-setup`, `omc-reference`, `learner`, `writer-memory`, `local-build-reminder`, and the `understanding-gate` alias no longer resolve.
- **`review` installs as `omc-review`**, matching how `plan` installs as `omc-plan` — both collide with Claude Code native commands.
- **npm publication is OIDC Trusted Publishing only.** Annotated `v*` tags are published by `ci.yml` with GitHub OIDC. There is no `NPM_TOKEN` fallback.

| Removed | Replacement |
| --- | --- |
| `ultrawork`, `ultrapilot`, `swarm`, `pipeline` | `/execute`, or `/team` for coordinated parallel workers |
| `ultraqa` | `/verify` |
| `merge-readiness`, `understanding-gate` | `/review` |
| `deep-dive`, `sciomc` | `/research` |
| `ccg` | `/ask codex` + `/ask antigravity`, then synthesize |
| `omc-teams` | `/team` or `omc team` |
| `setup`, `mcp-setup` | `/omc-setup` |
| `omc-reference` | `/wiki` |
| `learner`, `writer-memory` | `/remember` |
| `local-build-reminder` | — (docs and CI cover the signal) |

### Highlights
- **feat(skills): ungate remember, verify, and debug**
- **feat(alias-retirement): authorize breaking removal at a major boundary**
- **feat(workflow): author the execute, review, and research skills**
- **feat(verification): epic #3698 closure verifier with reconciled receipts** (#3712)
- **feat(hooks): dispatcher cutover by event family with advisory fail-open (#3708)** (#3708)
- **fix(security): harden script interpreter launch**
- **fix(security): close script and Windows argv gaps**
- **fix(security): preserve Windows argv backslashes**
- **npm Trusted Publishing from `ci.yml`** with OIDC provenance and no token fallback

### New Features

- **feat(skills): ungate remember, verify, and debug**
- **feat(alias-retirement): authorize breaking removal at a major boundary**
- **feat(workflow): author the execute, review, and research skills**
- **feat(verification): epic #3698 closure verifier with reconciled receipts** (#3712)
- **feat(hooks): dispatcher cutover by event family with advisory fail-open (#3708)** (#3708)
- **feat(projection): prompt parity and install migration for #3705** (#3716)
- **feat(alias-retirement): executable verifier and closure inventory (#3711)** (#3711)
- **feat(hooks): declarative hook registry and dispatcher shadow mode (#3707)** (#3707)
- **feat(prompt-ssot): structured prompt SSOT composer and projection digests** (#3704)
- **feat(workflow-ux): canonical Tier-0 docs/help + maintainer-only release + one-warning/session seam** (#3719)
- **feat: add deterministic inventory graph** (#3702)
- **feat(workflow): canonical workflow registry and compatibility policy (#3703)** (#3703)
- **feat(workflow): alias resolver and telemetry (#3706)** (#3706)
- **feat(agents): make unnamed background agents addressable and discoverable** (#3665)

### Security & Hardening

- **fix(security): harden script interpreter launch**
- **fix(security): close script and Windows argv gaps**
- **fix(security): preserve Windows argv backslashes**
- **fix(security): reject introduced live-data directives**
- **fix(security): block control chars in live-data arguments**
- **fix(security): harden live-data command execution**

### Bug Fixes

- **fix(workflows): remove remaining UltraQA lifecycle dependencies** (#3830)
- **fix(ci): require exact generated authorization tuple**
- **fix(inventory): refresh post-3841 provenance (#3712)** (#3712)
- **fix(precompact): fence canonical claim provenance**
- **fix(precompact): require integer marker mtimes**
- **fix(precompact): publish canonical checkpoint paths**
- **fix(precompact): normalize filesystem mtimes**
- **fix(precompact): isolate publisher preload hooks**
- **fix(precompact): fence portable restore publication**
- **fix(skills): validate normalized entitlements**
- **fix(inventory): refresh post-3822 provenance (#3712)** (#3712)
- **fix(skills): unify v5 entitlement visibility** (#3822)
- **fix(inventory): refresh post-3823 provenance (#3712)** (#3712)
- **fix(ralph): invalidate amended story approvals** (#3823)
- **fix(prompt-ssot): validate n-gram size (#3816)** (#3816)
- **fix(prompt-ssot): union repeated n-gram positions (#3816)** (#3816)
- **fix(inventory): refresh post-squash provenance (#3712)** (#3712)
- **fix(verification): preserve terminal non-green CI evidence (#3712)** (#3712)
- **fix(team): make watchdog dead-pane cleanup idempotent** (#3814)
- **fix(team): contain provider startup rollback**
- **fix(team): preserve pre-assignment recovery panes**
- **fix(team): fail closed on unverified containment retry**
- **fix(team): budget idle recovery startup evidence**
- **fix(team): apply startup evidence policy to recovery**
- **fix(team): preserve panes when provider cleanup is unverified**
- **fix(team): bound startup evidence and teardown providers**
- **fix(team): detect denied legacy task reset**
- **fix(team): surface legacy rollback cleanup failures**
- **fix(team): roll back legacy layout failures**
- **fix(team): settle legacy pane geometry before launch**
- **fix(team): settle pane geometry before worker launch**
- **fix(team): fence Cursor prompt readiness**
- **fix: close terminal independent review**
- **fix: close binding review edge cases**
- **fix(team): propagate provider home directory**
- **fix: make restore cursor immutable and session-bound**
- **fix: close final binding review defects**
- **fix: close SessionStart and HTML addenda**
- **fix: honor code-span closers and stale locks**
- **fix: align closure tokenizer offsets**
- **fix: close parser and stale-lock races**
- **fix: bind restores and tokenize closure docs**
- **fix: close HTML and release authority blockers**
- **fix: contain raw HTML and fence scopes**
- **fix: make closure markdown scan fail closed**
- **fix: close exhaustive exact-head review gaps**
- **fix: close current-head runtime review blockers**
- **fix(team): skip cleaned startup panes as split targets**
- **fix: close terminal restore and provenance blockers**
- **fix: complete closure status pagination**
- **fix: harden closure provenance review findings**
- **fix: close five release verification regressions**
- **fix: close final release review blockers**
- **fix: harden release promotion evidence and boundaries**
- **fix: close release promotion security review blockers**
- **fix: regenerate inventory baseline with tracked guard test**
- **fix: close two-clock cancel-signal fixtures and add strict-TTL guard**
- **fix: derive cancel-signal expiry from a single captured timestamp in tests**
- **fix(ci): accept GitHub-signed owner heads**
- **fix: exclude authorization metadata from inventory provenance**
- **fix(test): make generated-artifact authorization suite wall-clock deterministic**
- **fix(frontmatter): only value-leading braces open flow tracking**
- **fix(frontmatter): track multiline flow collection depth**
- **fix(frontmatter): anchor indentation to first root**
- **fix(frontmatter): ignore indented comment lines**
- **fix(skills): preserve indented frontmatter roots**
- **fix(skills): preserve top-level frontmatter metadata**
- **fix(setup): repoint the plugin-root probe from omc-reference to wiki**
- **fix(workflow): restore ralph as a kept workflow**
- **fix(installer): prune the pre-rename directory when a skill is renamed**
- **fix(team): reject invalid persisted worker caps**
- **fix(team): reject a zero max_workers cap in persisted config validation**
- **fix(team): honor explicit max_workers below the hard ceiling (#3744)** (#3744)
- **fix(setup): survive Volta multiline node -e truncation and Windows/POSIX re-exec loop** (#3743)
- **fix(hooks): preserve canonical legacy tracking fallback (#3732 review)**
- **fix(hooks): harden tracking read and override isolation (#3732 review)**
- **fix(hooks): canonical session-state resolver + Stop-hook identity tests (#3732 review)**
- **fix(hooks): resolve task-store identity and session-scoped tracking read (closes #3732)**
- **fix(hooks): restore PreCompact checkpoint after compaction (closes #3730)** (#3731)
- **fix(release): harden promotion assertions**
- **fix(release): gate publication on marketplace promotion**
- **fix(release): complete promotion workflow**
- **fix(release): prevent marketplace promotion gaps**
- **fix(routing): widen ModelType to include fable, validate alias selection (issue #3726)** (#3727)
- **fix: harden inventory graph provenance** (#3702)
- **fix: verify inventory in shallow checkouts** (#3702)
- **fix: verify inventory on CI merge refs** (#3702)
- **fix(ultragoal): honor positional goal id**
- **fix(hooks): stop DELEGATION NOTICE from firing on read-only bash commands** (#3699)
- **fix(purge): track live plugin cache occupancy**
- **fix(purge): keep the pinned plugin path alive when a relink loses a race** (#3687)
- **fix(hooks): honor generic cancellation during lock contention**
- **fix(hooks): supervise Windows generic child cleanup** (#3684)
- **fix(hooks): precise Skill-tool error when subagent_type names a bundled skill** (#3671)
- **fix(hooks): repair five post-merge lifecycle blockers in dirty-worktree evidence (#3663)** (#3663)
- **fix(ralph): disambiguate bare /ralph when official ralph-loop plugin is installed (#3668)** (#3668)
- **fix(python-repl): make every serialized schema and shipped artifact match the sandbox** (#3682)
- **fix(python-repl): align every guidance surface with the sandbox boundary** (#3682)
- **fix(python-repl): stop advertising pandas/numpy/matplotlib support the sandbox forbids** (#3682)
- **fix(hooks): surface dirty-worktree evidence on abnormal agent termination** (#3663)
- **fix(team): never report a worker as plainly idle with undelivered directed work**
- **fix(hud): expose agent kind and spawn ownership metadata** (#3666)
- **fix(ralph): detect and reconcile stale unfinished PRDs** (#3669)
- **fix(ralph): evidence-preserving PRD criterion amendment/supersession** (#3672)

### Documentation

- **docs: replace expired community Discord invite with permanent Gajae community invite**
- **docs(release): draft the v5.0.0 release body**
- **docs: add the 5.0.0 changelog, migration guide, and surface updates**
- **docs(workflow): document the 5.0.0 canonical surface and retirements**
- **docs(routing): scope modelAliases to the SDK path; recommend production-supported surfaces (#3738 review)**
- **docs(routing): document fable tier and session-model delegation contract (issue #3738)**
- **docs(readme): add gajae-code alternative callout to README hero**
- **docs: finalize lightweight workflow contract**
- **docs: apply lightweight workflow owner contract**
- **docs: refresh issue 3698 census evidence**
- **docs: normalize plan whitespace**
- **docs: link issue 3698 child work**
- **docs: plan lightweight workflow epic 3698**
- **docs(scientist): align header comment and README roster label with the sandbox truth** (#3682)

### Other Changes

- **ci: reauthorize PR #3827 head after base advance** (#3848)
- **ci: authorize exact generated closure for PR #3827 (dev)** (#3847)
- **ci: authorize generated artifacts for PR #3830** (#3846)
- **chore(inventory): bind docs invite baseline**
- **chore(inventory): refresh latest dev provenance**
- **chore(inventory): bind final precompact fence**
- **ci(precompact): rerun portable matrix**
- **chore(inventory): refresh entitlement graph**
- **chore(inventory): refresh entitlement graph**
- **chore(ci): authorize issue 3818 artifacts**
- **chore: refresh denied-reset inventory provenance**
- **chore: reconcile denied-reset dev update**
- **chore: refresh inventory provenance**
- **chore: bind terminal review closure head**
- **chore: bind immutable-cursor closure head**
- **ci: remove unused PR 3799 artifact authorization**
- **ci: authorize PR 3799 generated artifacts**
- **chore: bind exhaustive closure head**
- **chore: bind hosted-stable closure head**
- **chore: bind CI-verifiable closure head**
- **ci: fetch inventory ancestry for tests**
- **chore: bind addenda-safe closure head**
- **chore: bind closer-safe closure head**
- **chore: bind Unicode-safe closure head**
- **chore: bind intentional race closure head**
- **chore: bind exact blocker closure head**
- **chore: bind final authority-safe head**
- **chore: bind HTML-safe closure head**
- **chore: bind parser-compliant closure head**
- **chore: bind exhaustive review fix head**
- **chore: bind current review fix head**
- **chore: bind terminal review fix head**
- **chore(ci): reauthorize rebased PR 3772 head**
- **chore(ci): authorize PR 3772 generated artifacts**
- **chore: bind terminal five-P1 closure head**
- **chore: bind reviewed five-P1 closure head**
- **chore: bind final five-P1 closure inventory**
- **chore: bind terminal review inventory provenance**
- **chore: bind closure-clean inventory provenance**
- **chore: keep generated fix within authorized closure**
- **chore: bind security closure inventory provenance**
- **chore: refresh release security inventory provenance**
- **ci: preserve PR #3749 authorization across safe ancestry** (#3768)
- **ci: authorize GitHub-signed PR #3749 head** (#3767)
- **chore: refresh authorization inventory provenance**
- **ci: authorize final PR 3749 inventory head**
- **ci: authorize exact PR 3749 inventory head**
- **chore: refresh inventory provenance**
- **ci: refresh PR 3749 generated-artifact authorization**
- **ci: authorize PR 3749 generated-artifact closure at dev@2e67c229 over main@5aa678c6**
- **chore(inventory): refresh baseline after the main reconciliation merge**
- **chore(inventory): refresh baseline for newly tracked dist modules**
- **chore(build): track generated dist modules missing from git**
- **chore(inventory): refresh baseline after the package-dir anchor fix**
- **chore(build): rebuild artifacts after the setup-script fix**
- **chore(build): rebuild dist and bridge for the 5.0.0 surface**
- **chore(inventory): refresh baseline for the 5.0.0 surface**
- **chore(inventory): refresh baseline after #3740 merge**
- **ci: remove obsolete PR 3740 generated authorization (merged as 923650c89)**
- **ci: final head for authorization binding (no tree change)**
- **ci: terminal head for authorization binding (no tree change)**
- **ci: bind PR #3740 closure to signed head 5ff0f447**
- **ci: PR head marker for authorization binding (no tree change)**
- **ci: bind PR #3740 closure to final head 531b8ddc**
- **ci: authorize exact generated closure for PR #3740 (dev); retire #3739 entry**
- **ci: bind PR #3739 generated closure to exact head 52e23e49**
- **ci: bind PR #3739 generated closure to exact head 767404342**
- **ci: rebind PR #3739 authorization to merged head 2d0080e53**
- **ci: authorize generated closure for PR #3739**
- **chore(inventory): refresh baseline for doc-contract lint hardening**
- **chore(projection): rebuild derived artifacts for docs/CLAUDE.md change (issue #3738)**
- **chore(inventory): refresh deterministic baseline for task-list identity suite**
- **chore(inventory): refresh deterministic baseline for README hero callout digest**
- **ci: remove obsolete PR 3728 generated authorization**
- **ci: bind PR 3728 generated closure to exact head**
- **ci: refresh PR 3728 generated closure authorization**
- **ci: authorize generated closure for PR 3728**
- **ci: authorize PR 3719 generated bridge delta at exact head**
- **chore: refresh inventory after merge** (#3702)
- **ci: authorize PR 3692 at actual merge base**
- **ci: authorize PR 3692 at actual merge base**
- **ci: bind PR 3692 to final live merge base**
- **ci: bind PR 3692 to final live merge base**
- **ci: finalize PR 3692 dev binding**
- **ci: finalize PR 3692 trusted base binding**
- **ci: bind exact PR 3692 current base**
- **ci: bind exact PR 3692 live base**
- **ci: synchronize PR 3692 live pull base**
- **ci: bind PR 3692 to live pull base**
- **ci: bind PR 3692 authorization to latest dev base**
- **ci: bind PR 3692 authorization to current dev base**
- **ci: synchronize PR 3692 authorization base**
- **ci: bind PR 3692 to current dev base**
- **ci: synchronize exact rebased PR 3692 head**
- **ci: authorize rebased PR 3692 head on dev**
- **ci: authorize rebased PR 3692 head**
- **chore: refresh inventory on current dev** (#3702)
- **chore: refresh inventory for shallow CI** (#3702)
- **chore: refresh inventory after CI fix** (#3702)
- **ci: refresh authorization for PR 3716 (3b73/247df)**
- **chore: record inventory provenance** (#3702)
- **ci: refresh authorization for PR 3716 (afa98/e18f0)**
- **ci: refresh authorization for PR 3716 (new PR)**
- **ci: refresh authorization for PR 3716 (651a/95b6)**
- **ci: refresh authorization for PR 3716 (20496/ca8e)**
- **ci: refresh authorization for PR 3716 (d155/7c9c)**
- **ci: refresh authorization for PR 3716 (53fe/0a5b)**
- **ci: repair dev authorization census and expiry fixture**
- **ci: refresh authorization for PR 3716 (09ff/c22b)**
- **ci: refresh authorization for PR 3716 (57b00/0a5b)**
- **ci: refresh authorization for PR 3716 (fb07/07134)**
- **ci: refresh authorization for PR 3716 (c5e5/0d40)**
- **ci: bind PR 3692 to live dev base**
- **ci: authorize generated coordinator for PR 3716 (33204/ba02)**
- **ci: authorize exact PR 3692 release head**
- **ci: repair authorization SHA bindings on dev**
- **ci: refresh authorization for PR 3716 (b1bf/39de)**
- **ci: authorize final PR 3692 head on dev**
- **ci: authorize final PR 3692 head on main**
- **ci: refresh authorization for PR 3716 (52a1/e2459)**
- **ci: authorize final PR 3692 head on dev**
- **ci: authorize final PR 3692 head**
- **ci: refresh authorization for PR 3716 (cf9e/5a16)**
- **ci: refresh PR 3692 authorization binding**
- **ci: refresh authorization for PR 3716 (2cd06/858fe)**
- **ci: refresh authorization for PR 3716 (daf25/4cd3c)**
- **ci: authorize PR 3692 generated closure on main**
- **ci: refresh authorization for PR 3716 (80007/4ff7a)**
- **ci: refresh authorization for PR 3716 (8979/653a)**
- **ci: refresh authorization for PR 3716 (e706/ab29)**
- **ci: refresh authorization for PR 3716 (223433/ab29)**
- **ci: refresh authorization for PR 3716 (223433/ab29)**
- **ci: refresh authorization for PR 3716 (e594/ab29)**
- **ci: authorize current PR 3692 head**
- **ci: authorize synchronized prompt projection head**
- **ci: refresh authorization for PR 3716 (rebase 87bc/e631)**
- **ci: authorize current prompt projection head**
- **ci: authorize current PR 3692 head**
- **ci: authorize current prompt projection head**
- **ci: authorize latest PR 3692 head**
- **ci: authorize generated coordinator for PR 3716 on new base**
- **ci: authorize current PR 3692 head**
- **ci: authorize generated coordinator for PR 3716** (#3705)
- **ci: authorize current PR 3692 head**
- **ci: authorize generated coordinator for PR 3716** (#3705)
- **ci: authorize PR 3692 on current dev**
- **ci: authorize clean PR 3697 head**
- **ci: authorize current PR 3692 head before trusted rerun**
- **ci: authorize PR 3697 on latest dev**
- **ci: authorize final PR 3692 head**
- **ci: authorize PR 3697 on current dev**
- **ci: authorize coordinator closure for PR 3692**
- **ci: authorize current PR 3692 release head**
- **ci: authorize PR 3692 on latest dev**
- **ci: authorize latest rebased PR 3697**
- **ci: authorize latest PR 3692 head**
- **ci: authorize live rebased PR 3697**
- **ci: bind PR 3697 to live dev base**
- **ci: refresh PR 3697 exact authorization**
- **ci: authorize rebased PR 3692 coordinator**
- **ci: authorize rebased PR 3697 coordinator**
- **ci: authorize canonical coordinator for PR 3692**
- **ci: authorize PR 3692 on corrected base**
- **ci: authorize PR 3692 on corrected dev**
- **ci: authorize rebased PR 3697 closure**
- **ci: authorize final PR 3692 generated closure**
- **ci: authorize deduplicated PR 3692 head**
- **ci: authorize PR 3692 on current dev**
- **ci: align PR 3692 authorization with event base**
- **ci: authorize shipped PR 3692 coordinator**
- **ci: authorize synchronized final PR 3692 head**
- **ci: bind PR 3692 authorization to immutable dev base**
- **ci: authorize final coordinator closure for PR 3692**
- **ci: authorize census-fixed PR 3692 head**
- **ci: authorize final current PR 3692 head**
- **ci: authorize synchronized PR 3692 head**
- **ci: correct PR 3692 merge base authorization**
- **ci: authorize final PR 3692 closure**
- **ci: authorize current PR 3692 generated closure**
- **ci: authorize synchronized PR 3692 head**
- **ci: authorize latest PR 3692 rebased head**
- **ci: correct final PR 3697 merge base**
- **ci: authorize final rebased PR 3697 head**
- **ci: authorize rebased PR 3692 closure**
- **ci: authorize rebased PR 3697 head**
- **ci: authorize synchronized PR 3692 head**
- **ci: bind PR 3692 authorization to current dev**
- **ci: authorize inventory-fixed PR 3692 head**
- **ci: authorize census-fixed PR 3697 head**
- **ci: bind PR 3697 to actual merge base**
- **ci: authorize clean PR 3697 closure**
- **ci: authorize latest PR 3697 head**
- **ci: authorize final PR 3692 coordinator closure**
- **ci: authorize test-fixed PR 3697 head**
- **ci: authorize synchronized PR 3692 head**
- **ci: bind PR 3692 authorization to reopened base**
- **ci: authorize PR 3692 verification head**
- **ci: authorize latest PR 3692 head**
- **ci: authorize PR 3697 against current dev**
- **ci: authorize latest PR 3692 coordinator closure**
- **ci: bind PR 3697 to its actual merge base**
- **ci: authorize latest PR 3692 generated closure**
- **ci: bind PR 3697 authorization to stable dev base**
- **ci: authorize generated closure for PR #3692**
- **ci: bind PR 3697 authorization to live dev base**
- **ci: authorize generated closure for PR #3692**
- **ci: authorize latest PR 3697 generated closure**
- **ci: authorize final direct PR 3697 head**
- **ci: bind PR 3697 authorization to current exact head**
- **ci: bind PR 3697 authorization to latest head**
- **ci: bind PR 3697 authorization to refreshed head**
- **ci: rebind PR 3697 authorization to current dev base**
- **ci: authorize direct signed PR 3697 head**
- **ci: authorize signed merge head for PR 3697**
- **ci: authorize signed PR 3697 head**
- **ci: authorize exact PR 3697 head**
- **ci: authorize final PR 3697 generated closure**
- **ci: bind PR 3697 authorization to merge head**
- **ci: rebind generated closure to reconciled PR #3690 head**
- **ci: bind PR 3697 authorization to final rebase**
- **ci: bind PR 3697 authorization to rebased head**
- **ci: bind PR 3697 authorization to exact head**
- **ci: authorize exact generated closure for PR 3697**
- **ci: authorize exact generated closure for PR #3690 (main)** (#3691)

### Stats

- **99 PRs merged** | **14 new features** | **104 bug fixes** | **6 security/hardening improvements** | **224 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.0.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.10...v5.0.0
