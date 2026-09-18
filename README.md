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
  and a Completed-page action to duplicate a historical part as a fresh ToDo
  request while retaining its source/CAD references,
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
  Router request cards link only to the Fusion AutoCAM workflow and derive their
  job status/G-code downloads from actual Fusion generation jobs (not
  arrangement-only runs); a request cannot advance to CAM review until its
  linked Fusion job has completed with NC output.
  CAD and Build tracking share one CAD folder in the main navigation
  (`/cad` and `/cad/build`), independent of the Onshape integration's own
  connection state - a saved layout from while CAD was briefly hidden still
  resolves correctly (see `promoteChildrenOfDisabledFolders` in
  `src/lib/defaultTabs.js`).
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
  is a separate sub-section, **Fusion AutoCAM** (`/autocam/fusion/parts`), backed by
  an actual Fusion 360 Runner rather than in-process math; it is intentionally
  absent from the New AutoCAM Job operation picker. The shared **Send to
  Fusion AutoCAM** action queues both sheet parts and rectangular box tube stock,
  with the same Fusion document name and Data Panel folder selection;
  its views have stable routes at `/autocam/fusion/parts`,
  `/autocam/fusion/tubes`, `/autocam/fusion/turning`, `/autocam/fusion/jobs`, and
  `/autocam/fusion/stock-categories` (the legacy root redirects to Parts);
  Manufacturing's per-request **AutoCAM** action stays in Manufacturing and
  opens its own queue dialog, where the operator selects plate or tube stock
  before the request's quantity, STEP file, stock, and identifiers are copied
  into the linked Fusion CAM record. Fusion Parts and Tube Stock retain the
  copied project ID and stock assignment in their own rows, display both in
  their lists, and offer the existing Manufacturing project IDs for ad-hoc
  AutoCAM records.
  The box-tube path creates four face-scoped Fusion setups and posts separate `Side 12`,
  `Side 3`, `Side 6`, and `Side 9` files for manual indexing. See the
  **AutoCAM** section below for the code-level detail on all three.
  Every completed Fusion NC artifact is automatically published to the Files
  `AutoCAM` folder. Each tube job gets its own subfolder containing exactly
  four distinct programs, one for each indexed setup: Side 12, 3, 6, and 9.
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
- **JProg**: a standalone, session-authenticated `/jprog` workspace
  that ports the shop's manual JProg sheet workflow to the web: searchable
  persistent stock sheets/cuts, a reloadable Storage-backed grouped part
  library, thickness-specific bundled hole programs, G-code inspection,
  measurement, reusable click-to-place canvas placement,
  selection/drag/rotation/pan/zoom/undo, and suffix-grouped LinuxCNC or
  WinCNC G-code emission. Before a multi-tool WinCNC emit, the operator can
  reorder the complete detected tool list; the output groups every part by
  that order and records it with the emission. Emitted programs are stored in the Manufacturing
  Files bucket under `JustinProgOutput/YYYYMMDD/`, with the date folder created on
  the first emission that day and the same path committed to the public
  `yuvanshankar30/output` repository via a Supabase Edge Function. Its GitHub
  credential lives only in Supabase function secrets, so neither the browser nor
  the Cloud Run deployment needs access to it. It intentionally has no AutoCAM or Fusion
  Runner connection; its tables and Storage paths are owned by the nesting
  JProg feature and its entry point is the Manufacturing page action.
  Manual `.ngc` and `.tap` uploads made at the JustinProgOutput root are placed in
  that day's UTC folder automatically; uploads made inside an existing date
  folder stay there and are committed to the same GitHub mirror.
  The JProg layout visualizer restores saved part toolpaths, including legacy
  pre-sheet-scoped library placements, and supports arbitrary 0-360 degree
  part rotation alongside quarter-turn shortcuts.
  A sheet is locked to either LinuxCNC `.ngc` or WinCNC `.tap` programs on its
  first upload, and emission uses that one corresponding program type.
  For WinCNC plate programs, the release/slot cut that separates a part
  from stock must use Tool 6; AutoCAM rejects another assigned release tool
  before posting, and JProg rejects it again before emission.
  Its part programs are isolated in Manufacturing Files under `Nesting Parts
  Library/<sheet name>/`.
  A sheet can contain multiple named cuts: every cut remains visible in its own
  canvas color, while editing and G-code emission apply only to the selected
  cut and its holes.
  Operators can install the separate shared repository through a Desktop
  `Output` link with `/install/jprog-output` (or `/install/jprog-output/windows`
  on Windows); its per-user sync service sorts new G-code,
  commits/pushes local changes, and pulls Output Editor changes automatically.
  See `jprog/SHARED_OUTPUT_FOLDER.md` for the one-command setup and
  operator details.
