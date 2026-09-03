# Purchasing Barcode Checkoff

## Goal

Let a purchaser scan a code associated with a purchasing item's vendor link
to find that item immediately and check it off in the Purchasing tab. The
workflow is for receiving and putting away real parts, not for ordering them.
It must work from a phone camera as well as a handheld scanner that types into
an input.

This is an implementation design only. It does not add a scanner, a database
migration, or UI code.

## Product Decision

Use a QR code containing the canonical vendor URL, rather than attempting to
fit an arbitrary URL into a 1D barcode. Vendor links are frequently too long
for reliable 1D encoding, while camera scanners and modern handheld readers
support QR codes. The UI may call the control "Scan barcode" for familiarity,
but the generated label should visibly identify it as a QR code.

The link remains the source of truth. The app should not scrape or invent a
manufacturer UPC, SKU, or vendor-specific barcode from a product page.

## Current Data and Boundaries

- Purchasing items already live in `public.purchasing` and have a `url`,
  `status`, name, project information, and quantity.
- `/cad/purchasing` is the purchasing workspace. Its existing status update
  path remains the only way this feature changes an item's lifecycle state.
- `activity_log` records state changes already. The scan action must include
  scan-specific context in the resulting activity entry or in a companion
  audit record.
- This feature belongs only in Purchasing. It does not alter CAD, inventory,
  manufacturing, or AutoCAM workflows.

## User Flow

1. On a purchasing row with a vendor link, a purchaser opens a compact
   `Label` action. It shows a printable QR code, the item name, quantity, and
   project. The QR payload is the canonical vendor URL.
2. In the Purchasing toolbar, the purchaser opens `Scan to check off`.
3. The scanner asks for camera permission only after the purchaser opens it.
   If permission is denied or the device has no camera, the same dialog
   accepts a scanner/keyboard value and supports paste.
4. The app normalizes the scanned value and resolves it to one active
   purchasing item:
   - exact canonical URL first;
   - exact stored URL second, to preserve old rows that predate normalization;
   - otherwise no match.
5. A successful single match shows an in-app confirmation dialog with item
   name, project, quantity, current status, and the status that will be set.
   It must never use `window.confirm`.
6. Confirming updates the item through the normal status path, records who
   scanned it and when, closes the scanner, and refreshes the row in place.
7. An ambiguous scan lists matching items without changing any data. The user
   chooses one item and confirms it separately.
8. An unmatched scan makes no write. It offers a direct vendor-link search or
   a manual item search so receiving work can continue.

## Status Semantics

The initial scope checks off receiving, so the default transition should be
`ordered` or `approved` to the app's existing received/available lifecycle
state. Before implementation, confirm the exact status vocabulary currently
used by `/cad/purchasing`; do not introduce a second set of status names.

The confirmation dialog must state the real transition. If an item is already
at or beyond the receiving state, show it as already checked off and do not
issue another status update. A later phase can add a picker for "received" vs
"put away," but that is intentionally outside the first release.

## Canonical Link Matching

Add a small, pure JavaScript helper dedicated to this feature, for example
`src/lib/purchasingBarcode.js`. It should:

- trim whitespace;
- add `https://` to a bare vendor host;
- lowercase the scheme and host;
- remove a trailing slash when it does not change the path;
- remove known marketing/tracking query parameters only when the vendor rule
  explicitly permits it;
- preserve product-identifying path and query values;
- return `null` for non-HTTP(S) input.

Do not use loose substring matching. A scan must not mark an item received
because two vendor pages happen to share a product family name or query token.
Keep vendor-specific normalization rules in a data map with tests, not in
conditional UI code. Start with generic URL normalization and add a vendor
rule only after a real collision or documented vendor URL pattern requires it.

## Database Changes

Add a small receipt audit table rather than overloading `purchasing` with a
mutable history field:

```text
purchasing_scan_events
  id uuid primary key
  purchasing_id bigint not null references purchasing(id) on delete cascade
  scanned_by uuid not null references auth.users(id)
  scanned_at timestamptz not null default now()
  scanned_value text not null
  canonical_url text
  status_before text
  status_after text
```

