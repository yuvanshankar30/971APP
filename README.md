# Spartans Hub

Team management hub for FRC team 971 (Spartan Robotics) - manufacturing/CAM,
scouting, planning, and purchasing in one app.

## Features

Full scope of what the app actually does, grouped by domain - see **Module
map** below for where each of these lives in code. Like the rest of this
file, **keep this current when a feature is added, removed, or changes
scope** - it's the one place meant to answer "does this app do X?" without
reading code.

All destructive and state-changing confirmations use a shared in-app dialog,
including typed confirmation for irreversible bulk actions, rather than native
browser confirmation or prompt popups.

- **Manufacturing/CAM**: part tracking through the manufacturing pipeline
  (queued → in-progress → completed), STEP file 3D viewing, BOM and build
  tracking, kitting, bins, post-processing, router-specific workflows,
  optional notes on a request (visible/editable both at creation and inline
  on each request in its manufacturing workflow tab), plus an optional router
  CAM-folder path that is saved as part of the request note for the machining
  team. Slack-DMs the relevant lead(s) when a new request is created for a
  workflow they're assigned to (admin-configurable per
  user, per workflow - see **Admin & permissions** below), and again for
  Router leads specifically as a router part moves through its pipeline
  (CAM review, CAM reviewed, postprocessed, jprogged, machined, kitted -
  Router's the only workflow with this many distinct steps). See the
  **AutoCAM** section below for automatic G-code generation specifically.
  The Manufacturing folder also includes **Text Engraving**, a direct
  single-line-text-to-`.ngc` utility with a live toolpath preview and
  configurable engraving dimensions, depth, clearance, and feed rates.
- **AutoCAM**: automatic STEP → G-code generation for lathe turning, router
  routering, and indexed tube-stock drilling jobs run on the router with the
  operator flipping the tube between faces by hand - either manually queued
  from `/autocam` or auto-triggered by dropping a CAD file
  into a machine's watched Google Drive folder (turning/routering only; tube
  stock is standalone-upload only, no manufacturing-request workflow maps to
  it yet). Tube-stock jobs retain a combined program for simulation and also
  produce one self-contained G-code file per unique drilled tube face. Files
  are labeled by face (Top, Right side, Bottom, Left side) where applicable;
  manufacturing exposes them in an in-app picker for individual installation
  and machine-folder delivery. No external CAM software
  involved (pure JS geometry math). Real
  3-axis milling (contoured toolpaths a flat 2.5D profile can't represent)
  is a separate sub-section, **Fusion CAM** (`/autocam/fusion`), backed by
  an actual Fusion 360 Runner rather than in-process math; it is intentionally
  absent from the New AutoCAM Job operation picker. See the
  **AutoCAM** section below for the code-level detail on all three.
  Completed routering, turning, and tube-stock jobs all get a 3D toolpath
  simulator (routering/turning also get a switchable 2D preview; tube stock
  has no useful 2D representation of a per-face drilling program, so it goes
  straight to 3D) with rapid/cutting/plunge paths distinguished, distance
  scrubbing, and tool-change stepping. All three render real material removal
  as playback scrubs, not a static stock model: routering displaces a heightmap plate
  under a moving flat end mill; turning projects diameter-mode X/Z into
  axial/radial coordinates and revolves the actual machined profile into a
  solid, animating the rotating stock and a turning insert along the
  programmed path; tube stock renders a static box (see its own file-header
  comment for why it isn't animated as a literal rotation) with real drilled
  holes cut into whichever wall each move is on, and a drill oriented into
  that wall. Routering and turning additionally overlay the job's source
  STEP geometry semi-transparently and flag a gouge - a cut that removed
  material the source part actually needed, checked against that
  independent STEP-derived ground truth rather than the G-code comparing
  itself to itself.
  Completed router jobs with the same machine, end mill, and material can also
  be grouped into one shared-sheet router program. Grouping is AutoCAM-only:
  it preserves each source job, carries the manufacturing project ID into the
  AutoCAM filter/group record, packs material-removing envelopes with
  cutter- and tolerance-aware part clearance plus cutter-radius-aware sheet
  edge clearance, and exposes the combined program in
  the same 3D-first toolpath viewer. Manufacturing only shows a green grouped
  status/link beside AutoCAM completed. See
  `autocam/docs/router-job-grouping.md` for the deliberate conservative
  placement and program-composition rules.
- **Scouting**: pit scouting (a topic-at-a-time form with per-topic
  completion counts, scout/contact attribution, and up to three robot photos,
  built for filling in a noisy pit on a phone while a team answers out of
  order), alliance-tinted match scouting with event-team type-ahead and
  structured auto collision/fuel-source plus intake-speed/jam observations,
  and an explicit named autonomous-path file library with “Save as new file”
  and “Load file” actions independent of report submission, a 29-by-29-inch
  robot footprint, centerline-conflict marking, and hub collision
  prevention (trenches render but don't block - a robot drives under one).
  When `SCOUTING_AUTO_PATHS_DRIVE_FOLDER_ID` is configured, each newly saved
  autonomous path also uploads as a rendered field-map image to that shared
  Google Drive folder using the existing service account; see
  `implementations/scouting-auto-path-drive-export.md` for setup.
  free-form notes,
  cross-team data discovery and analysis (`discover/`), a consolidated
  team-view, and scouting-admin tooling with drag-and-drop team-to-scout
  assignment drafting and explicit publishing, plus form/config editing -
  integrates with The Blue Alliance API for competition data.
  The signed-in home dashboard balances direct links to Manufacturing,
  Purchasing, and Scouting, while keeping each scout's personal assignment
  queue available without filling the page with duplicate scouting tools.
  The **Strategy** view (`/strategy`) leads the Competition folder as the
  decision board, and replaced the Data Scouting page outright - that page is
  gone, though `/datascout` remains as the endpoint that reads and writes
  `scout_data_events`. Strategy combines the
  event's data observations, match reports, pit profiles, free-form notes,
  named autonomous routes, and open ACE issues into comparable team rows and
  focused team briefs without duplicating data entry.
- **Vision Scouting**: a real Competition-folder nav tab, open to every
  approved user like the rest of Competition (no special permission needed),
  running post-match, multi-camera ML processing at `/scouting/vision` for
  robot trajectories/mobility, fuel, and climbing, with a calibrated
  red/blue field-occupancy heatmap that fills as trajectory results arrive.
  A full BF16 Qwen3-VL-30B-A3B service on NVIDIA DGX Spark proposes semantic
  events from bounded multi-camera clips; a
  separate versioned YOLO/ByteTrack runner supplies dense tracking and
  mobility. Both feed a human-reviewed evidence queue rather than silently
  treating model predictions as ground truth; compatible alliance totals are
  reconciled with TBA and material differences enter an evidence-backed
  human-review queue. A separate, higher `VISION_RELEASE` permission gates
  an explicit "release" bridge that pushes a completed run's results into
  real `scout_data_events` (so they count toward power rankings) - nothing
  vision-derived reaches real scouting data without that explicit action.
  An event-level dashboard (`/scouting/vision/dashboard`) rolls up
  match/run/discrepancy counts and runner-fleet health (online/offline via
  heartbeat) across a whole event. Run failures and new critical
  discrepancies Slack-DM an admin-managed opt-in list
  (`user_profiles.vision_notify`, toggled from the admin panel). See
  `implementations/vision-scouting-system.md` for the design/contracts,
  `scoutingvision.md` for the full file-by-file implementation reference, and
  `scoutingvision-remaining-work.md` for what still has to happen before it is
  usable (it is not deployed or running against real footage yet).
- **Planning**: Gantt-based build/task scheduling (`wx-svelte-gantt`),
  Slack-driven prompts and reminders on a 15-minute cron sweep.
- **Purchasing/Budget**: COTS (commercial off-the-shelf) part stock
  tracking, purchasing tied to CAD parts (`cad/purchasing`), budget
  tracking/allocation by project or build (admin Budgets tab).
- **Tasks**: general task tracking separate from the planner's
  scheduling-focused tasks, including a dedicated P0 (priority-zero issue)
  report view.
- **Admin & permissions**: user/role/permission management (including a
  per-workflow "Notifications" role controlling who gets Slack-DMed for
  new manufacturing requests, plus a "Vision Alerts" opt-in checkbox for
  Vision Scouting run failures/critical discrepancies), a manual grant for
  the `VISION_RELEASE` permission (the one gated Vision Scouting action -
  pushing results into real scouting data), an activity log, attendance
  location/schedule configuration.
- **Attendance**: attendance logging against configured locations/schedules,
  surfaced on user profiles.
- **Account** (`profile/`): a consistently named Account tab on desktop and
  mobile for per-user profile settings and personal stats (attendance history,
  etc.), plus a Slack-style theme gallery available to every signed-in account
  covering both the built-in themes and extra palette groups. Gallery themes
  also remap semantic success/error/progress/warning and operation badges onto
  palette-coordinated dark surfaces without changing their meanings. The page
  is divided into direct-linkable Account, Appearance, Navigation, and
  Notifications panels instead of one continuous settings scroll.
- **Default navigation**: Home is always first, followed by Manufacturing,
  Competition, CAD, and Purchasing. Members can still customize this order in
  their Account navigation settings.
- **Pick List** (`scouting/`): a team-comparison / pick-list workspace for the
  active event. Named for what it produces: it was previously labelled "Data
  Scouting" in the nav, which collided with the separate `datascout` route and
  described the inputs rather than the output. Distinct from the existing
  pit/data/note scouting *collection* tools below, which this reads from
  rather than replaces:
  - Sortable comparison table fusing The Blue Alliance's real team roster
    (authoritative - nothing else here ever narrows or redefines it), TBA's
    own OPR/rankings (`api/tba/event-oprs` - replaced the dead Statbotics EPA
    proxy, see issue #80; TBA has no auto/teleop/endgame breakdown the way
    Statbotics EPA did, so this is a single OPR column), and a "scouted?"
    flag from `datascout`'s existing `?list_teams=1&event_key=` endpoint.
  - Search/filter by team number or name; CSV export of the visible table.
  - Click any team row to expand a detail panel: derived summary stats
    (avg driving/accuracy/speed rank, most common climb position) computed
    from that team's real `scout_data_events` rows by `src/lib/scoutingStats.js`
    (unit-tested), plus their free-text `scout_notes`.
  - A shared, persisted **pick list** (`scouting_picklist` table,
    `api/scouting-picklist`) - star a team to add it, drag-free up/down
    reordering, per-team notes. Any approved user can add/reorder/annotate
    any entry (deliberately more open than `scout_notes`' creator-only
    edit rule - a pick list is one document the whole strategy group edits
    together, and per-row ownership would break group reordering).
- **Match + Pit Scouting** (`matchscout/`, `pitscout/`): durable Supabase-backed
  match reports and shared per-team pit profiles. Pit profiles include robot
  archetype, mechanisms, climb capability, technical ratings, photos, failure
  risks, and additional human-review notes. Match and pit scouts share a repair
  queue backed by `pit_problem_reports`; open problems can be resolved or
  reopened from Pit Scouting instead of disappearing into browser-local state.
  Match Scouting keeps robot status available throughout the workflow and
  requires a described pit handoff whenever a robot is marked disabled or dead;
  general notes and the auto-path drawing remain optional. The path tool uses
  a simplified, alliance-relative version of WPILib/AdvantageScope's top-down
  2026 REBUILT field, so the scout's wall is always on the left and red/blue
  paths share one useful coordinate system. Releasing and pressing again
  continues the saved route; only Clear removes it. Auto scoring accepts an
  exact estimate, a bounded range such as `40-60` (stored average `50`), or an open
  lower bound such as `100+` (conservatively stored as at least `100`). Teleop
  also offers an optional ball-count estimate in 25-ball buckets through an
  open-ended `500+` bucket, storing the selected label and parsed bounds for
  later analytics. It adds optional observed-role tags and five quick ratings while keeping every
  subjective input skippable; teleop and post-match prose areas are deliberately
  large enough for real scout observations. Timed robot actions, per-fuel
  taps and the objective endgame result are recorded through Quick Scout
  (`quickscout/`), which writes the same `scout_data_events` the removed
  Data Scouting page did.
- **Power Rankings** (`powerrankings/`): the last item in the Competition nav
  folder - its own page rather than a mode of the Pick List workspace, so it
  never gets confused with that page's comparison table. An event-relative
  ranking built only from combined local scout observations.

  It shows **four deliberately distinct measures**, and the page says so in
  as many words, because conflating them would misrepresent an official FRC
  standing:
  - **971 Scout Power** - our own ranking from our own scouts. The primary
    column, and *not* an FRC ranking; it exists to inform our picks.
  - **Human Consensus** - a separate preference rank produced by authenticated
    scouts choosing between two robots. Each scout gets one current vote per
    event/team pair; changing the choice updates it. These votes never alter
    Scout Power. A two-thirds-or-stronger majority that opposes a calculated
    Scout Power gap of at least five points flags both robots for human review.
  - **Official Event Rank** - the real qualification standing from The Blue
    Alliance, which FIRST computes from Ranking Points earned in qualification
    matches. The only official rank on the page.
  - **TBA OPR** - Offensive Power Rating, a least-squares estimate of a team's
    contribution to alliance score. A statistical estimate, not a rank.

  The latter two come from the existing `api/tba/event-oprs` proxy (note its
  response field is named `epa` for backwards compatibility with the
  Statbotics route it replaced; the value is OPR). They are reference columns
  only - they never feed the Scout Power calculation - and are styled
  recessively so the page reads as our ranking with official data alongside,
  not a scoreboard of equals. A TBA outage degrades to a note rather than
  hiding the scouting ranking.
  Observed match performance contributes 70%, an explicit human-selected
  impact attached to saved `scout_notes` contributes 15%, and structured pit
  capability/reliability contributes 15%; unresolved pit problems reduce the
  pit score while archetype and freeform prose remain human context. Neutral
  and legacy notes remain review-only. Within match performance, weights are
  average fuel
  per match (40%), driving (20%), accuracy (15%), climb level (15%), and speed
  (10%); missing dimensions are omitted and the remaining weights are
  rebalanced instead of being treated as zero. Also
  includes a **head-to-head comparison** view for any two event teams,
  covering scout power, human consensus, matches scouted, fuel, driving,
  accuracy, speed, and climb success. Its overlaid robot star plot normalizes
  fuel, driving, accuracy, speed, climb, and pit capability against the
  currently loaded event field; missing observations stay visibly absent at
  the center rather than becoming invented zero-valued evidence. Pairwise
  preferences persist in `scouting_pairwise_votes` through
  `api/scouting-comparisons`.
- **Docs** (`docs/`): browses every `*.md` file in the repo (a "finder" -
  folder tree + search on the left, rendered markdown on the right).
  Content is bundled at build time via Vite's `import.meta.glob` (raw
  string import), not read from disk per-request - the production Docker
  image never gets the raw source tree, only compiled `build/` output, so
  a request-time `fs.readdir` would find nothing there. Excludes
  `node_modules` and the vendored `autocam/fusion/**/_upstream` trees.
- **Integrations**: Onshape (CAD source of truth for parts), Slack (bot
  notifications/DMs, `971bot`), The Blue Alliance (competition data),
  Google Drive (AutoCAM input/output watcher), Sentry (error monitoring),
  Supabase (database, auth, storage - the backbone every feature above sits
  on).

## Architecture

Whole-project overview: tech stack, module map, data layer, deployment, and
contribution workflow. This is a **living reference** - **update it whenever
a new feature or subsystem is added**, not just when someone happens to read
it. If a change adds a new top-level route, a new major `src/lib` module, a
new external integration, or changes how the app is deployed, that change
isn't done until this file reflects it.

For a specific feature's own deep-dive architecture, see `autocam/docs/`
(AutoCAM specifically - e.g. `autocam/docs/drive-watcher-folder-layout.md` for the Google
Drive/manufacturing-folder integration) or `implementations/` (everything
else) - this file stays at the whole-project level and links out rather
than duplicating that detail.

## Stack

- **Framework**: SvelteKit (Svelte 5), plain JS (no TypeScript) with
  `jsconfig.json` for editor type-checking.
- **Hosting**: dual right now - Google Cloud Run (`adapter-node`, primary
  going forward) and Vercel (`adapter-auto`, being phased out). See
  `docs/deployment/google-cloud-run.md` and `googledrivesetup.md` (Drive
  watcher setup) for the Cloud Run side. `cloudbuild.yaml`/`Dockerfile` are
  Cloud-Run-specific config - they may or may not be physically present on
  every remote's `main` depending on sync history, but they're only
  functionally active via `spartanshub`'s own Cloud Build trigger (see
  **Contribution workflow** below), regardless of which mirrors happen to
  carry the files.
- **Database/Auth/Storage**: Supabase (Postgres + RLS, Supabase Auth,
  Supabase Storage). `docs/guides/AUTH_PROTOCOL.md` covers the auth flow in
  detail (UUID-only local persistence, client-side only - no SSR session,
  `@supabase/ssr` is a declared but unused dependency).
- **3D/CAD**: `occt-import-js` (STEP file parsing, WASM) + `three.js`
  (client-side 3D viewing, `CadViewer.svelte`).
- **Other integrations**: Slack (`@slack/web-api`, bot notifications/DMs),
  Onshape API (CAD source of truth for parts - see the Onshape-key exposure
  note under **Known gaps** below), The Blue Alliance API (scouting), Sentry
  (error monitoring), Google Drive API (AutoCAM input/output watcher, hand-
  rolled, no `googleapis` dependency - see `autocam/docs/drive-watcher-folder-layout.md`),
  and Hugging Face Qwen3-VL (private DGX Spark inference for Vision Scouting).

## AutoCAM (`autocam/`, top-level - not under `src/lib/`)

STEP → G-code generation for turning/routering/tube stock: pure JS geometry
math, no external CAM software, no DXF. Deliberately lives outside
`src/lib/` in its own top-level folder, imported via the `$autocam` alias
(`svelte.config.js`) - the whole engine, the Google Drive watcher, shared
job-queue helpers, AutoCAM-specific components, its CLI test script, and its
own docs are all together in one place instead of scattered across
`src/lib/cam/`, `src/lib/server/`, `src/lib/components/`, and
`implementations/`.

- **`autocam/stepProfile.js`** - extracts 2D profiles (turning/routering) or
  tube-wall hole geometry (`extractTubeFeaturesFromMeshes`) directly from a
  STEP file's triangulated mesh (via `occt-import-js`).
- **`autocam/turning.js`** / **`autocam/routing.js`** / **`autocam/tubestock.js`**
  - generate the actual G-code from that profile/geometry. Tube stock runs
  on the router (round holes only), with the operator flipping the tube
  between faces by hand - there is no rotary 4th axis, and a separate
  program is emitted per face - see `autocam/docs/tubestock-feature.md` for the full design
  and real-fixture validation, including the one real bug it caught
  (`lateralOffset`) that a synthetic test alone never would have.
  Turning accepts only rotationally symmetric finished geometry; gears,
  polygonal exteriors, tubes, and formed parts are rejected rather than
  approximated as a round turning envelope.
  Router jobs use material-specific feed, plunge, and spindle presets, with
  conservative dry-routing defaults when stock has not been selected.
- **`autocam/toolpathPreview.js`** - parses generated G-code back into a
  toolpath for the 2D preview and 3D simulator, including a cumulative-distance
  interpolation helper for playback (`autocam/components/ToolpathViewer.svelte`,
  `autocam/components/ToolpathSimulator.svelte`).
- **`autocam/gcodeLint.js`** - checks a program against the conditions that
  stop LinuxCNC loading it (nested/unclosed comments, characters that are
  illegal outside a comment, words with no value) and repairs malformed
  comments. `autocam/routingLinuxcnc.test.js` runs real generated router and
  tube-stock output through it, so a generator change that emits something
  LinuxCNC would reject fails the suite. Backs the **G-code Converter**
  tab (`/manufacture/gcode-converter`), where a pasted program is checked
  and exported as `.ngc`. The rules are calibrated against the cncjs
  `gcode-parser` and `pygcode` interpreters, which agree with it
  line-for-line on real generated programs; LinuxCNC's own `rs274` cannot
  be built on macOS, so it is not part of the local loop.
  Generated programs are held to what **LinuxCNC 2.7** supports, checked
  against the 2.7.15, 2.8.4 and 2.9.0 interpreter sources: `LINELEN` is 255
  in all three, the comment rules in `close_and_downcase` are unchanged
  across them, and every G/M code we emit is present in 2.7.
  `routingLinuxcnc.test.js` pins that set, so adding a newer code (`G64`,
  `G43`, `G95`/`G96`) has to be a deliberate edit rather than something that
  silently raises the minimum version a shop needs. Tube stock's `O1002`
  program number is the one version-sensitive line: 2.7 ignores a bare
  O-word, 2.8+ reads it as a Fanuc-style program number and keeps
  executing, and only an INI setting `DISABLE_FANUC_STYLE_SUB` rejects it.
- **`autocam/nesting.js`** / **`autocam/groupedGcode.js`** - deterministic,
  conservative router-job placement from real G-code bounds and one-program
  composition for grouped sheets; see `autocam/docs/router-job-grouping.md`.
- **`autocam/drive_watcher.js`** - Google Drive input-sweep (`cad` →
  auto-queue) and output-delivery (finished G-code → dated `cammed`
  subfolder) - see `autocam/docs/drive-watcher-folder-layout.md` for the real folder
  layout this was built for.
- **`autocam/camJobs.js`** - shared job-queue helpers used by both
  `/autocam` and `/manufacture`.
- **Machine-scoped tooling** - `cam_machine_tools` records which cutters are
  installed on each physical profile. Choosing a machine filters the job's
  Tool / End Mill selector and copies a selected router bit's diameter into
  the generated-job parameters and 3D simulation. The seeded UNC Router
  default is a `0.1575 in` flat end mill; operators can add another tool for
  the selected machine directly from the job form.
- **`autocam/components/`** - `ToolpathViewer.svelte`, `CamParamFields.svelte`,
  `RoutingToolSequence.svelte`, `TurningFinishTool.svelte`,
  `AutocamReviewModal.svelte` (the last one currently unused anywhere - a
  known dead-code candidate, not yet removed).
- **`autocam/scripts/test-cam-extraction.mjs`** - standalone CLI to run a
  real STEP file through the pipeline without the web app - the main tool
  used to stress-test this system against real CAD files.
- **`autocam/__fixtures__/`** - real STEP files, committed as regression
  fixtures - each one was chosen because it caught a real bug (see the
  `*.test.js` files next to the engine modules for what each one covers),
  not arbitrarily.
- **`autocam/docs/`** - AutoCAM-specific planning/architecture docs
  (`drive-watcher-folder-layout.md`, `drive-watcher-implementation.md`, etc.).
- **`autocam/runner/README.md`** - the milling Runner concept (turning/routering
  are synchronous in-process math; milling needs an actual external Fusion
  360 Runner) - now built as **Fusion CAM**, see the next bullet.
- **`autocam/fusion/`** (reachable from `/autocam/fusion`) - **Fusion CAM**:
  a native SvelteKit/Supabase port of Team Valor 6800's open-source AutoCAM
  (`AutoCAM-FRC/Website` + `AutoCAM-FRC/Runner`, MIT licensed), fills the
  milling gap the rest of AutoCAM deliberately doesn't solve (real 3-axis
  contoured toolpaths via Fusion 360's own CAM engine, not flat 2.5D
  profiles). Backed by new `fusion_parts`/`fusion_plates`/`fusion_box_tubes`/
  `fusion_part_categories` tables plus the reused `cam_jobs`/`cam_machines`/
  `cam_tools`/`cam_materials` tables and a claim/complete/fail endpoint at
  `src/routes/api/fusion-runner/+server.js`. `autocam/fusion/runner/` is the
  forked Fusion 360 add-in that actually runs CAM; unmodified copies of both
  original repos are vendored at `autocam/fusion/_upstream/` and
  `autocam/fusion/runner/_upstream/` for reference. No Teams/API-key-per-team
  layer was ported - single shared-secret bearer token for the Runner,
  Supabase Auth + `canManageCamProfiles` for humans, same as the rest of this
  app. See `autocam/fusion/README.md` and `valor6800-autocam-runner-setup.md`
  (repo root) for the full port writeup and the evaluation that led to it.