- **JustinProgOutput contract**: `JustinProgOutput` is the canonical output root
  in both the `manufacturing-drive` Storage bucket and the public
  `yuvanshankar30/output` repository. Every emitted or manually uploaded
  `.ngc`/`.tap` file is stored as `JustinProgOutput/YYYYMMDD/filename`, using
  the Pacific calendar date. Root uploads are routed into the current date folder;
  uploads inside an existing date folder remain there. The Supabase
  `jprog-output` Edge Function authenticates the caller, validates the path and
  content size, then creates or updates the matching GitHub Contents API path
  with a commit. The browser never receives the GitHub write token.
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
  focused team briefs without duplicating data entry. Completed Match
  Scouting reports flow into Strategy and Power Rankings and remain fully
  inspectable there; Scouting Admin also shows event-level report coverage
  and the complete attributed submissions for auditing. Strategy orders its
  team board by the live official TBA event rank when available, and selecting
  a row opens that robot directly in the full Team View. Team View accepts
  event/team deep links and combines TBA robot media, official rank and record,
  971 Scout Power, the event-relative star plot, the current scout's rating,
  pit details, saved autos, performance trends, notes, every manual match
  report, and completed-match video/TBA links. Strategy seeds its
  team board from the full TBA event roster, including teams with no scouting
  observations yet, and its match view includes a clearly labeled practice
  match when the real schedule is empty. Robot Ratings orders rated teams by
  overall average from best to worst, followed by unrated teams. The Prediction
  Market uses play points throughout and shares the same non-settling practice
  match so scouts can test placing, updating, and cancelling predictions. The
  event picker always includes the active event and resolves keys such as
  `2026cc` to their TBA name (for example, Chezy Champs) when available.
- **Vision Scouting**: a real Competition-folder nav tab, open to every
  approved user like the rest of Competition (no special permission needed),
  running post-match, multi-camera ML processing at `/scouting/vision` for
  robot trajectories/mobility, fuel, and climbing, with a calibrated
  red/blue field-occupancy heatmap that fills as trajectory results arrive.
  Generic robot-only YOLO weights are supported: a conservative second stage
  reads the lower bumper band for alliance colour and rejects unclear crops;
  roster-constrained bumper-number reads remain review-required before a
  track is attached to a team.
  A full BF16 Qwen3-VL-30B-A3B-Instruct service on NVIDIA DGX Spark proposes semantic
  events from bounded multi-camera clips; a
  separate versioned YOLO/ByteTrack runner supplies dense tracking and
  mobility. Fuel uses an HSV/contour baseline with motion-predicted association,
  observed goal-entry candidates, and pixel-space shooter matching (not ball
  pixels compared to robot metres). Each camera video gets fresh tracker state.
  Both feed a human-reviewed evidence queue rather than silently
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
  `docs/guides/scoutingvision.md` for the full file-by-file implementation
  reference, and `docs/plans/scoutingvision-remaining-work.md` for what
  still has to happen before it is usable. No real trained detector or reviewed
  footage is supplied in this repository; current Spark runtime state requires
  host verification. See `vision/evaluation/pipeline-review.md` for the YOLO fuel
  benchmark, bounded-review-agent decision, OpenAI/DeepSeek candidates, and
  precision/training plan. External model APIs are not enabled by that plan.
  The run screen now shows a pre-queue readiness checklist (views, pinned model,
  live runner, roster, masks, goal/start zones, and homographies), requires an
  explicit acknowledgement for incomplete shadow runs, shows selected upload
  size, and provides keyboard observation review. A `VISION_RELEASE` holder
  must generate and inspect the exact proposed `scout_data_events` rows before
  the release button is enabled. The Chezy capture, storage, review, fallback,
  and ownership procedure is in `docs/guides/chezy-vision-runbook.md`; runner
  hosts have a read-only `vision/runner/preflight.py` check.
