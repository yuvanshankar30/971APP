# Purchasing Receiving Checkoff (photo-based, no barcode)

## Revision note

Superseded the original barcode/QR design (issue #243's opening body,
the version of this file previously named
`purchasing-barcode-checkoff.md`) on direct instruction: **no barcodes**.
Take a picture of the part or its packaging instead; a model reads it
and identifies the purchasing item, then the purchaser confirms and it
gets marked off.

Most of what follows is unchanged from that original design - it is
still Purchasing-only, still one atomic server-side write, still an
explicit in-app confirmation (never `window.confirm`), still an audit
table, still a feature-flagged rollout. What changed is the front end of
the pipeline: a QR payload decoded client-side, exact-matched against a
canonical URL, becomes a **photo sent to a vision model**, fuzzy-matched
against purchasing rows. That is a materially different trust and privacy
shape (see Security and Privacy below), not just a swapped input widget.

This is a design only. It does not add a model call, a database
migration, or UI code.

## Goal

Let a purchaser photograph a received part or its packaging and have the
app identify which open purchasing item it is, so they can check it off
without typing, searching, or scanning anything. The workflow is for
receiving and putting away real parts, not for ordering them.

## What gets photographed, and why that choice matters

Not the bare part itself as the primary target. Most COTS hardware -
fasteners, bearings, standard electronics - looks like hundreds of other
things in a photo; asking a model to visually identify "which specific
purchasing row is this" from the part alone is a much harder and less
reliable problem than reading text.

The primary target is **whatever printed text came with it**: the
shipping label, the packing slip, the vendor's own box/bag printing, or
a printed invoice. Real product packaging usually carries the vendor
name and a product title or description close to what is already stored
in `purchasing.name` and the vendor `url` - the same thing the original
barcode design already leaned on (a canonical, comparable string), just
recovered from a photo instead of decoded from a QR payload.

The part itself is still a fallback for genuinely unlabeled hardware
(see Confidence and Fallback below), just not the primary path.

## Current Data and Boundaries

(Unchanged from the original design.)

- Purchasing items already live in `public.purchasing` and have a `url`,
  `status`, name, project information, and quantity.
- `/cad/purchasing` is the purchasing workspace. Its existing status
  update path remains the only way this feature changes an item's
  lifecycle state.
- `activity_log` records state changes already. The checkoff action must
  include scan-specific context in the resulting activity entry or in a
  companion audit record.
- This feature belongs only in Purchasing. It does not alter CAD,
  inventory, manufacturing, or AutoCAM workflows - and does not reuse
  this app's existing vision infrastructure (`vision/qwen/`), which is
  dedicated, self-hosted GPU infrastructure for match-video scouting
  analysis, not a general-purpose service. Coupling an everyday
  receiving-desk feature to that box's uptime and physical location
  would be the wrong dependency in both directions.

## Identification: how a photo becomes a match

### Step 1 - extract structured text from the photo

Send the photo to a vision-capable model with a constrained prompt
asking specifically for what is extractable, not a free-form
description:

```json
{ "vendorGuess": "string|null", "productName": "string|null",
  "orderNumber": "string|null", "rawText": "string" }
```

**Recommended approach: a hosted vision-capable model call, not
client-side OCR.** Real package photos are messy - skewed angle, glare,
crumpled labels, stylized box art with a part name printed over a
colorful background - and that is exactly the case where a vision model
reading the image holistically outperforms classic OCR (e.g.
Tesseract.js run in-browser), which does fine on flat, high-contrast
scanned text but degrades badly on real photos of real packaging. A
model call also does extraction and light interpretation in one step
("this is a McMaster-Carr box, the visible text says X") instead of
raw OCR text needing a second parsing pass.

The real cost here is genuinely small: this team's receiving volume is
occasional package unboxing, not a high-frequency scan, so a hosted
per-call vision request stays cheap in absolute terms even at
per-request pricing.

**Which vision model** needs a real decision - `OPENAI_API_KEY` already
exists in `.env` but is not currently used anywhere in this app,
so its presence is not evidence it is meant for this; do not assume
availability from that alone. Confirm with the user which vision-capable
API this project actually wants to stand behind before implementing
against it.

