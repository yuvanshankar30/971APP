# Contributing to Spartans Hub

Conventions for anyone — human or AI agent — making changes to this repo.
If you're an AI coding agent, this file is not optional reading: follow it
the same way you'd follow direct instructions from the user.

## Before you touch anything: check the PR, not just the branch

**Before starting work on an existing branch, always check whether it
already has an open PR, and read that PR's description *and comments*
first.** A branch's git history alone doesn't tell you the full story —
review feedback, scope changes, and "actually, don't merge this yet"
warnings live in the PR, not in commit messages. Concretely:

```bash
gh pr list --repo frc971/spartanshub --state open
gh pr view <number> --repo frc971/spartanshub --json title,body,comments,reviews
```

Do this **before** reading code, before planning changes, and before
assuming a branch's current state reflects what still needs to happen. A
branch that looks "done" from `git log` alone may have an open review
comment asking for something completely different (this exact thing
happened on PR #78 — see `docs/guides/scoutingvision.md`'s history for what it cost).
This applies to your **own** past work too: if you're picking up a branch
you already touched, re-check the PR for comments added since you last
looked, not just your own memory of the task.

## Remotes

```
spartanshub   https://github.com/frc971/spartanshub.git   — canonical, branch + PR only
stormcoded    https://github.com/stormcoded/971APP.git    — direct-push allowed
origin        https://github.com/wjojarth23/971app.git    — legacy/unrelated fork, do not use
```

- **`spartanshub`** is the real project. Never push directly to its `main`
  — always branch + PR, even for small fixes. Branches are **never
  deleted** after merge (repo convention) — don't be alarmed by a long tail
  of merged-branch names in `git branch -r`; that's expected, not a mess to
  clean up.
- **`stormcoded`** tolerates direct pushes to `main` — a personal/backup
  remote, not the source of truth for the team.
- Fetch/sync from `spartanshub` before starting any new feature branch.
  Someone else's merged PR can change files you're about to touch (schema,
  nav config, shared libs) — starting from a stale `main` is how you
  silently revert someone else's work when your branch merges later (see
  the `docs/guides/scoutingvision.md` postmortem on PR #78 for a real example of
  exactly this happening).

## GitHub workflow