- **Planning**: Gantt-based build/task scheduling (`wx-svelte-gantt`),
  Slack-driven prompts and reminders on a 15-minute cron sweep.
- **Purchasing/Budget**: COTS (commercial off-the-shelf) part stock
  tracking, orders, delivery, kitting, budget controls, and a phone-only
  **Scan** receiving workflow. A purchaser photographs packaging or a
  shipping label from a phone or computer; a server-side OpenAI `gpt-4o-mini` vision request extracts
  the visible text and ranks still-open purchasing rows. The photo is not
  stored, and an in-app confirmation is required before the selected item is
  atomically marked delivered with a receiving audit event.
  Purchasing is tied to CAD parts (`cad/purchasing`) with budget
  tracking/allocation by project or build (admin Budgets tab). The table can
  calculate each line as unit price × quantity; members can hide that Total
  column in Account Settings → Appearance without changing shared purchasing data.
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
  Notifications panels instead of one continuous settings scroll. Password
  changes require the current password; an account may instead request a
  password-reset email from the same page. The selected theme is saved with
  the signed-in account and restored after that email signs in again, including
  after signing out.
- **Default navigation**: Home is always first, followed by Manufacturing,
  Competition, CAD, and Purchasing. Members can still customize this order in
  their Account navigation settings. Signed-in members can also open global
  site search from the header (or `⌘/Ctrl+K`) to find relevant user-facing
  pages, including pages not currently pinned to their personal navigation.
  Saved layouts preserve personal organization while automatically receiving
  every current default tab, so new and restored team tools do not vanish.
  Scouting Admin is restricted to site administrators and the dedicated
  Scouting Admin roster entries for Arya Saikia, Caden Nguyen, and Aarush
  Rajagopalan.
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
  requires a described ACE Team handoff whenever a robot breaks mechanically or is marked disabled or dead;
  general notes and the auto-path drawing remain optional. The path tool uses
  a simplified, alliance-relative version of WPILib/AdvantageScope's top-down
  2026 REBUILT field, so the scout's wall is always on the left and red/blue
  paths share one useful coordinate system. Releasing and pressing again
  continues the saved route; only Clear removes it. Auto scoring accepts an
  exact estimate, a bounded range such as `40-60` (stored average `50`), or an open
  lower bound such as `100+` (conservatively stored as at least `100`). Teleop
  requires a ball-count estimate with selectable 25-ball suggestions or typed
  whole numbers, ranges, and lower bounds, storing the input and parsed bounds.
  Pre-match captures the scout name and preload, and shows alliance-specific starting-position photos configured by scouting
  admins (with the bundled WPILib 2026 REBUILT field image and highlighted
  starting lanes as the default). Field previews orient the own alliance wall
  on the left; the vendored image attribution/license is in
  `static/rebuilt-2026-field.LICENSE.txt`.
  Admins can correct email-only profile names directly from Competition Roles;
  Match Scout display labels retain existing Data Scout permission keys.
  Auto records completed cycles and fuel sources (Neutral Zone, Outpost, Depot, Ground, Preload). Teleop requires
  roles (Scorer, Defense, Shuttler, or explicitly None observed), shot accuracy
  and BPS ratings (click a selected rating again to leave it unjudged; no
  separate Unknown buttons), significant-crash/target answers,
  and robot status (Active, Dead, or Stopped). Post-match also records whether
  the robot became beached. Brownouts use the
  Dead option; historical brownout answers reopen under that
  option when editing. Apply `20260913_match_scout_stopped_status.sql`
  before deploying to allow Stopped in the database; historical Unknown
  answers remain readable. Optional driver awareness, defense, and reliability ratings
  use the original 1–5 scale. Intake speed (1–3) and intake-jam observations
  are also collected and restored when editing reports. Cycle speed and driver skill are no longer collected; existing values
  are preserved when editing historical reports. Historical
  reports retain their original fields. Match scouts can reopen their submitted
  answers immediately or find their own active-event reports in **My reports**,
  search by team or match, and save corrections to the existing report.
  Match report lists use compact cards that surface auto points, balls scored,
  robot status, and incidents while collapsed; opening a card shows a dense,
  color-coded breakdown so multiple matches for one robot stay easy to scan.
  **Compare** in My reports opens labeled blue/manual and orange/vision charts
  for the same event, match, and team. Scouts can select a vision run, refresh
  results, and filter reviewed observations or include provisional candidates.
  The comparison includes every manual answer, vision event evidence, and
  calibrated track metrics; missing data is labeled rather than treated as
  zero. Subjective ratings and autonomous points are not inferred from ball
  counts. `src/lib/scoutingComparison.js` builds the comparison, rendered by
  `ScoutingComparison.svelte`; `/api/matchscout/comparison` restricts manual
  report access to its authenticated author and retains vision’s RLS policy.
  Pit scouting reloads each team’s saved entry for further edits. Apply `20260913_match_scouting_form_v2.sql`
  before deploying this form. Teleop and post-match prose areas are deliberately
  large enough for real scout observations. Timed robot actions, per-fuel
  taps and the objective endgame result are recorded through Quick Scout
  (`quickscout/`), which writes the same `scout_data_events` the removed
  Data Scouting page did. All scouting mutations require a real signed-in
  user, including in local development; write attribution always comes from
  the verified session rather than a caller-provided user ID. Public,
  event-scoped read views remain available where documented.