The photo goes through a small server-side endpoint (see API Design) -
never a direct client-to-vision-API call, so the API key never reaches
the browser and every request goes through the same authorization/audit
path every other write in this app does.

### Step 2 - fuzzy-match extracted text against purchasing rows

Unlike the barcode design's exact canonical-URL match, this is
inherently approximate - a vision model's read of a crumpled label will
rarely come back byte-identical to a stored item name. Score candidate
purchasing rows (open/ordered status, not already received) by token
overlap between the extracted `productName`/`vendorGuess`/`rawText` and
each row's `name` and vendor `url` domain, using the same "don't use
loose substring matching that could cross-match unrelated items"
discipline the original design stated for URL matching - a scored,
tokenized comparison, not a bare substring check either.

### Confidence and fallback

- **One high-confidence match**: show the confirmation dialog (below).
- **Several plausible matches, or one only-moderate match**: list them
  ranked, same as the original design's "ambiguous scan" case - the
  purchaser picks, nothing is written until they do.
- **No usable match** (blank/unreadable photo, or genuinely no text
  extracted): fall back to the part-identification path from the photo
  itself as a secondary attempt, and if that also comes back with
  nothing usable, drop to manual item search - the same
  no-match behavior the original design already specified. No write
  happens on an unmatched photo.

## User Flow

1. In the Purchasing toolbar, the purchaser opens `Check off by photo`.
2. The app asks for camera permission only once that control is opened.
   No camera access before that. If permission is denied or the device
   has no camera, the dialog accepts an uploaded image file instead.
3. The purchaser takes (or uploads) one photo. It is sent to the
   identification endpoint.
4. A successful single high-confidence match shows an in-app
   confirmation dialog with **the photo itself alongside the matched
   item's name, project, quantity, and current status**, plus the
   status that will be set. Showing the photo next to the match is a
   real check a human can do in a second that a QR-code flow never
   needed - use it. Must never use `window.confirm`.
5. Confirming updates the item through the normal status path, records
   the match and its confidence, closes the dialog, and refreshes the
   row in place.
6. An ambiguous result lists candidates (each with its own confidence)
   without changing any data; the purchaser picks one and confirms it
   separately.
7. An unmatched result makes no write and offers manual item search so
   receiving work can continue.

## Status Semantics

