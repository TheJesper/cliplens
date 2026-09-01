# Contributing to ClipLens

Thanks for helping out. ClipLens is a **public** repo — the single most important
rule is that no private or company-specific data ever lands in it.

## Golden rule: keep it generic

ClipLens core must stay vendor-neutral. Anything specific to a company, customer,
or internal system belongs in a **gitignored** location, never in a tracked file.

### Never commit

- Real clip payloads or board dumps (`*.clip`, `clips/`, `mural-catalog/`)
- Company Jira keys (e.g. `ABCD-1234`), internal URLs, or internal hostnames
- Mural workspace ids, board numbers, owner ids (`u…` hashes)
- Real email addresses or personal data
- Private agent notes about what you're working on
- API keys, tokens, credentials of any kind

### Where private things go instead

| Content | Put it here (gitignored) |
|---------|--------------------------|
| Company-specific lenses | `private-lenses/` |
| Company-specific pens | `private-pens/` |
| Private agent notes | `*.local.md`, `.notes/`, `.agent-notes/` |
| Scratch / experiments | `scratch/`, `temp/`, `tmp/` |
| Local tooling / config | `.devkit/` |
| Captured clips | `clips/`, `*.clip` |
| Company templates | `templates/*-mt.json`, `templates/*.local.json` |

The tracked `agents.md` is the **sanitized** project knowledge base (generic paths,
no company data). Private working notes go in `*.local.md` instead.

## Automated push gate

Two git hooks scan every commit and push for company/internal markers and block
them before they leave your machine:

- `pre-commit` — runs `node tools/check-no-secrets.mjs`
- `pre-push` — same scan again as a final gate

Install the hooks (also runs automatically on `npm install` via `prepare`):

```bash
npm run install-hooks
```

Run the scan manually any time:

```bash
npm run check-secrets
```

If the scan flags something:

1. Remove the data, or
2. Move the file to a gitignored path (see table above).

Overriding the gate (`git commit --no-verify` / `git push --no-verify`) is
strongly discouraged — the whole point is to catch leaks before they're public.

## Adding patterns to the gate

The scanner lives in `tools/check-no-secrets.mjs`. Add new markers to the
`PATTERNS` array. Keep patterns specific enough to avoid false positives on
generic docs (use uppercase `WORKSPACE`/`{placeholder}` style in examples so the
scanner lets them through).

## Code style

- ES modules, Node >= 18
- Run `npm run lint` before committing (syntax-checks the core modules)
- Match the existing style in the file you're editing