- **Match Rankings** (`matchrankings/`): a shared post-match ordering board
  in Competition. It loads the six teams from each The Blue Alliance match,
  lets the scouting group save and later revise one best-to-worst order per
  match, and turns each order into higher-over-lower evidence for the separate
  Human Rank shown in Power Rankings. This connects robots indirectly across
  matches while leaving calculated Scout Power unchanged.
- **Power Rankings** (`powerrankings/`): the Competition ranking readout - its
  own page rather than a mode of the Pick List workspace, so it never gets
  confused with that page's comparison table. An event-relative ranking built
  from combined local scout observations.

  It shows **four deliberately distinct measures**, and the page says so in
  as many words, because conflating them would misrepresent an official FRC
  standing:
  - **971 Scout Power** - our own ranking from our own scouts. The primary
    column, and *not* an FRC ranking; it exists to inform our picks.
  - **Human Consensus** - a separate preference rank produced by the shared
    post-match order plus authenticated head-to-head choices. Each saved match
    order contributes its higher-over-lower robot comparisons, which carries
    ordering across matches; each scout's direct choice remains one current
    vote per event/team pair. Neither signal alters Scout Power. A
    two-thirds-or-stronger majority that opposes a calculated Scout Power gap
    of at least five points flags both robots for human review.
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
  and legacy notes remain review-only. Within match performance, the original
  event-tap inputs retain their weights: average fuel per match (40%), driving
  (20%), accuracy (15%), climb level (15%), and speed (10%). Structured Match
  Scouting reports add independently normalized balls scored, driver skill,
  shot accuracy, cycle speed, auto points, and reliability evidence only when
  those fields were actually observed; missing dimensions are omitted and the
  remaining weights are rebalanced instead of being treated as zero. Also
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
  `node_modules`.
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

**[ARCHITECTURE.md](docs/design/ARCHITECTURE.md)** has the whole-system diagram (client,
Cloud Run, Supabase, the two AutoCAM execution paths, the Vision Scouting
GPU worker, external integrations) - same living-reference rule as this
file: update its diagram alongside this section, not separately from it.

## Stack

- **Framework**: SvelteKit (Svelte 5), plain JS (no TypeScript) with
  `jsconfig.json` for editor type-checking.