- **Route files stay in `src/routes/`** regardless (`src/routes/autocam/+page.svelte`,
  `src/routes/api/cam-generate/+server.js`, `src/routes/api/drive-watcher/+server.js`)
  - SvelteKit determines a route's URL from its file location under
    `src/routes/`, so these can't move into `autocam/` themselves; they just
    import the engine from `$autocam/...` instead of holding logic directly.
- **Legacy, NOT part of the above, NOT moved**: `src/lib/autocam.js` and
  `src/routes/manufacture/autocam/+page.svelte` are remnants of an older,
  disabled DXF/PenguinCAM-based system (`DISABLE_AUTOCAM` in
  `src/lib/config/autocam.js`), unreferenced from anywhere in the app's
  navigation. Left in place as a known dead-code finding, not yet removed.

## Module map (`src/routes`, by domain)

- **`manufacture/`, `cad/`, `autocam/`** - the CAD-to-manufacturing pipeline:
  part tracking, STEP viewing, and AutoCAM (see the **AutoCAM** section
  above for where its actual code lives).
- **`planner/`** - scheduling/task system with a Gantt view
  (`wx-svelte-gantt`), Slack-driven prompts/notifications
  (`src/lib/server/planner_notifications.js`, `971bot.js`), driven by a
  Supabase `pg_cron` job every 15 minutes.
