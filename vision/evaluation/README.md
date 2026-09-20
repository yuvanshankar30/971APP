# Vision acceptance evaluation

`evaluate_tracking.py` provides the private held-out current-vs-candidate
detector/tracker comparison:

```bash
python evaluate_tracking.py --manifest heldout.json --current current.json \
  --candidate candidate.json --output-dir reports/tracking
```

It writes JSON and HTML covering detector recall, duplicate detections, track
fragmentation, ID switches, alliance-color correctness and unknowns, plus
recall slices for challenge tags such as occlusion, blur, crowding, replay
overlays, and lighting changes. Private footage stays outside the repository.

`evaluate_qwen.py` compares a reviewed Qwen export with human ground truth.
It clusters the same event across camera views before scoring, then reports
per-event precision/recall, hallucination rate, timestamp MAE, box IoU, fuel
absolute error, climb confusion, and multi-camera agreement.

```bash
python3 evaluate_qwen.py \
  --truth reviewed-ground-truth.json \
  --predictions qwen-predictions.json \
  --output acceptance.json \
  --fail-on-thresholds
```

Both inputs may be `{ "events": [...] }`, a direct event array, or the clip
manifest emitted by `vision/training/bootstrap_annotate.py`. Event rows need
`match_key`, `view_name`, `type`, `timestamp_ms`, `alliance`, and optionally a
normalized `box`/`box_0_1000`.

Default thresholds are starting policy, not evidence that the system is
accurate: hallucination rate ≤10%, timestamp MAE ≤750 ms, and mean alliance
fuel absolute error ≤3. Change them only through a reviewed acceptance
decision and retain the emitted report with the pinned model revision.
