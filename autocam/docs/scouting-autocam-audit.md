# Scouting and AutoCAM audit

This change consolidates the pending AutoCAM work that had been split across
local Git worktrees into one PR branch. Worktrees are local checkout folders;
they are useful for working on branches concurrently, but cannot be reviewed,
merged, or deployed themselves. The source branches are now represented by
this PR, so their local worktree directories can be removed after it is open.

## What was fixed

### AutoCAM

- Plate CAM jobs now take an immutable snapshot of plate dimensions, material,
  selected nested parts, quantities, and source file paths when queued. A
  later inventory edit cannot silently change a job already waiting for the
  Fusion Runner.
- Database triggers atomically reserve and restore part inventory, reject
  mismatched stock categories and invalid quantities, and prevent editing the
  inputs of a queued plate job. This closes race conditions from browser-side
  bookkeeping.
- Grouped jobs require two or more distinct, compatible nested part types;
  single-part jobs require exactly one. Uncategorised parts are deliberately
  never treated as compatible.
- The Runner signs source STEP paths only when it claims a job. It preserves
  every generated NC program as its own byte-checked artifact instead of
  joining files into an unsafe synthetic program.
- Post-claim lifecycle actions now require the same `RUNNER_ID` that claimed
  the job. A different installed Runner with the shared service token cannot
  move, complete, or fail somebody else’s active job.
- Feed/speed selection no longer falls back to the first/default preset for
  an unreviewed material. The historic default is allowed only for Aluminum
  6061; every other material needs a clearly named, reviewed preset.
- The experimental turning foundation explicitly permits the Haas TL-1 and
  rejects unsupported EMC posts rather than emitting misleading output.

### Scouting

The scouting validation and statistics paths were reviewed. They already
normalize team keys, cap freehand paths, reject malformed score ranges, avoid
turning missing values into zero, and derive fuel totals once per match. No
source change was justified: changing functioning scouting calculations merely
to pad this PR would be engineering by decorative duct tape.

## Verification

The JavaScript tests cover grouping, payload snapshot validation, NC artifact
validation, and runner lifecycle ownership. Fusion-specific Python tests cover
grouping and turning-plan restrictions. Run them from the repository root:

```sh
npm ci
npm test
python3 -m unittest discover -s autocam/fusion/runner/tests
python3 -m unittest discover -s autocam/fusion/turning/tests
```

Applying `migrations/20260906_fusion_grouping_integrity.sql` requires existing
Fusion inventory to balance first; it intentionally stops rather than guessing
how to reconcile bad production data.