- **`strategy/`, `matchscout/`, `pitscout/`, `notescout/`, `scouting-admin/`,
  `teamview/`, `discover/`, `powerrankings/`** - FRC competition scouting:
  pit scouting forms, match data scouting, notes, cross-team data
  discovery/analysis, the cross-source strategy board, and the local-scouting power rankings + persisted human
  consensus + star-plot head-to-head comparison view (own top-level tab, not
  nested under `scouting/`).
- **`scouting/vision/`, `scouting/vision/dashboard/`** - post-match
  multi-view ML processing, TBA discrepancy review, and the release bridge
  into `scout_data_events` (the release action itself is `VISION_RELEASE`-
  gated; everything else is open to any approved user). The GPU stack lives
  in `vision/runner/` (dense tracking) and `vision/qwen/` (full BF16
  Qwen3-VL-30B-A3B service on DGX Spark); the fleet/throughput dashboard is
  a sub-route, the offline training toolchain lives in `vision/training/`,
  and acceptance metrics live in `vision/evaluation/`.
- **`cots-stocking/`, `kitting/`** - purchasing/inventory: COTS (commercial
  off-the-shelf) part stock tracking and kitting workflows.
- **`tasks/`** - general task tracking, separate from the planner's
  scheduling-focused tasks.
- **`admin/`, `profile/`** - user/permission administration and the Account
  settings destination.