(Unchanged from the original design - still needs confirming against
the team's real status vocabulary before implementation.)

The initial scope checks off receiving, so the default transition
should be the existing received/available lifecycle state - confirm the
exact status vocabulary `/cad/purchasing` currently uses; do not
introduce a second set of status names. The confirmation dialog states
the real transition. An item already at or beyond the receiving state
shows as already checked off rather than issuing a second update.

## Database Changes

Same shape as the original design, renamed and with the match method
recorded since there is now more than one way a checkoff could
originate:

```text
purchasing_checkoff_events
  id uuid primary key
  purchasing_id bigint not null references purchasing(id) on delete cascade
  checked_off_by uuid not null references auth.users(id)
  checked_off_at timestamptz not null default now()
  method text not null                    -- 'photo' for now, leaves room for a future method
  match_confidence numeric                -- null when not applicable
  extracted_text text                     -- the model's rawText, for audit/debugging a bad match
  status_before text
  status_after text
```

The photo itself is **not stored** by default - see Security and
Privacy. Enable RLS the same way the original design specified:
approved users who already have permission to update the matching
purchasing item may insert an event for themselves and read events for
rows they can view; service role may manage the table for operational
support. Index on `(purchasing_id, checked_off_at desc)`.

The status update and audit-event insert still happen in one
server-side RPC or transactional endpoint - a client-side pair of
independent writes can leave a row checked off without a receipt
record, or vice versa.

## API Design

Two endpoints instead of the original's one, because identification and
the write are now separable steps with a confirmation screen between
them:

**`POST /api/purchasing/identify-photo`** - accepts an uploaded image,
calls the vision model, returns extracted text plus ranked candidate
matches. Makes no database write. Rate-limit this endpoint
specifically - it is the one that costs money per call.

**`POST /api/purchasing/checkoff`**

```json
{ "purchasing_id": 42, "method": "photo", "match_confidence": 0.91,
  "extracted_text": "..." }
```

Must:

1. validate the authenticated user and purchasing-update permission;
2. load the target row and verify it is not already checked off
   (idempotent no-op if it is);
3. execute the approved status transition and audit insert atomically;
4. return the updated row and the audit event.

The identify step is advisory; the checkoff endpoint does not re-verify
a photo-to-item match server-side beyond confirming the row still
exists and is eligible - the human confirmation in step 4 of the user
flow is what stands in for the barcode design's server-side canonical
URL re-check, since there is no equivalent deterministic re-check
available for a fuzzy photo match.

## UI Design

Mostly unchanged from the original design:

- Put the primary `Check off by photo` command in the page action bar,
  not on every table row.
- Use an in-app modal: camera capture (or file upload as fallback), a
  brief "identifying..." state while the request is in flight, then
  either the confirmation screen (photo + matched item, per the user
  flow above) or the candidate list, or the unmatched state.
- Usable at phone width without horizontal scrolling - this is
  overwhelmingly a phone-camera workflow.
- Show the most recent checkoff time and who did it in the item detail
  or a compact activity affordance, not as another wide table column.

## Security and Privacy

This section changed the most from the original design - a photo
leaving the browser is a materially different exposure than a QR
payload that never left it.

- The photo goes to this app's own server first, never directly from
  the browser to a third-party vision API - the API key stays
  server-side, and every request is authenticated the same way any
  other write in this app is.
- **Do not persist the uploaded photo by default.** It is needed only
  for the single identification call and for display during the
  confirmation step in that same session; store the extracted text and
  match result in the audit table, not the image itself. If the team
  later wants photos retained for dispute resolution, that is a
  deliberate, separate decision with its own retention policy - do not
  default into storing photos of team members' work area or whatever
  else happens to be in frame.
- State plainly in the capture UI that the photo is sent to an external
  model for identification, before the camera opens.
- Camera access itself stays entirely within standard browser
  permission prompts; no background capture.
- Require the explicit confirmation dialog before any status write,
  even for a high-confidence match - a fuzzy match is exactly the case
  where a human glance at "does this photo match this item" earns its
  keep.

## Test Plan

- Unit-test the fuzzy-matching scorer: exact name match, partial token
  overlap, vendor-domain-only match, no match, and a case designed to
  produce two plausible candidates.
- Endpoint tests: unauthorized, already-checked-off idempotency,
  successful atomic checkoff, and audit event creation with the right
  `method`/`match_confidence`/`extracted_text`.
- Identification endpoint: a mocked vision-model response feeding the
  matcher, so match-quality tests do not depend on a live model call in
  CI.
- UI tests: camera-unsupported fallback (file upload), the
  "identifying..." state, confirmation content (photo actually shown),
  ambiguous-result selection, and the unmatched state.
- Manual test with a real phone camera against a handful of real
  recently-received packages, not only synthetic photos.

## Rollout

1. Land the database migration and both endpoints behind a
   `purchasing_photo_checkoff` feature flag.
2. Pick and confirm the vision API to call (see the open model
   question) before writing the identification endpoint against one.
3. Test against a reserved, non-production purchase item with a real
   phone photo of a real package.
4. Enable for purchasing leads first.
5. Monitor unmatched/low-confidence results and mismatched confirmations
   before enabling for all approved purchasers.

## Open Questions

- **Which vision-capable API** does this project want to call, and is
  it already available/approved for use, or does standing it up need
  its own separate authorization step first (see the `OPENAI_API_KEY`
  caveat above)?
- Which current purchasing status exactly represents "received and
  checked off" in the team's real workflow? (carried over, still
  unanswered)
- Should a checkoff also create or update a COTS stock item when the
  purchase is for inventory rather than a build? (carried over)
- What confidence threshold separates "confirm automatically offered"
  from "show as a ranked candidate list"? Needs tuning against real
  photos, not a number picked in the abstract.
- Is a part-photo fallback (identifying the physical part itself, not
  its packaging/label) worth building in the first version, or should
  an unreadable label just go straight to manual search initially?
