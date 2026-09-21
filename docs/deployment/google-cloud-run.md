# Deploying to Google Cloud Run

This app moved from Vercel to Cloud Run. This doc covers the actual GCP setup and the
day-to-day workflow, split so a GitHub-only maintainer never needs GCP access for
normal updates.

**Target**: project `spartanshub` (project number `536793099017`), region `us-west1`,
Cloud Run service and Artifact Registry repo both named `spartanshub`, domain
`spartanshub.spartanrobotics.org`.

**Note on project history**: this app originally deployed into `geminiapi-469220` by
accident (that project's real purpose is unrelated — it holds a "Generative Language
API Key" and other infrastructure this app never used). It was moved to the correct
`spartanshub` project on 2026-08-25. `geminiapi-469220` has been fully cleaned of every
app-related resource (Cloud Run service, Artifact Registry repos, secrets, Cloud Build
trigger) and is no longer relevant to this app at all.

## 971hub Gemini runtime secret

The Slack assistant's general-question handler reads `GEMINI_API_KEY` from the
Cloud Run process environment. `cloudbuild.yaml` maps that variable to the
`GEMINI_API_KEY` Secret Manager secret at **runtime**; the key must not be
committed, added to a public environment variable, or baked into the image.
`/status` does not need the key, which is why it can work while general
questions fail.

Before merging or deploying the runtime mapping, verify **metadata only** in
the live `spartanshub` project (do not print or paste the secret value):

```bash
gcloud secrets describe GEMINI_API_KEY --project=spartanshub
gcloud secrets versions list GEMINI_API_KEY --project=spartanshub --filter='state=ENABLED'
gcloud secrets get-iam-policy GEMINI_API_KEY --project=spartanshub
```

There must be an enabled version and a
`roles/secretmanager.secretAccessor` binding for the Cloud Run runtime
service account (currently
`536793099017-compute@developer.gserviceaccount.com`). A key held only in
`geminiapi-469220` does not satisfy this deployment. If either prerequisite
is absent, have an administrator configure it privately in the live project
before merging; do not access or copy its value through a PR or chat. After
deployment, mention `@971hub` with a general Hub question in
`#971app-bot-testing` and check that the reply stays in its thread. Keep
`/status` as a separate smoke test.

## Current status

Done and verified live:
- Artifact Registry repo `spartanshub` in `us-west1`.
- `cloudbuild.yaml` builds, pushes, and deploys successfully end-to-end. It needs no
  project-specific values — everything resolves via Cloud Build's built-in `$PROJECT_ID`
  substitution, which is exactly what made the project move require zero code changes.
- Cloud Build GitHub trigger `spartanshub-main-deploy` (global region), connected to
  `frc971/spartanshub`, watching `^main$` — confirmed firing and succeeding on real
  pushes to `main`.
- **`https://spartanshub.spartanrobotics.org/` is live** with real `PUBLIC_*` config
  (real Supabase project, real Onshape base URL). Domain mapping was moved from the old
  project to this one on 2026-08-25 — real but brief downtime during cutover (roughly
  15-20 minutes): Google's control-plane API reported the mapping fully `Ready` several
  minutes before the certificate actually finished propagating to all edge nodes, so
  status-checking alone wasn't a reliable signal that it was safe to consider done.
  Worth remembering for any future domain-mapping move.
- **Runner credentials stay runtime-only.** `FUSION_RUNNER_TOKEN` has its
  own Secret Manager secret on spartanshub with an enabled version, and
  the runtime service account (`536793099017-compute@developer
  .gserviceaccount.com` - this project's real default compute SA,
  confirmed with `gcloud projects describe spartanshub`) holds
  `roles/secretmanager.secretAccessor` on it directly - verified against
  Secret Manager itself, not assumed, while chasing issue #309. The
  earlier "map FUSION_RUNNER_TOKEN to the VISION_RUNNER_TOKEN secret"
  workaround is gone from `cloudbuild.yaml`.
  **`VISION_RUNNER_TOKEN` now also exists** as its own separate secret with
  its own enabled version and the same `roles/secretmanager.secretAccessor`
  binding on the same runtime service account - re-verified directly
  against Secret Manager on 2026-09-08 (`gcloud secrets list`,
  `gcloud secrets versions list`, `gcloud secrets get-iam-policy`), not
  assumed. An earlier revision of this doc said it did not exist and asked
  an administrator to create one; that is no longer true, and acting on it
  would create a duplicate. Both runners are fully split at every layer:
  separate secrets, separate `--set-secrets` mappings, and separate env
  vars in code (`fusion_runner_auth.js` reads only `FUSION_RUNNER_TOKEN`,
  `api/vision-runner/+server.js` reads only `VISION_RUNNER_TOKEN`).
  Neither token belongs in a checked-in `.env.example` file.
- 8 Secret Manager secrets created and wired to the Cloud Run runtime service account
  (`536793099017-compute@developer.gserviceaccount.com` - see the note above on
  where this number comes from) via
  `roles/secretmanager.secretAccessor`, scoped per-secret: `SUPABASE_SERVICE_KEY`,
  `SUPABASE_ANON_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN`,
  `TBA_API_KEY`, `ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY`. The Onshape pair is
  deliberately pulled into the *build* step via Cloud Build's `availableSecrets`/
  `secretEnv` (not a plain `cloudbuild.yaml` substitution) so the raw values never sit
  in git history — see the comment block in `cloudbuild.yaml`.
- **This is a newer GCP project than the old one, and it does not carry the legacy
  broad "Editor" role the old project's default service account had** — four IAM grants
  had to be added explicitly that the old project never needed, discovered by actually
  running a real build/deploy and reading each failure:
  - `roles/logging.logWriter` (build step failed writing logs — required whenever a
    build uses `availableSecrets`/non-default logging, which this one does)
  - `roles/artifactregistry.writer` (image push failed:
    `artifactregistry.repositories.uploadArtifacts` denied)
  - `roles/run.admin` + `roles/iam.serviceAccountUser` (needed for the deploy step's
    own `gcloud run deploy` call)
  - `allUsers` granted `roles/run.invoker` directly on the Cloud Run service (the old
    project's service used `run.googleapis.com/invoker-iam-disabled: true`, a
    different mechanism Cloud Run falls back to under certain org policies; a normal
    `allUsers` invoker binding worked fine here)
  All four are one-time, project-level setup — not something a future redeploy needs to
  repeat.

**Still open — unrelated to the project move, carried over unchanged:**

- **`CRON_SECRET`/`CRON_TOKEN`/`CRON_NOTIFICATION_TOKEN` — a live security gap, not
  just a missing feature.** `src/lib/server/cron_auth.js`'s `isAuthorizedCronRequest()`
  is **fail-open**: `if (!expectedSecrets.length) return true` — with none of these set,
  the check accepts *any* request as authorized. None exist in Secret Manager yet
  (deliberately left out of `cloudbuild.yaml`'s `--set-secrets`, with a comment block
  explaining why), so `/api/planner/notifications` (hit by the one genuinely active
  `pg_cron` job, every 15 minutes) and `/api/drive-watcher` both currently accept
  unauthenticated requests. Tracked as
  [issue #5](https://github.com/frc971/spartanshub/issues/5) — still open.

  **The value must match what's already stored in the Supabase Vault secret
  `planner_notifications_cron_token`** — that's what the live `pg_cron` job actually
  sends. A freshly generated value would authenticate this endpoint while breaking the
  real cron job's own requests. Retrieve the real value via the Supabase SQL editor:

  ```sql
  select decrypted_secret from vault.decrypted_secrets
  where name = 'planner_notifications_cron_token';
  ```

  Then create the secret and wire it in:

  ```bash
  gcloud secrets create CRON_NOTIFICATION_TOKEN --project=spartanshub --data-file=-
  gcloud secrets add-iam-policy-binding CRON_NOTIFICATION_TOKEN --project=spartanshub \
    --member="serviceAccount:536793099017-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
  ```

  Then add `CRON_NOTIFICATION_TOKEN=CRON_NOTIFICATION_TOKEN:latest` back into
  `cloudbuild.yaml`'s `--set-secrets` line (see its comment block for the exact spot).
- **`GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` — genuinely low priority, not stale, just never
  activated.** `src/lib/server/drive_watcher.js:284-286`: the sweep degrades gracefully
  without this key (`{ ok: true, skipped: true, reason: 'not_configured' }`), not a
  crash. `migrations/20260817_cam_studio_system.sql:319,364-374`: the migration adds
  the schema but explicitly documents — as a comment, never executed — the `pg_cron`
  schedule that *would* activate it. No such schedule exists. Nothing calls
  `/api/drive-watcher` automatically today. Safe to defer indefinitely.
- `PUBLIC_SENTRY_DSN`, `PUBLIC_AUTOCAM_API_URL`, `PUBLIC_ROUTES`, `PUBLIC_TBA_API_KEY`,
  and the Drive/Slack-channel runtime env vars (`DRIVE_API`, `DRIVE_UPLOAD_API`,
  `DRIVE_SCOPE`, `DRIVE_PRACTICE_CATEGORY`, `SLACK_ALERT_CHANNEL_ID`) — still empty
  placeholders in `cloudbuild.yaml`.
- **Known pre-existing issue, not introduced by this migration**:
  `PUBLIC_ONSHAPE_SECRET_KEY` ships in the public client bundle today —
  `src/lib/onshape.js` is imported by three client-side `.svelte` pages. Worth a
  follow-up to proxy Onshape calls server-side and rotate both Onshape keys.
- Recommended: turn on GitHub branch protection requiring this Cloud Build check to
  pass before merge.

## Why the Dockerfile needs so many `--build-arg`s

SvelteKit inlines every `PUBLIC_*` var referenced via `$env/static/public` into the
client-side JS bundle **at build time** — this isn't a Vercel-specific mechanism, it's
just something Vercel's own build step used to handle transparently by reading its
dashboard env vars. Cloud Build has to pass the same values explicitly, or the build
fails immediately with `"X" is not exported by "virtual:env/static/public"` (fail
loudly, not a silent bad deploy). The full set, discovered by grepping `src/` for every
`PUBLIC_*` reference:

```
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
PUBLIC_SENTRY_DSN
PUBLIC_ONSHAPE_ACCESS_KEY
PUBLIC_ONSHAPE_SECRET_KEY
PUBLIC_ONSHAPE_BASE_URL
PUBLIC_AUTOCAM_API_URL
PUBLIC_APP_ORIGIN
PUBLIC_SITE_URL
PUBLIC_ROUTES
PUBLIC_TBA_API_KEY
PUBLIC_AUTO_VENDOR
```

**Implication worth knowing**: because these are baked into the built bundle, a
different value per environment (e.g. a staging Supabase project) needs a separate
image build, not just a different Cloud Run deploy-time env var. There's only one
environment today (prod), so this doesn't bite yet — flag it if a staging environment
gets added later.

Non-`PUBLIC_*` (private) vars are normal runtime env vars / secrets and don't have
this constraint — see **Secrets** below.

## One-time GCP setup (admin only)

Run these yourself once `gcloud` is authenticated (`gcloud auth login`,
`gcloud config set project spartanshub`). This section is a from-scratch walkthrough
(useful for disaster recovery or standing up a second environment) — the actual
`spartanshub` project has already had all of this done; see **Current status** above.

### 1. Enable required APIs

```bash
gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

### 2. Create the Artifact Registry repo

```bash
gcloud artifacts repositories create spartanshub \
  --repository-format=docker \
  --location=us-west1 \
  --description="SpartansHub app images"
```

### 3. Create secrets (values piped in locally — never pasted into chat)

```bash
gcloud secrets create SUPABASE_SERVICE_KEY --data-file=-   # paste value, then Ctrl-D
gcloud secrets create SLACK_BOT_TOKEN --data-file=-
gcloud secrets create SLACK_SIGNING_SECRET --data-file=-
gcloud secrets create GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY --data-file=/path/to/key.json
gcloud secrets create TBA_API_KEY --data-file=-
gcloud secrets create CRON_NOTIFICATION_TOKEN --data-file=-
```

Grant the Cloud Run runtime service account access to just these secrets (Compute
Engine default SA unless you create a dedicated one, which is the better long-term
choice — for `spartanshub` this is `536793099017-compute@developer.gserviceaccount.com`
(confirm with `gcloud projects describe spartanshub --format="value(projectNumber)"`
rather than trusting a pasted value - an earlier version of this doc, and issue #309,
both named a different, wrong project number here), project-number-specific, so it'll
differ in any other project):

```bash
for SECRET in SUPABASE_SERVICE_KEY SLACK_BOT_TOKEN SLACK_SIGNING_SECRET \
              GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY TBA_API_KEY CRON_NOTIFICATION_TOKEN; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:RUNTIME_SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

**A newer GCP project won't have the legacy broad "Editor" role a project's default
service account used to get automatically.** Also grant, once, at the project level —
found by actually running a real build/deploy against `spartanshub` and reading each
failure, not assumed in advance:

```bash
for ROLE in roles/logging.logWriter roles/artifactregistry.writer \
            roles/run.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding spartanshub \
    --member="serviceAccount:RUNTIME_SA" --role="$ROLE"
done
```

Since `SUPABASE_SERVICE_KEY` currently lives in Vercel's dashboard, rotate it in
Supabase once it's confirmed working from Secret Manager — the old value stays valid
until you do, so this is a deliberate cutover step, not automatic.

### 4. First manual deploy (proves the container actually runs before automating it)

```bash
gcloud builds submit \
  --substitutions=_PUBLIC_SUPABASE_URL="...",_PUBLIC_SUPABASE_ANON_KEY="...",... \
  --config=cloudbuild.yaml
```

A fresh Cloud Run service also requires an explicit public-access grant — it defaults
to requiring authentication:

```bash
gcloud run services add-iam-policy-binding spartanshub \
  --region=us-west1 --member="allUsers" --role="roles/run.invoker"
```

Then confirm the service responds:

```bash
gcloud run services describe spartanshub --region=us-west1 --format="value(status.url)"
curl -I <that URL>
```

Wire in the private env vars / secrets on the service:

```bash
gcloud run services update spartanshub \
  --region=us-west1 \
  --set-secrets=SUPABASE_SERVICE_KEY=SUPABASE_SERVICE_KEY:latest,SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,... \
  --set-env-vars=PUBLIC_SUPABASE_URL=...,PUBLIC_SITE_URL=https://spartanshub.spartanrobotics.org,...
```

### 5. Custom domain

DNS for `spartanrobotics.org` is already controlled and wired up (confirmed with
project owner). Map the domain:

```bash
gcloud run domain-mappings create \
  --service=spartanshub \
  --domain=spartanshub.spartanrobotics.org \
  --region=us-west1
```

This prints the DNS records (a CNAME or A/AAAA set) to add. **Real experience moving
this exact domain between projects**: Google's own `domain-mappings describe` status
can report `Ready: True` / `CertificateProvisioned: True` several minutes *before* that
actually propagates to every edge node — don't treat the API status alone as proof the
domain is reachable. Verify with real `curl`/browser checks, from more than one
location if possible, before declaring a cutover done.

### 6. Connect Cloud Build to GitHub (this is what makes merges auto-deploy)

Via Cloud Console: **Cloud Build → Triggers → Connect Repository**, authorize the
Cloud Build GitHub App for this repo, then create a trigger. **Use the Console, not
`gcloud`** — `gcloud builds triggers create github` (and `update github`) both failed
with an opaque `INVALID_ARGUMENT` in this exact setup even after the GitHub connection
existed and the repo was selectable in the Console's own picker; the Console flow
itself worked without issue both times (initial creation and later editing the branch
pattern). If you do want to try the CLI first:

```bash
gcloud builds triggers create github \
  --repo-name=spartanshub \
  --repo-owner=<github-org-or-user> \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

Non-secret `PUBLIC_*` substitutions don't need to be passed at trigger-creation time —
`cloudbuild.yaml` already carries real defaults for them in its `substitutions:` block
(safe to commit, since they end up in the public client bundle either way regardless of
where they're stored).

**Recommended**: turn on GitHub branch protection on `main` requiring the Cloud Build
check to pass before merge is allowed, so a broken build never reaches `main`.

## Ongoing workflow (the GitHub-only maintainer)

1. Open a PR, get it reviewed.
2. Merge to `main`.
3. Cloud Build trigger fires automatically → builds → pushes to Artifact Registry →
   deploys the new revision to Cloud Run.
4. Check build/deploy status and logs at **Cloud Console → Cloud Build → History**
   (no `gcloud` needed) — click the failed build to see exactly which step and line
   failed, same as a failed CI check on any other platform.

That's the entire deploy action. No `gcloud`, no Cloud Run console access, no IAM
needed for this workflow.

## Local development / testing the container

```bash
npm run build   # requires all PUBLIC_* vars above set in your shell or .env
npm run start    # or: node build/index.js

# or, to test the actual container:
docker build \
  --build-arg PUBLIC_SUPABASE_URL=... \
  --build-arg PUBLIC_SUPABASE_ANON_KEY=... \
  # ...(all 12 PUBLIC_* args)
  -t spartanshub .
docker run -p 8080:8080 -e PUBLIC_SUPABASE_URL=... -e PUBLIC_SUPABASE_ANON_KEY=... spartanshub
```

`maxDuration: 60` in `src/routes/api/cam-generate/+server.js` is a Vercel-specific
route config left in place intentionally — it's a harmless no-op on Cloud Run, whose
default request timeout is much longer.

## What's intentionally out of scope here

- **The `autocam/` FastAPI service** is not part of this migration. It's currently
  disabled (`DISABLE_AUTOCAM = true` in `src/lib/config/autocam.js`) and superseded —
  turning/routing G-code generation now happens synchronously in this app itself
  (`src/lib/cam/turning.js`, `routing.js`, `stepProfile.js`). Its Dockerfile also has
  an unresolved dependency on a `PenguinCAM/` directory that doesn't exist anywhere in
  this repo. Revisit as a separate task if it's ever re-enabled.
- **Replacing Supabase** — see `docs/deployment/supabase-alternative-design.md` for
  that as a fully separate, not-yet-executed design.