- **`docs/`** - repo-wide markdown file browser (see **Features** above).
- **`scouting/`** - new unified scouting app, currently blank (see **Features** above).
- **`api/`** - server endpoints backing the above, plus integration
  webhooks/crons: `api/cam-generate` (synchronous G-code generation),
  `api/drive-watcher` (Drive input-sweep, cron-gated), `api/planner`
  (notification sweep, cron-gated), `api/onshape`, `api/tba`, `api/971bot`
  (Slack), `api/attendance`, `api/scout-assignments`, `api/scouting-admin`,
  `api/scouting-config`, `api/tasks`, `api/admin`, `api/notifications`.

## `src/lib` (shared code)

AutoCAM's own code (engine, Drive watcher, `camJobs.js`, its components) is
**not** here - see the dedicated **AutoCAM** section above for why.

- **`server/`** - server-only modules (`$lib/server/...`, never bundled to
  the client): `971bot.js` (Slack), `cron_auth.js` (shared auth check for
  cron-triggered endpoints - see **Known gaps**), `planner_notifications.js`.
- **`planner/`** - planner domain logic (scheduling, interaction rules,
  timezone handling - Pacific time throughout, see `PACIFIC_TIME_ZONE` in
  `src/lib/timezone.js`).
- **`components/`** - shared Svelte components: `CadViewer.svelte` (a
  generic STEP/3D viewer used outside AutoCAM too - `/manufacture`,
  `/manufacture/completed` - so it stayed here rather than moving into
  `autocam/` despite being CAD-adjacent), nav/layout pieces, etc.
