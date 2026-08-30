## OMC v5.1.0

v5.1.0 is the minor release from the published v5.0.2 baseline through the exact release candidate. It adds opt-in governed-delivery workflows, strengthens configured model preservation during team scale-up, and closes delegation-notice shell parsing false positives.

### Highlights

- Adds the opt-in `minimal-code-discipline` built-in skill. (#3899)
- Adds the opt-in `drydock` repository harness and `launch` governed delivery pipeline. (#3907)
- Adds the source-exact Shipyard methodology map. (#3908)
- Adds document-language selection and bilingual seed support to `drydock`. (#3909)
- Preserves Cursor and configured provider model defaults across direct launches and team scale-up. (#3900, #3904, #3905)
- Eliminates delegation-notice false positives for scratchpad writes, log redirects, shell control flow, directory-copy destinations, coprocess source mutations, and named coprocess commands. (#3911; exact-dev follow-ups `da23d1a21`, `a02c57610`, `5bacbf808`)

### Verification

Release validation covers exact-head version consistency, metadata/projection/inventory verification, focused changed-feature tests, lint, typecheck, the full test suite, build, plugin shipping verification, package pack/install/CLI version smoke, upgrade validation, and protected GitHub checks. The release process must not treat any failing or unavailable validation as passing evidence.

The final release head is bound to the current exact protected repository owner through the base-owned generated-artifact authorization workflow.

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks. Update whichever track you use; update both when both are installed.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.1.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.0.2...v5.1.0

## Contributors

Thank you to the contributors whose merged work is included in this release candidate:

@iyoda @kavix @pangpang778 @Yeachan-Heo