Enable RLS. Approved users who already have permission to update the matching
purchasing item may insert an event for themselves and read events for rows
they are allowed to view. Service role may manage the table for operational
support. Add an index on `(purchasing_id, scanned_at desc)`.

The status update and audit-event insert must happen in one server-side RPC or
transactional endpoint. A client-side pair of independent writes can leave a
row checked off without a receipt record, or vice versa.

## API Design

Create one authenticated endpoint, for example
`POST /api/purchasing/scan-checkoff`:

```json
{ "scanned_value": "https://vendor.example/product/123", "purchasing_id": 42 }
```

The initial scan lookup can remain client-side only if it reads data the user
already sees, but the checkoff write must be server-side. The endpoint must:

1. validate the authenticated user and purchasing-update permission;
2. normalize the scanned value with the shared helper;
3. load and verify the target row still matches that URL;
4. reject an already-complete row as an idempotent no-op response;
5. execute the approved status transition and audit insert atomically;
6. return the updated row and receipt event.

Never trust a `purchasing_id` alone as proof that a scan matched the item.
The endpoint compares it to the canonical scanned URL before writing.

## UI Design

- Keep the purchasing table compact. Add icon-only `Label` and `Scan` actions
  with tooltips instead of wide row buttons.
- Put the primary `Scan to check off` command in the page action bar, not on
  every table row.
- Use an in-app modal with a clear camera viewport, a text fallback, and a
  concise result state. It should be usable at phone width without horizontal
  scrolling.
- Pause scanning after the first valid decode, so one handheld scan cannot
  create repeated attempts.
- Use the existing in-app confirmation dialog. The confirmation should include
  the item and project, not raw vendor URL alone.
- Show the most recent scan time and scout/purchaser name in the item detail
  or a compact activity affordance, not as another wide table column.
- Generate labels on demand. Do not persist a QR image in Storage because the
  payload is reproducible from the URL and stale images are misleading.

## Security and Privacy

- Camera access stays entirely in the browser; no camera frames are uploaded.
- Store only the decoded value needed for an audit trail, capped to a sensible
  length. Do not log image data.
- Barcode scans and manually pasted values use the same normalization and
  authorization path.
- Treat QR text as untrusted input. Never navigate to it or render it as HTML
  during scanning.
- Require an explicit confirmation before changing status, even for trusted
  vendor URLs.

## Test Plan

- Unit-test URL normalization for bare domains, case differences, trailing
  slashes, safe tracking-parameter removal, invalid values, and vendor rules.
- Unit-test resolution for no match, one match, and duplicate URLs.
- Endpoint tests: unauthorized, URL/item mismatch, successful atomic checkoff,
  already-complete idempotency, and audit event creation.
- UI tests: camera unsupported fallback, scanner input, first-decode pause,
  confirmation content, ambiguous result selection, and unmatched result.
- Manual mobile test with a printed or second-device QR label, plus a USB or
  Bluetooth scanner that sends keystrokes.
- Verify one successful checkoff produces both the existing purchasing
  activity and a receipt-specific audit event without duplicate Slack or
  purchasing notifications.

## Rollout

1. Land the database migration and endpoint behind a `purchasing_scan_checkoff`
   feature flag.
2. Test against a reserved, non-production purchase item and a real vendor
   URL, then test a physical scanner in the shop.
3. Enable the scan action for purchasing leads first.
4. Monitor unmatched scans and duplicate canonical URLs before enabling it for
   all approved purchasers.
5. Add vendor-specific canonicalization only from observed, reviewed cases.

## Open Questions

- Which current purchasing status exactly represents "received and checked
  off" in the team's real workflow?
- Should a checkoff also create or update a COTS stock item when the purchase
  is for inventory rather than a build?
- Are labels printed per purchase row, per individual quantity, or per box?
- Which phone/browser combination will be the supported camera baseline?
- Should a manually typed vendor SKU be supported later, separately from URL
  QR codes?