**Every change goes through a branch and a PR. Never push directly to
`spartanshub`'s `main` — no exceptions for "it's small" or "it's just
docs."** `main` has no branch-protection rule configured on GitHub
enforcing this — nothing will technically stop a direct push — which is
exactly why it matters that you enforce it yourself. (`stormcoded` is the
one remote where direct pushes are actually fine; see **Remotes** above.
Don't confuse the two.)

### Creating a branch and opening a PR

```bash
git fetch spartanshub main
git checkout -b your-branch-name spartanshub/main   # always branch from an up-to-date main

# ... make changes, verify (see below), commit ...

git push -u spartanshub your-branch-name
gh pr create --repo frc971/spartanshub \
  --title "Short, plain, descriptive title" \
  --body "$(cat <<'BODY'
## Summary
- What changed and why, as bullet points.

## Test plan
- [x] Things you actually ran and confirmed
- [ ] Things you didn't get to (leave unchecked, don't claim it passed)
BODY
)"
```

If you're picking up an existing branch instead of starting a new one,
`git fetch` + `git checkout <branch>` — and see **Before you touch
anything** above: check its PR and comments first, every time, even if you
opened that PR yourself in an earlier session.

### Branch naming

kebab-case, optionally `username/kebab-case`, optionally with a trailing
unix-timestamp suffix for uniqueness (`feature-name-1787284800`). No single
fixed rule — match whichever of these patterns the branch you're extending
already uses.

### PR titles & bodies

- Title: a short, plain, descriptive sentence — no `feat:`/`fix:`
  Conventional Commits prefixes (not the convention here; check
  `gh pr list --repo frc971/spartanshub --state merged --limit 15` if
  unsure).
- Body: a `## Summary` (bullet points, what changed and why) and a
  `## Test plan` (checklist of what you actually ran — leave unchecked
  items unchecked rather than claiming untested work passed).
- Link the issue it fixes if there is one — `Fixes #80` or `Closes #80`
  anywhere in the body auto-links it and auto-closes it on merge (real
  example: PR #81's body opens with `Fixes #80`).
- **Stacking on another open PR**: if your branch depends on a change
  that's already an open PR but not yet merged to `main`, branch from
  *that* PR's branch instead of `main`, and say so explicitly in your PR
  body (real example: PR #81 branched from `feature/scouting-power-rankings`
  (#78) instead of `main`, and stated why in its own description). Don't
  silently base work on an unmerged branch without noting it — whoever
  reviews your PR needs to know it isn't independently mergeable yet.
- No PR template is configured (no `.github/`) — the Summary/Test plan
  shape above is convention, not something GitHub enforces for you.

### Labels

A small label set exists on the repo (`bug`, `documentation`,
`enhancement`, `security`, `gcp`, `ci`, plus GitHub's defaults like
`good first issue`/`help wanted`/`question`/`wontfix`/`duplicate`/`invalid`).
Used somewhat consistently on **issues**, rarely applied to PRs in
practice — don't feel obligated to label a PR, but do label an issue you
file if one of these genuinely fits.

### Merging

- No CI is configured on this repo (no `.github/workflows/`) and `main`
  has no required status checks or required-review branch-protection rule.
  That means **you** are the check: run the verification steps in the next
  section yourself before opening *or* updating a PR, every time — nothing
  else will catch a regression for you.
- Real merges on this repo use GitHub's plain "Merge pull request" (a merge
  commit, `git log --merges` shows `Merge pull request #N from ...`) — not
  squash, not rebase. Match that: `gh pr merge <number> --repo
  frc971/spartanshub --merge`.
- Merging into `main` is a shared-repo action, same as a direct push would
  be — treat it with the same care. Don't merge your own PR (or anyone
  else's) without the user's explicit go-ahead for that specific merge,
  even if you were the one who opened it. "You can open a PR for this" is
  not the same authorization as "you can merge it" — they're separate
  asks unless stated together.
- Branches are **never deleted** after merge on `spartanshub` (see
  **Remotes** above) — don't delete a branch after merging its PR, and
  don't be alarmed by the long tail of old merged-branch names already in
  `git branch -r`.
- Never co-author Claude (or any AI tool) in commit messages/trailers on
  this project.
- Prefer creating a new commit over amending, and a new PR comment over
  editing history, once a PR is open for review.

## Local setup & verification

```bash
npm install
cp .env.example .env   # fill in real Supabase project values
npm run dev             # http://localhost:5173 (or next free port)
```

Node `>=22` required (`package.json` `engines`).

**Before considering any change done**, run:

```bash
npx vitest run                        # full test suite must pass, 0 failures
npx svelte-check --output human       # must show 0 errors (warnings: see below)
```

`svelte-check` currently reports a baseline of pre-existing warnings (a11y,
unused CSS selectors) in files unrelated to most changes — don't feel
obligated to fix warnings in files you didn't touch, but never *add* a new
one in a file you did. If a change touches a Python file under `vision/`,
there's no formal test suite yet; at minimum run `python3 -m py_compile` on
it, and if the change touches real logic (not just wiring), write and run
an ad hoc verification script against synthetic input before calling it
done — don't ship untested Python logic on the assumption that "it looks
right."

For UI changes: actually run the dev server and look at the feature in a
browser before calling it done. If the app requires login credentials you
don't have (this app is Supabase-auth-gated), say so explicitly rather than
claiming a visual change was verified when it wasn't — a static HTML
harness built from the real `app.css` (see any recent PR touching
`src/app.css`-styled pages for an example) is an honest fallback for
checking layout/CSS in isolation, but say that's what you did.

## Database migrations

- Location: `migrations/*.sql`, named `YYYYMMDD_description.sql`.
- **This repo has no automatic migration runner.** A file existing in
  `migrations/` does not mean it has been applied to the real Supabase
  project. Before assuming a table/column/policy exists, check the actual
  database — via Supabase MCP tools if available
  (`mcp__supabase__execute_sql` against `information_schema.tables`, or
  `mcp__supabase__list_migrations`), or ask. Getting this wrong is exactly
  how "PostgREST can't find a relationship" production errors happen (real
  incident, `docs/plans/scoutingvision-remaining-work.md`).
- Write migrations idempotently: `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` before
  `CREATE POLICY`. Assume a migration might be re-run.
- **If a migration file has never been applied anywhere yet, it's safe to
  edit in place.** Once it's been applied to a real database (dev or
  prod), don't rewrite it — write a new migration instead, the same way
  you'd never rewrite history on a merged PR.
- RLS pattern already established in this repo: enable RLS per table, then
  a `DO $$ ... FOREACH table_name IN ARRAY [...] LOOP ... END LOOP; END $$;`
  block to apply the same policy shape across several tables at once
  (search `migrations/` for real examples) rather than repeating five
  nearly-identical `CREATE POLICY` statements by hand.
- Applying a migration to the real (shared, production) Supabase project is
  a consequential action — it's usually additive/reversible, but it's still
  a live team database. Say clearly what you're about to run and why before
  doing it, the same as any other action affecting shared infrastructure.

## Secrets & deployment (Google Cloud Run)

- `cloudbuild.yaml` substitutions (`_PUBLIC_*`) are safe to commit — they
  become public client-bundle values regardless. Real secrets go through
  `--set-secrets` (GCP Secret Manager), never a substitution.
- **Never wire a `--set-secrets` reference to a secret before it actually
  exists in Secret Manager with IAM access granted to the Cloud Run runtime
  service account** — doing so breaks the *next* deploy outright. The
  correct order, every time:
  1. `openssl rand -hex 32 | gcloud secrets create SECRET_NAME --project=spartanshub --data-file=-` (or a real value piped in, never pasted into chat/committed).
  2. `gcloud secrets add-iam-policy-binding SECRET_NAME --project=spartanshub --member="serviceAccount:<runtime-sa>" --role="roles/secretmanager.secretAccessor"`.
  3. *Then* add `SECRET_NAME=SECRET_NAME:latest` to `cloudbuild.yaml`'s
     `--set-secrets` line.
  If you can't complete step 1–2 yourself (no verified GCP project access),
  add a `!!! REMINDER !!!` comment block documenting the exact commands
  needed instead of wiring the reference — see `cloudbuild.yaml`'s existing
  `CRON_NOTIFICATION_TOKEN` and `VISION_RUNNER_TOKEN` blocks for the
  established format.
- Before assuming a `gcloud`/GCP action is safe to run, check
  `gcloud config get-value project` — a locally authenticated `gcloud`
  session may be pointed at a completely unrelated project. Don't run
  infrastructure commands against production blind.
- The deploy trigger watches `spartanshub`'s `main` branch. Check
  `.dockerignore` before assuming a build failure is a deploy-pipeline bug
  rather than a missing/excluded file.

## Code style

- No comments explaining *what* code does (identifiers should already say
  that) — only comments explaining a non-obvious *why* (a hidden
  constraint, a workaround for a specific bug, something that would
  genuinely surprise a reader). If deleting a comment wouldn't confuse
  anyone, delete it.
- No speculative abstractions, feature flags, or "just in case" error
  handling for states that can't occur. Solve the actual problem in front
  of you.
- Don't add backwards-compatibility shims, renamed-but-kept dead exports,
  or `// removed` comments for deleted code. If it's unused, delete it
  outright.
- Plain JS, not TypeScript (`jsconfig.json` provides editor type-checking
  only). Svelte 5.
- No emojis in code, commit messages, or docs unless explicitly asked for.

## Design system — read `docs/design/avoiding-ai-slop.md` before any UI work

This repo has a real, specific design spec, not just vibes. Before writing
or changing any UI:

- Use the app's actual token system (`src/app.css`: `--space-*`, `--gap-*`,
  `--secondary`, `--accent`, etc.) and its established global classes
  (`.page-header`, `.header-content`, `.grid`/`.grid-2`/`.grid-3`,
  `.empty-state`, `.error-container`, `.surface-card`) instead of inventing
  bespoke per-page CSS for something a shared pattern already covers.
  `.header-content` specifically is a flex **row** (title + description
  side by side) — don't add a third unrelated element into it (e.g. a
  back-link) without checking how that interacts with the existing pattern
  first; see any recent commit touching `src/routes/scouting/vision/`
  for a real example of this going wrong and the fix.
