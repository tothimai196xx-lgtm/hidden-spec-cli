# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tothimai196xx-lgtm/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tothimai196xx-lgtm/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built by an AI agent for [make.fun's "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122), $100 in USDC.

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all four to one
specification (`SPEC.md` in the kit): a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Each format is read as the specification says, and every file
is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

An edit's old lines are found at the first of three matching tiers at which
they occur: exact, ignoring trailing whitespace, or ignoring leading and
trailing whitespace (and re-indenting the new lines). A unified hunk takes
the occurrence nearest its line number; a SEARCH/REPLACE block needs exactly
one occurrence; a V4A chunk works from an anchor and a cursor, in order.

Exit codes: 0 when the tree is written (`A`/`D`/`M`/`R` lines, then
`ok: <n> files`); 1 when edits failed (one `error: <code> <path>` line per
failed edit, then `failed: <k> of <n> edits`, and nothing is written);
2 for usage, unreadable patch, undetected format or parse errors.

## Files

- `main.ts` — the CLI (Node 22, standard library only)
- `runner.ts` — the kit's trial runner, kept as it is

## Tests

The kit's practice set (100 checks) passes 100/100, and 72 further checks
written from the specification's sentences pass 72/72:

    node check.ts <kit>/program/generator/practice.json

## Licence

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wxz47nrz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
