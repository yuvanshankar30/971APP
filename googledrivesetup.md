# Google Drive Setup (AutoCAM watcher)

Full checklist, start to finish, for wiring up the `cad` → auto-CAM → `cammed`
Drive integration. Steps 1–4 you can do entirely in the Cloud Console (no
`gcloud` needed, `gcloud` equivalents included). Steps 5–7 need real values
(folder IDs, the generated key) that only exist once you've done the earlier
steps - come back to those once you have them.

## Architecture (what this actually does)

Full details in `autocam/docs/drive-watcher-folder-layout.md` - short version:

- **Two `cad` subfolders, one per router** — `cad/oldrouter` (ShopSabre) and
  `cad/newrouter` (the other router). Dropping a CAD file into either one
  auto-queues (and for routing jobs, auto-generates) a job against that
  router's own machine profile (its own default material/tool/params).
- **Both routers share ONE `cammed` folder.** Finished G-code doesn't go
  directly into it - every delivery lands in a dated subfolder inside it
  (`2026-08-20`, Pacific time), created on first use each day and reused for
  the rest of that day, regardless of which router produced it.
- **Filenames are prefixed with the machine name**
  (`<machine-slug>_<part-slug>_<HHMMSS>.<ext>`) specifically because both
  routers land in the same dated folder - otherwise there'd be no way to tell
  which physical router a file came from, or avoid two routers colliding on a
  same-named part.
- **`cammed` fills up from every completed job on a Drive-configured machine,
  not just ones that started from a `cad` folder.** A job created manually
  through `/autocam`'s "New Job", from `/manufacture`'s "Convert to G-code",
  or as part of a batch run - any of those still lands in `cammed` once it
  completes. Delivery is a property of the machine profile, not of how the
  job began.
- Output delivery starts working the moment steps 1–6 below are done, no
  scheduler required. The input trigger (`cad` → auto-queue) additionally
  needs step 7.

## 1. Create the service account

- Go to [console.cloud.google.com](https://console.cloud.google.com) and make sure
  you're in the `geminiapi-469220` project (project selector top-left).
- Left sidebar → **IAM & Admin** → **Service Accounts**.
- **+ Create Service Account** at the top.
- Give it a name (e.g. `drive-watcher`) — the ID auto-fills.
- Click **Create and Continue**.
- On the "Grant access" step, click **Continue** without adding any
  project-level roles — this service account only needs access to the two
  Drive folders you'll share with it directly, not anything project-wide.
- Click **Done**.

## 2. Enable the Drive API (once per project)

- Left sidebar → **APIs & Services** → **Library**.
- Search "Google Drive API" → click it → **Enable**.

## 3. Generate the JSON key

- Back in **IAM & Admin → Service Accounts**, click the service account you
  just made.
- Go to the **Keys** tab.
- **Add Key** → **Create new key** → choose **JSON** → **Create**.
- A `.json` file downloads automatically. **Its entire contents are the value
  of `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY`** — don't edit it, don't extract
  individual fields, the whole JSON blob is the secret value.
- **Handle it carefully**: it's a real, standing credential — anyone who has it
  can act as this service account against whatever it's shared with. Don't
  commit it to git, don't paste its contents into chat.

## 4. Share the folders with it

Three folders total: both `cad` subfolders (one per router) and the one
shared `cammed` folder.

- Still on the service account's page, copy its email address at the top —
  looks like `drive-watcher@geminiapi-469220.iam.gserviceaccount.com`.
- In Google Drive, right-click `cad/oldrouter` → **Share** → paste that email
  → set its role to **Viewer** → Send.
- Right-click `cad/newrouter` → **Share** → same email → **Viewer** → Send.
- Right-click `cammed` → **Share** → same email → set its role to **Editor**
  (it needs to create the dated subfolders and upload files) → Send.
- **Note all three folders' IDs** while you're there — you'll need them for
  step 6. Two ways to get a folder's ID:
  - **From the address bar**: double-click to open the folder in Drive. The URL
    looks like `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz`
    — everything after the last `/` is the folder ID (`1AbCdEfGhIjKlMnOpQrStUvWxYz`
    in that example). Copy just that part, not the whole URL.
  - **From the share dialog**: right-click the folder → **Share** → **Copy link**.
    The copied link has the same `.../folders/<ID>` shape — paste it somewhere
    and pull out the same trailing segment.
  - Do this for `cad/oldrouter`, `cad/newrouter`, and `cammed` — three IDs
    total, but `cammed`'s ID gets reused for BOTH machine profiles in step 6.

## 5. Create the Secret Manager secret from the downloaded key

Console path (no `gcloud`):
- **Secret Manager** → **Create Secret** → name it `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY`
  → upload the downloaded `.json` file as the secret value → **Create Secret**.
- On that secret's page → **Permissions** → grant the Cloud Run runtime service
  account (`536793099017-compute@developer.gserviceaccount.com` - confirm with
  `gcloud projects describe spartanshub --format="value(projectNumber)"` rather
  than trusting a pasted number) the **Secret
  Manager Secret Accessor** role.

`gcloud` equivalent:
```bash
gcloud secrets create GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY --data-file=/path/to/downloaded-key.json
gcloud secrets add-iam-policy-binding GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY \
  --member="serviceAccount:536793099017-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 6. Wire the secret and folder IDs in

Two separate places:
- **`cloudbuild.yaml`**: add `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY=GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY:latest`
  to the deploy step's `--set-secrets` line (same pattern already used for
  `CRON_NOTIFICATION_TOKEN`). Not done yet as of this doc — say the word once
  the secret from step 5 actually exists, and this line gets added; adding it
  before the secret exists would make the next deploy fail.
- **`/autocam` → Manage Profiles**: edit each router's machine profile
  separately -
  - **ShopSabre profile**: `cad/oldrouter`'s ID into "Drive Auto-Trigger
    Folder ID", `cammed`'s ID into "Drive Delivery Folder ID".
  - **Other router's profile**: `cad/newrouter`'s ID into "Drive Auto-Trigger
    Folder ID", the SAME `cammed` ID into "Drive Delivery Folder ID".
  - Both profiles end up pointing at the same output folder ID on purpose -
    that's what makes both routers' output land in one shared `cammed`
    folder, grouped by date.

## 7. Schedule the input sweep

Nothing calls `/api/drive-watcher` on a timer yet — dropping a file in `cad`
won't trigger anything until one of these exists:

- **Cloud Scheduler** (simpler now that you're on GCP): a scheduled job that
  hits `POST https://spartanshub.spartanrobotics.org/api/drive-watcher` on an
  interval, with `Authorization: Bearer <CRON_NOTIFICATION_TOKEN value>` (the
  same token from the cron-auth fix — this endpoint is gated by the same
  check).
- **Supabase `pg_cron`**: a Vault secret + wrapper function calling this
  endpoint, mirroring the existing `invoke_planner_notification_cron()`
  job that already runs every 15 minutes.

Either way, output delivery (step 4–6) doesn't need this — it fires
automatically whenever a job on a Drive-configured machine completes.