- **Hosting**: dual right now - Google Cloud Run (`adapter-node`, primary
  going forward) and Vercel (`adapter-auto`, being phased out). See
  `docs/deployment/google-cloud-run.md` and `docs/guides/googledrivesetup.md` (Drive
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

Two independent pipelines share this folder, each in its own subfolder, plus
a handful of genuinely shared modules at the top level:

- **`autocam/inprocess/`** - the in-process pipeline described below: pure
  JS math, synchronous server-side generation
  (`src/routes/api/cam-generate/+server.js`), no external process. It has no
  dedicated page anymore (the old `/autocam` UI was removed) - it's called
  directly from `/manufacture/create` and from `/api/cam-generate`/
  `/api/cam-groups`. All of its generator modules, tests, and job-queueing/
  UI components live together here.
- **`autocam/fusion/`** - **Fusion AutoCAM**, described further down -
  a real Fusion 360 Runner polling `cam_jobs`, reachable from
  `/autocam/fusion`.
- **Top level (`autocam/stepProfile.js`, `stockMaterial.js`,
  `gcodeComments.js`, `gcodeLint.js`, `geometry2d.js`,
  `components/AtcSlotConfig.svelte`, `postprocessors/`, `docs/`,
  `__fixtures__/`)** - shared by both pipelines, or used by unrelated pages
  entirely (`gcodeLint.js` backs `/manufacture/gcode-converter`;
  `AtcSlotConfig.svelte` is also used directly by `/manufacture`) - not
  specific to either pipeline, so not moved into either subfolder.

- **`autocam/stepProfile.js`** - extracts 2D profiles (turning/routering) or
  tube-wall hole geometry (`extractTubeFeaturesFromMeshes`) directly from a
  STEP file's triangulated mesh (via `occt-import-js`).
- **`autocam/inprocess/turning.js`** / **`autocam/inprocess/routing.js`** / **`autocam/inprocess/tubestock.js`**
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
  conservative dry-routing defaults when stock has not been selected. In
  New Router multi-tool jobs, a loaded cutter without a reviewed preset for
  the selected material is excluded before planning, so it cannot cause an
  ATC swap; ATC swaps are limited to Aluminum 6061, and a job with no
  reviewed endmill fails before CAM generation.
  `routing.js`/`tubestock.js` support two controller dialects
  (`params.controller`: `'linuxcnc'` default, `'wincnc'`) - see
  `autocam/postprocessors/README.md` for the shop's real post-processor
  configs and a real Fusion-cammed example file, used as ground truth for
  what each dialect actually needs rather than a generic manual.
- **`autocam/fusion/`** - the Fusion 360-backed plate and box-tube pipeline.
  Plate queueing replaces the category's reusable hidden nest and creates its
  immutable job snapshot in one PostgreSQL transaction, so cancelling a
  confirmation or losing one grouped write cannot reserve partial stock.
  Completed-part attribution is read from that snapshot rather than the plate's
  later mutable contents. The Runner preserves the configured postprocessor's
  native artifact extension (`.tap` for ShopSabre), refuses destructive Fusion
  document-name collisions, and treats a failed cloud save as a failed job.
  `/install/fusion-runner` serves a site-origin-aware, checksum-verifying
  shell bootstrap so a workstation can install the current Runner directly
  into Fusion from one `curl` command without cloning the repository. First
  install opens `/install/fusion-runner/setup`, a standalone one-field pairing
  page where the shared team token authorizes a short-lived, one-use setup
  session; the installer receives a unique machine token and writes all local
  configuration automatically. The installed add-in checks the authenticated
  release API at startup and every five idle minutes, checksum-verifies and
  stages newer packages in Fusion's AddIns directory, preserves machine-local
  state, and pauses new claims until Fusion restarts onto the new code.
- **`autocam/inprocess/gcodeFormatting.js`** / **`autocam/geometry2d.js`** - shared
  numeric G-code formatting, pause/dwell dialect handling, and polygon-area
  primitives used across generators so safety-critical output rules do not
  drift between copied implementations.
- **`autocam/inprocess/toolpathPreview.js`** - parses generated G-code back into a
  toolpath for the 2D preview and 3D simulator, including a cumulative-distance
  interpolation helper for playback (`autocam/inprocess/components/ToolpathViewer.svelte`,
  `autocam/inprocess/components/ToolpathSimulator.svelte`).
- **`autocam/gcodeLint.js`** - checks a program against the conditions that
  stop LinuxCNC loading it (nested/unclosed comments, characters that are
  illegal outside a comment, words with no value) and repairs malformed
  comments. `autocam/inprocess/routingLinuxcnc.test.js` runs real generated router and
  tube-stock output through it, so a generator change that emits something
  LinuxCNC would reject fails the suite. Backs the **G-code Converter**
  tab (`/manufacture/gcode-converter`), where a pasted program is checked
  and exported as `.ngc` - see `implementations/manufacturing-text-to-ngc-converter.md`
  for a design-only proposal to add a second input mode there (a plain
  point list, not already-valid G-code). The rules are calibrated against the cncjs
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
- **`autocam/inprocess/nesting.js`** / **`autocam/inprocess/groupedGcode.js`** - deterministic,
  conservative router-job placement from real G-code bounds and one-program
  composition for grouped sheets; see `autocam/docs/router-job-grouping.md`.
- **`autocam/inprocess/drive_watcher.js`** - Google Drive input-sweep (`cad` →
  auto-queue) and output-delivery (finished G-code → dated `cammed`
  subfolder) - see `autocam/docs/drive-watcher-folder-layout.md` for the real folder
  layout this was built for. Sweeps persist a cursor after each bounded
  Changes API page, and delivery names include the job ID so two jobs
  completed in the same second cannot overwrite or ambiguously duplicate
  one another.
- **`autocam/inprocess/camJobs.js`** - shared job-queue helpers used by
  `/manufacture/create` (auto-queues a job for a linked part) and the
  `/api/cam-generate`/`/api/cam-groups` routes - no dedicated page of its
  own since the old `/autocam` UI was removed.
- **Machine-scoped tooling** - `cam_machine_tools` records which cutters are
  installed on each physical profile. Choosing a machine filters the job's
  Tool / End Mill selector and copies a selected router bit's diameter into
  the generated-job parameters and 3D simulation. The seeded UNC Router
  default is a `0.1575 in` flat end mill; operators can add another tool for
  the selected machine directly from the job form.
- **`autocam/inprocess/components/`** - `ToolpathViewer.svelte`,
  `CamParamFields.svelte`, `RoutingToolSequence.svelte`,
  `TurningFinishTool.svelte`, and `TurningDrilling.svelte`. (`AtcSlotConfig.svelte`
  stays at the shared top-level `autocam/components/` - it's used outside
  this pipeline too, by `/autocam/fusion` and `/manufacture` directly.)
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
  360 Runner) - now built as **Fusion AutoCAM**, see the next bullet.
