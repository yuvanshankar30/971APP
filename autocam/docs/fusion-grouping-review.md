# Fusion grouping draft and AutoCAM review

Reviewed repository baseline: `dc36c55` (2026-09-05). This is a targeted
review of AutoCAM grouping and the Fusion plate-to-Runner path, not an audit
of every toolpath strategy. Findings below are in the existing baseline;
the planning-view draft does not fix them. No production database changes
or physical machining tests were performed.

## Draft behavior

Parts defaults to groups keyed by the existing material/thickness category.
Each group shows its part types and remaining quantity, including fully
assigned part rows. Unknown categories stay separate and cannot navigate to
matching stock. Turn grouping off to recover the existing flat list.
“View matching plates” opens Plates filtered to the category; “Show all
plates” clears it. Existing per-part nesting and queue controls remain the
next steps. Matching stock does not establish geometric fit, clamp clearance,
machine compatibility, or approval to cut.

Context: [#295](https://github.com/frc971/spartanshub/pull/295) introduced
per-plate nesting and quantity bookkeeping;
[#308](https://github.com/frc971/spartanshub/pull/308) added stock categories;
[#231](https://github.com/frc971/spartanshub/pull/231) and
[#235](https://github.com/frc971/spartanshub/pull/235) tightened the separate
router grouping pipeline. This draft uses Fusion's stock categories rather
than extending the router G-code concatenation path into Fusion.

## Review findings

### P1: Assignment and inventory writes are not atomic

`src/lib/fusionCam.js:177–204`, also `210–233`.

Assignment upsert succeeds before the remaining-quantity update. If the
second request fails, the first remains committed, but the UI reports failure.
Retrying the same assignment computes a zero delta and never repairs the
inventory. Concurrent edits to different plates also read the same remaining
quantity and can both reserve it. Removal has the inverse failure window.

Reproduce with a mocked or local database: create a part with quantity 5;
assign 3; fail only the following parts update. The assignment persists while
quantity stays 5. Retrying still leaves 5 available. This follows directly
from the two awaited writes; no concurrency is required. Confirmed with a local
Supabase mock executing the current helper, including the unsuccessful repair
on retry.

Fix direction: one transactional database operation, locking the part row,
validating stock category and positive integer quantities, and updating the
assignment and inventory together. Route all assignment mutations through it.

### P1: Deleting a plate permanently loses its reserved quantities

`src/lib/fusionCam.js:152–155` and
`migrations/20260820_fusion_cam.sql:153`.

`deletePlate` deletes only the plate. Its foreign key cascades assignment
removal, bypassing `removePartFromPlate` and its inventory restoration.
Assign all 5 units of a part to a plate, then delete the plate: the part remains
at zero, no assignment exists to remove, and the nesting dropdown excludes it.

Fix direction: transactional restoration with plate deletion (or a database
trigger), followed by refreshing available parts in the Plates view. Reconcile
existing data separately; do not silently overwrite production inventory.

### P1: A multi-part plate can complete with missing parts

`src/routes/api/fusion-runner/+server.js:107–120`.

Payload assembly silently skips assignments without a STEP filename or a
successfully signed download URL. With one valid part and one missing file,
the Runner receives only the valid part and can report successful completion
for an incomplete plate. Parts allows STEP uploads to be omitted, so this is
reachable through the UI. A local mock executing the current payload builder
confirmed that two assignments become a one-part payload when the other STEP
filename is absent. The assignment query's error is also ignored.

Fix direction: fail payload construction with the affected part IDs whenever
any expected assignment cannot resolve; do not submit a partial group to CAM.

### P1: Fusion catalog write authorization exists only in the UI

`migrations/20260820_fusion_cam.sql:208–230`.

The write policies use `FOR ALL` with only `auth.role() = 'authenticated'`.
They permit any signed-in account to mutate plates, parts, and assignments,
regardless of `canManageCamProfiles`. Because the policies also cover SELECT,
they additionally allow reads that the separate approved-user policies intend
to restrict. No later migration in this checkout replaces these policies.

Reproduce in an isolated database using an unapproved authenticated identity:
query or mutate these tables through the public client directly. A hidden
button does not constrain that request.

Fix direction: enforce approval and intended manufacturing roles in database
policies or an authenticated server path. Verify manager, ordinary approved,
unapproved, anonymous, and service-role access against a local database.

### P2: Queued Fusion jobs use mutable plate contents

`src/lib/fusionCam.js:303–328` and
`src/routes/api/fusion-runner/+server.js:95–110`.

Queueing records a plate ID, but resolves its dimensions and assignments only
when a Runner claims it. Queue a plate, edit/remove a nested part before the
Runner polls, and the job cuts the later contents despite its earlier queue
action. Multiple jobs for the same plate can resolve different contents with
no revision recorded.

Fix direction: snapshot validated plate inputs when queueing, or record a
revision and reject stale jobs. Prevent mutations during an active run as
appropriate; keep generated artifacts tied to the revision actually processed.

## Before extending this into bulk assignment

Use an atomic multi-part reservation operation with deterministic row locking,
server-side category/quantity checks, and explicit permission checks. Preserve
existing assignments when applying deltas. Decide whether a selection means
“add more” or “set total”; the current helper is an upsert of the total.
Define stock revisions and fail incomplete payloads before introducing a
one-click group-and-queue flow. Verify transaction rollback, simultaneous
reservations, deletion restoration, and a real multi-part Fusion run.