- Respect the light/dark theme system — never hardcode a color that isn't
  already a CSS custom property, and check both themes for anything new.
- No purple-to-blue gradients, no `rounded-2xl shadow-lg`-as-reflex,
  no `Sparkles`/decorative icons, no generic "Elevate your workflow"-style
  copy. Full anti-pattern list and the "would someone believe AI made
  this?" test are in the spec file itself — read it, don't paraphrase from
  memory.
- Ground every UI decision in what this app actually is (an FRC
  manufacturing/scouting/purchasing tool for a specific team), not generic
  SaaS-dashboard conventions.

## Documentation conventions

- `README.md` is a **living document** — if a change adds a new top-level
  route, a new major `src/lib` module, a new external integration, or
  changes how the app is deployed, that change is not done until
  `README.md` reflects it. This is stated in the README itself; it's not
  optional.
- Deep-dive architecture for one feature area goes in `implementations/`
  (general) or `autocam/docs/` (AutoCAM specifically) — link to it from
  `README.md` rather than duplicating detail there.
- For a large, actively-evolving feature, a standalone file-by-file
  implementation reference in `docs/guides/` (e.g. `docs/guides/scoutingvision.md`)
  — "where is the code and what does it actually do," kept in sync commit by
  commit — is a good pattern to follow for anything of comparable size.
  Pair it with a living "what's still not done" doc in `docs/plans/`
  (`docs/plans/scoutingvision-remaining-work.md`) if the feature ships incrementally
  across multiple PRs; update both, don't let either go stale.
- Don't write speculative "future work" as if it were done. If something
  is a placeholder, a stub, or unverified, say so explicitly in the doc
  rather than letting the prose imply it's finished.