- **`autocam/fusion/`** (reachable from `/autocam/fusion/parts`; the legacy root redirects there) - **Fusion AutoCAM**:
  a native SvelteKit/Supabase milling pipeline that fills the gap the rest
  of AutoCAM deliberately doesn't solve (real 3-axis
  contoured toolpaths via Fusion 360's own CAM engine, not flat 2.5D
  profiles). Backed by new `fusion_parts`/`fusion_plates`/`fusion_box_tubes`/
  `fusion_part_categories` tables plus the reused `cam_jobs`/`cam_machines`/
  `cam_tools`/`cam_materials` tables and a claim/complete/fail endpoint at
  `src/routes/api/fusion-runner/+server.js`. `autocam/fusion/runner/` is the
  Fusion 360 add-in that actually runs CAM. Its active workflows
  use the configured `2026 Season CAM` Data Panel project as a strict root:
  if Fusion cannot resolve that project, it stops folder sync/save work rather
  than falling back to the active project and exposing a mislabeled tree.
  compare completed plate G-code against the part's internal CAD loops and
  stock depth before reporting completion, surfacing missing-feature,
  incomplete-through-cut, and unsafe thin-wall findings as job warnings.
  Plate release tabs use the established explicit placement on straight outer
  edges. The runner prefers stock-backed edges when that state is available,
  but preserves its legacy fallback so a release contour is not silently
  generated with no manual tabs.
  They patch Fusion templates from the claimed tool's checked-in `.tools` archive
  and post with the claimed machine's checked-in `.cps` file; the filename is
  stored on `cam_tools.fusion_tool_library_file`, so an unknown tool fails
  visibly rather than falling back to Fusion's raw default. No Teams/API-key-per-team
  layer was ported - the shared enrollment secret is injected as
  `FUSION_RUNNER_TOKEN` by Cloud Build, while browser pairing exchanges it for
  a revocable per-install `API_KEY`. Vision Runner uses its separate
  `VISION_RUNNER_TOKEN`; both runtime values are injected from their own
  Secret Manager secrets, never shared or built into the image.
  The Fusion UI includes a Stock Categories tab for CAM managers to define
  the material and true-thickness combinations required before Parts and
  Plates can be nested. Parts can be grouped by stock category with remaining
  quantity totals and a shortcut to matching plates. Plate CAM makes operators
  choose either one nested part or a grouped job containing at least two part
  types; the grouped snapshot records every part, quantity, STEP file, plate,
  machine, and tool while physical arrangement stays in Fusion. Assignment
  inventory is updated transactionally in PostgreSQL, queued inputs are immutable,
  and the Runner rejects incomplete groups before CAM. Completed Fusion jobs keep
  every postprocessor output as a separate, byte-exact downloadable file with its
  size and SHA-256 checksum; queued and terminal jobs can be deleted from the queue.
  New Router plate jobs remain single-endmill by default. Countersink tools
  remain available to configure in ATC Slots, but automated countersinking
  and its queue controls are intentionally deferred until its geometry
  selection strategy is validated.
  Operators can instead select Auto multi-tool mode: loaded endmills and
  drills are candidates, not mandatory operations. The Runner selects the
  highest-throughput roughing cutter plus a genuinely smaller detail cutter
  only when it can reach tighter geometry; dominated and geometry-inapplicable
  tools are omitted before post-processing, avoiding unnecessary ATC cycles.
  A release contour must retain verified manual tabs on usable, stock-backed
  straight edges; otherwise the job fails instead of posting an unsecured part.
  On grouped plates, facing tabs in the same narrow stock corridor are shifted
  along safe straight edges so their spans retain stock between them instead of
  joining into one continuous bridge.
  Every New Router Fusion job is post-processed with the bundled ShopSabre
  WinCNC `shopsabre.cps` post and emits native `.tap` output; a contradictory
  machine-profile post setting fails the job before post-processing.
  The Parts and Tube Stock send dialogs each include up to eight recent,
  queueable records in a compact quick-selection grid alongside their full
  selectors. The Parts picker provides one Clear filters action for its date,
  stock-category, and name filters.
  The Jobs tab loads the newest 200 lightweight rows once, then polls only mutable
  fields for active job IDs; base64 NC artifacts load on demand only when someone
  downloads or posts them. Manufacturing status lookups query only the relevant plate/tube
  IDs; plate STEP signed URLs resolve concurrently; and the Runner skips folder-tree
  sync writes when the snapshot has not changed. Matching partial/expression indexes
  live in `migrations/20260906_fusion_queue_efficiency.sql`.
  Rollout requires `migrations/20260906_fusion_grouping_integrity.sql`,
  `migrations/20260906_add_tubestock_operation_type.sql`,
  `migrations/20260906_fusion_queue_efficiency.sql`,
  `migrations/20260910_fusion_runner_tokens.sql`,
  `migrations/20260910_fusion_runner_tokens_setup_sessions.sql`, and the updated Runner.
  Every post-claim Runner call is bound to the `RUNNER_ID` that claimed the job,
  so another installation cannot advance it. `RUNNER_MACHINE_ID` is required,
  active jobs heartbeat through `claimed_at`, and unstarted claims older than
  15 minutes are safely requeued after a Runner crash. Processing Fusion jobs
  require operator review rather than an automatic retry. The general `/autocam` job
  list excludes these milling rows; their retry/edit controls live only in
  `/autocam/fusion`, preventing the synchronous JS generator from mutating a
  Fusion-owned job. See
  `autocam/docs/scouting-autocam-audit.md` for the consolidated audit and
  `autocam/docs/fusion-grouping-review.md` for the draft scope and review findings.
  It uses Supabase Auth + `canManageCamProfiles` for
  humans, same as the rest of this
  app. See `autocam/fusion/README.md` and the Fusion Runner's own
  `autocam/fusion/runner/README.md` for the current setup and operation guide.
