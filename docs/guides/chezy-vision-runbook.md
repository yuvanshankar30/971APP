# Chezy Champs 2026 vision scouting runbook

Chezy Champs runs September 18–20, 2026. For this event, vision scouting is a
**shadow system**: manual scouting remains authoritative. Do not release vision
rows into `scout_data_events` until a model has passed the acceptance gates in
`implementations/vision-scouting-system.md` and a vision lead has reviewed the
exact release preview.

## Owners

Assign names before travel. One person may hold multiple roles, but a match
must never depend on a single unattended laptop or camera.

| Role | Responsibility |
|---|---|
| Capture operator | Starts/stops fixed cameras, verifies each file, records camera movement |
| Upload operator | Creates the match, uploads every view, checks total upload size and sync offsets |
| Vision operator | Checks runner health, calibration, model identity, and queues shadow runs |
| Reviewer | Resolves robot identity and reviews every proposed observation with video evidence |
| Vision lead | Owns model acceptance, incident decisions, and the `VISION_RELEASE` permission |

## Before leaving for the event

- Confirm camera mounts, power, storage cards, chargers, cables, and a backup
  recording device. Lock exposure/focus if the device permits it.
- Confirm the web deployment contains the current Vision Scouting routes.
- On the runner host, run `python3 vision/runner/preflight.py`. Every line must
  pass. This command is read-only and never prints either token.
- Process one real, full-match recording end to end. A synthetic test or a
  placeholder `.pt` file does not count.
- Verify one run reaches `complete`, its evidence videos seek correctly, all
  six robot identities can be assigned, and a release preview contains the
  expected rows without writing them.
- Decide and configure recording retention. Leave it disabled if there is no
  reviewed deletion policy; copy recordings off Supabase during the event
  instead of assuming the bucket is an archive.

## Capture and storage

Use one fixed, elevated full-field view as the minimum. More views help with
occlusion only when they are synchronized and calibrated. Record the entire
match with at least five seconds before field start and five seconds after the
end. Never move a camera after calibration without creating a new calibration.

Name local files `<event>_<match>_<camera>_<take>.<ext>`, for example
`2026cc_qm14_fullfield_a.mov`. Keep the original local files until the event is
over and the derived results have been reviewed.

At 8–12 Mbit/s, one 150-second 1080p view is about 150–225 MB:

`bitrate × seconds ÷ 8 = 8–12 Mb/s × 150 s ÷ 8 = 150–225 MB`

Three views are about 450–675 MB per match; 100 matches are about 45–67.5 GB.
The upload picker shows the actual selected-file total. Check real remaining
bucket capacity before each session rather than trusting this estimate.

## Per-match procedure

1. Create the match using the exact TBA match key and refresh the six-team
   roster.
2. Upload every recording. Verify playback, labels, camera positions, and sync
   offsets before deleting anything from a capture device.
3. For each view, draw the field mask, goal zones, starting zones, and
   homography. A missing goal zone makes fuel attribution incomplete; a missing
   homography leaves mobility in pixel coordinates.
4. Open **Run readiness**. Resolve every red blocker. Yellow warnings require
   an explicit shadow-run acknowledgement and must be written into the shift
   log.
5. Queue one pinned model version. Never relabel weights while jobs are in the
   queue.
6. Watch the event dashboard. Cancel a wedged run and retry it as a new run;
   do not overwrite the failed attempt.
7. Resolve all six robot identities. Review observations in priority order.
   Use `J`/`K` to move and `A`/`R`/`U` to accept, reject, or mark evidence
   unobservable.
8. Compare the reviewed vision result with the manual report in **Match
   Scouting → My reports → Compare**. Record systematic disagreement by metric,
   camera, and model version.
9. Keep the result in shadow mode. If release is authorized after acceptance,
   select **Preview release**, inspect every exact row, then use the separately
   permissioned release action.

## Stop conditions and fallback

Stop queueing new runs when the runner has no current heartbeat, the queue is
growing faster than it clears, camera calibration moved, uploads cannot be
verified, or the model version is unknown. Continue manual scouting and retain
the recordings for later analysis. Vision downtime must never interrupt the
manual scouting rotation.

If output is wrong, preserve the run, model version, original recording, and
review decisions. Do not tune thresholds during a qualification session and
then mix before/after results under one model version.

## Event acceptance report

For each pinned model version, report held-out per-class precision/recall,
identity switches, calibrated trajectory error, alliance fuel absolute error,
climb confusion matrix, Qwen hallucination rate/timestamp error, and
multi-camera agreement. Review every critical TBA discrepancy. Until those
measurements exist, the honest status is “data collection and shadow
evaluation,” not production scouting.

Event information: <https://www.chiefdelphi.com/t/chezy-champs-2026/521336>