- **`stock.json`** plus **`manufacturing_stock_options`** - bundled baseline
  stock choices and approved-user additions shared by the new manufacturing
  request form, including aluminum, polycarbonate, SRPP, tube, and lathe stock.
- **`matchScouting.js`** - shared match-scout vocabularies and the parser that
  turns exact/range/open-ended auto point estimates into explicit numeric
  bounds and a conservative aggregation value; `RebuiltFieldMap.svelte` owns
  the reusable 2026 field-relative drawing surface, including the 29-inch
  footprint, protected-geometry validation, and centerline-overlap analysis.
- **`config/`** - feature flags (e.g. `DISABLE_AUTOCAM` - see **Known
  gaps**, the legacy autocam system this flag referred to has since been
  removed entirely).
- **`notifications/`, `stores/`** - notification settings, Svelte stores for
  cross-component state.

## Data layer

- **Migrations** live in `migrations/*.sql`, applied via the Supabase MCP
  tooling (`apply_migration`) - not a formal migration framework, just
  timestamped SQL files. Many migrations use `CREATE ... IF NOT EXISTS` /
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` throughout specifically so
  they're safe to re-run (see `migrations/20260817_cam_studio_system.sql`'s
  own header comment for the reasoning) - prefer that pattern for new
  migrations too.
- **RLS (Row Level Security)** is the real authorization boundary - not
  app-layer checks. Every table should have RLS enabled with real policies;
  see **Known gaps** for tables that currently don't.
- **Power-ranking consensus** is stored in `scouting_pairwise_votes`, with a
  unique row per event/team-pair/scout and RLS restricting writes to the
  authenticated scout's own choice. The API returns aggregate-safe team and
  winner keys, not voter identities; consensus is deliberately separate from
  the calculated Scout Power inputs.
- **Auth**: Supabase Auth, client-side only (no server session/SSR) - see
  `docs/guides/AUTH_PROTOCOL.md`.

## Deployment & CI

- **Cloud Run** (`geminiapi-469220` project, `spartanshub` service,
  `spartanshub.spartanrobotics.org`): builds via Cloud Build
  (`cloudbuild.yaml`), triggered on push to `main` on the `spartanshub`
  GitHub remote. See `docs/deployment/google-cloud-run.md` for the full
  setup/secrets checklist.
- **Vercel**: the original deployment target, being phased out per
  `implementations/vercel-and-supabase-to-google-plan.md` - not yet
  decommissioned as of this writing (see that plan doc's TODOs).
- **Vision GPU worker**: `vision/runner/docker-compose.yml` deploys the
  dense YOLO/ByteTrack runner and private full-BF16 Qwen3-VL service together
  on NVIDIA DGX Spark. It is separate from the web deployment, uses a
  persistent Hugging Face model cache, and calls the app through authenticated
  runner APIs; see `vision/runner/README.md`.
- **No GitHub Actions CI** - "the GitHub workflow" for this project is the
  branch/PR process below, not a `.github/workflows/*.yml` file (none
  exists). The closest thing to a CI check is the Cloud Build trigger
  itself, which runs on real pushes to `spartanshub`'s `main`.

## Contribution workflow

- **Remotes**: two - `stormcoded` and `spartanshub` (`frc971/spartanshub`,
  the team's org repo). `spartanshub` is the **primary** remote and the
  source of truth for day-to-day feature work; `stormcoded` is kept in sync
  afterward. `spartanshub` requires PRs (branch protection) - `stormcoded`
  accepts direct pushes to `main`. (A third remote, `origin`, existed
  earlier but was removed.)
- **New feature work starts on a branch**, not direct commits to `main` -
  and **the branch+PR dance is `spartanshub`-only**: branch off `main`, do
  the work, push the branch to `spartanshub`, open a PR against
  `frc971/spartanshub`, merge it there (don't delete the branch after
  merging), then sync `stormcoded` with a plain direct push to `main` - no
  branch/PR for `stormcoded`, ever. Small fixes/doc tweaks can still go
  straight to `main` on both.
- **Check sync before starting a new feature** - `git fetch spartanshub
  main` and compare against local `main`/the working branch before
  branching, so feature work doesn't start from a stale base.
- **Never add a Claude/AI co-author trailer** on commits in this repo - a
  standing, explicit, non-negotiable rule.

## Known gaps (check before assuming otherwise)

- **RLS is now enabled on every table in `public`.** This previously listed 8
  tables with it switched off; all are closed (`pit_scout_entries` with the
  match-scouting work, the remaining 7 in
  `migrations/20260830_enable_rls_remaining_tables.sql`). Verified live rather
  than assumed - re-check with the Supabase security advisor before trusting
  this line, since a new table is easy to add without a policy.
- **`PUBLIC_ONSHAPE_SECRET_KEY` no longer ships in the client bundle**, but
  **the old key must still be rotated.** `src/lib/onshape.js` used to import it
  even though it never used it (every call already went through
  `/api/onshape`), and `$env/static/public` inlines anything it touches - so
  the secret was in `client/_app/immutable/` for every visitor who loaded a CAD
  page. The import is gone, verified by building with a canary value and
  grepping the client output. `api/onshape/+server.js` is now the only consumer
  and prefers private `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY`, falling back
  to the `PUBLIC_` ones the deploy still supplies. Remaining work is
  operational, not code: rotate the key in Onshape, add the private pair to
  Secret Manager and `cloudbuild.yaml`, and drop the `PUBLIC_ONSHAPE_*_KEY`
  substitutions. See GitHub issue #86.
- **Cron-auth (`cron_auth.js`) is fail-open by design** when no
  `CRON_SECRET`/`CRON_TOKEN`/`CRON_NOTIFICATION_TOKEN` is configured -
  intentional for frictionless local dev, but means the real secret must
  actually be set in production or `/api/planner/notifications` and
  `/api/drive-watcher` accept unauthenticated requests. Confirm this is
  configured before trusting either deployment target is fully locked down.