- **`autocam/fusion/turning/`** - experimental Fusion turning foundation
  ([issue #331](https://github.com/frc971/spartanshub/issues/331)): validates a
  single-part round-stock plan for the Haas TL-1 and exposes an empty draft
  turning setup builder. It requires the HAAS Turning post family and rejects
  the LinuxCNC/EMC router post.
  It is not connected to the job queue and does not generate G-code. See its
  `README.md` for design choices, the example CLI, and the staged implementation.
- **Route files stay in `src/routes/`** regardless
  (`src/routes/api/cam-generate/+server.js`,
  `src/routes/api/cam-groups/+server.js`,
  `src/routes/api/drive-watcher/+server.js`) - SvelteKit determines a
  route's URL from its file location under `src/routes/`, so these can't
  move into `autocam/` themselves; they just import the engine from
  `$autocam/inprocess/...` instead of holding logic directly. There is no
  `src/routes/autocam/+page.svelte` anymore - only `/autocam/fusion` is a
  page; the in-process pipeline is invoked directly by other pages/routes.
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
  Qwen3-VL-30B-A3B-Instruct service on DGX Spark); the fleet/throughput dashboard is
  a sub-route, the offline training toolchain lives in `vision/training/`,
  and acceptance metrics live in `vision/evaluation/`.
- **`cots-stocking/`, `kitting/`** - purchasing/inventory: COTS (commercial
  off-the-shelf) part stock tracking and kitting workflows.
- **`tasks/`** - general task tracking, separate from the planner's
  scheduling-focused tasks.
- **`admin/`, `profile/`** - user/permission administration and the Account
  settings destination.
- **`docs/`** - repo-wide markdown file browser (see **Features** above).
- **`scouting/`** - the active-event Pick List workspace described under
  **Features** above; it combines TBA and local scouting data and persists the
  strategy group's shared ordering and notes.
- **`api/`** - server endpoints backing the above, plus integration
  webhooks/crons: `api/cam-generate` (synchronous G-code generation),
  `api/fusion-runner-setup` (short-lived Fusion workstation pairing),
  `api/drive-watcher` (Drive input-sweep, cron-gated), `api/planner`
  (notification sweep, cron-gated), `api/onshape`, `api/tba`, `api/971bot`
  (Slack), `api/attendance`, `api/scout-assignments`, `api/scouting-admin`,
  `api/scouting-config`, `api/tasks`, `api/admin`, `api/notifications`.

## `src/lib` (shared code)

AutoCAM's own code (engine, Drive watcher, `camJobs.js`, its components) is
**not** here - see the dedicated **AutoCAM** section above for why.

- **`server/`** - server-only modules (`$lib/server/...`, never bundled to
  the client): `971bot.js` (Slack), `cron_auth.js` (shared auth check for
  cron-triggered endpoints - see **Known gaps**), `planner_notifications.js`,
  and `fusion_runner_setup.js` (expiring browser enrollment sessions and
  one-time delivery of per-install Runner credentials).
- **`planner/`** - planner domain logic (scheduling, interaction rules,
  timezone handling - Pacific time throughout, see `PACIFIC_TIME_ZONE` in
  `src/lib/timezone.js`).
- **`components/`** - shared Svelte components: `CadViewer.svelte` (a
  generic STEP/3D viewer used outside AutoCAM too - `/manufacture`,
  `/manufacture/completed` - so it stayed here rather than moving into
  `autocam/` despite being CAD-adjacent). Its lower-left readout shows the
  model's smallest bounding-box dimension in inches as a quick thickness/depth
  cross-check, nav/layout pieces, etc.
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
  migrations too. Migrations that add, remove, or rename API-visible schema
  objects must finish with `NOTIFY pgrst, 'reload schema';` so PostgREST does
  not keep serving stale table metadata after the DDL succeeds.
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
- **Vision GPU worker**: use the bare-metal `vision-runner.service` and
  `vision/qwen/qwen.service` on NVIDIA DGX Spark; no Docker installation is
  required. Qwen binds only to `127.0.0.1:8000`, with explicit CUDA placement
  and a separate token. The worker is separate from the web deployment and
  calls the app through authenticated outbound runner APIs. Existing Compose
  files remain an optional artifact, not an instruction to install Docker.
  Schedule large-model inference and detector training separately until actual
  peak memory/throughput are measured; see `vision/runner/README.md`.
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
