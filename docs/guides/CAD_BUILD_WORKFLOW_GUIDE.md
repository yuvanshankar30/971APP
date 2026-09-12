# CAD / Build Workflow Guide

## Overview

The CAD tab manages robot subsystems and their builds. A **subsystem** (Drivetrain, Intake, Hopper, etc.) can be linked to an OnShape document, has a lead (and optionally co-leads) and members, and can have **one or more builds** - a build is a specific version of that subsystem's BOM (Bill of Materials) being manufactured, purchased, and assembled.

This guide covers the whole path: subsystem setup, creating a build, reviewing its BOM, promoting parts to manufacturing/purchasing/kitting, and tracking a build to completion.

## 1. Setting Up a Subsystem

From `/cad`, a lead creates a subsystem and (optionally) links it to an OnShape document via its URL. Once linked, the subsystem card shows a link to the OnShape document and a timeline of versions.

- **Lead vs Co-Lead:** every subsystem has one primary lead, but the lead can promote any member to **co-lead** from the "Manage Members" modal. Co-leads have the same permissions as the primary lead (creating builds, promoting members, transferring leadership).
- **Transfer Leadership:** a lead can hand off the primary lead role to another member. This is permanent and cannot be undone from the app - pick carefully.
- If OnShape is unreachable ("Failed to load timeline from OnShape"), the OnShape API may be down. You can still create a build manually (see below) without a live OnShape connection.

## 2. Creating a Build

A build can be created two ways:

### From an OnShape version
Pick a version from the subsystem's timeline and click to create a build from it. The app fetches that version's BOM live from OnShape.

### Manually, from a CSV (when OnShape is down or a subsystem isn't linked)
Click **Create Manual Build**, name it (e.g. "V1"), and upload a BOM CSV export. The importer accepts OnShape's own BOM table export as-is, or any spreadsheet with a Name column plus optional Part Number / Quantity / Material / Vendor / Description / **Thickness** columns.

- The optional **Thickness** column (a decimal like `0.0625` or a fraction like `1/16`, with or without a trailing `"`/`in`) lets the router-stock auto-selector match sheet stock by real thickness even without full 3D geometry. Without it, router parts are left with no stock pre-selected rather than guessing.
- Every subsystem can have **more than one build** - creating a build from a new OnShape version, or importing a new manual CSV, always creates its own separate build rather than merging into an existing one. Re-saving to the *same* version stays idempotent (it reuses that build).

## 3. Reviewing the BOM (Build BOM modal)

Whichever way you created the build, you land in the **Build BOM** review modal. This is a one-time review step before anything is saved to the build:

- **Type** (Manufactured / COTS) and **Workflow** (Router, Mill, Lathe, 3D Print, Laser Cut / Purchase, Kit) are an automatic best-guess preset based on the part's name and material - not a verified answer. Always double-check each row, especially anything the guess got wrong, and add any parts the import missed before saving.
- **COTS workflow: Purchase vs Kit.** COTS parts default to **Kit** (already in the lab's stock, no purchase needed) for fasteners, SDS-branded parts, motors, gears, roboRIO/Pigeon/CANivore/breakers/batteries/PDP/PDH, PCBs, and springs. Everything else COTS defaults to **Purchase**. You can flip either one manually per row.
- **Stock Assignment** lets you pick from the workflow's real stock list, or type a custom value under "Other...".
- **STEP/PDF attachment** (router, 3D-print, lathe rows): optionally attach a file right here before saving - lathe additionally accepts a PDF drawing instead of/alongside a STEP file.
- Click **Save** to save every row into the build. This step *only* saves rows into the build's BOM - it does **not** create any manufacturing or purchasing request yet. That's a separate, deliberate step (see below), so you can review the whole BOM before anything shows up in someone else's queue.

## 4. The Build Detail Page

Open a build (from the subsystem page, the Build Center, or "Open Build") to see two tables:

### Build Components (Added Parts)
Parts that have been promoted to a real manufacturing/purchasing/kitting record. Shows live status (Pending / In Progress / Ordered / Complete / Kitted), a **View in Manufacturing** / **View in Purchasing** link (kit items just show a "Kitted" badge - kitting has nothing further to track), and file actions (View CAD / Install STEP / Change STEP / Remove STEP, plus the same set for a PDF on lathe parts).

**Unadd:** if a part was added by mistake, "Unadd" moves it back to the unadded list (with a confirmation) - it cancels the manufacturing/purchasing/kitting request but keeps the part in the build's BOM so it can be re-added.

### Full BOM (Unadded Parts)
Parts saved to the build but not yet requested. The Action button is type-specific: **Add to Manufacturing**, **Add to Purchasing**, or **Mark as Kitted** (for kit-workflow COTS items - no purchasing request is created, it's just recorded as already stocked). **Remove** permanently deletes an unadded row from the BOM (with confirmation) - use this instead of Unadd when a part genuinely shouldn't be in the build at all.

Both tables let you attach/change/remove a STEP or PDF file per row, same as the review modal. A file attached here (or during the initial review) automatically carries over into the manufacturing request when that part is later added - you don't need to re-attach it.

## 5. Tracking and Finishing a Build

- The **Parts** progress bars (Manufacturing / Purchasing / Kitting) show completion at a glance.
- **Mark as Assembled** is available any time a build isn't already assembled - a lead can call the build done manually, independent of how complete the tracked progress looks (useful when some tracking is incomplete but the physical build is actually finished).
- **Notes**: a free-text field on the build detail page for context, blockers, or status that doesn't fit anywhere else.
- **Build Quantity**: changing it rescales every associated BOM row, part, purchasing, and kitting quantity proportionally.
- **Change Version**: re-fetches the BOM from a different OnShape version. Already-added parts are always preserved. Unadded rows are replaced with fresh data from the new version, but if an unadded row had a manually-attached file or a custom-typed stock and a matching part (by name or part number) exists in the new version, that file/stock is carried over rather than discarded.

## 6. Files

- **BOM Files** (shortcut on `/cad`, next to "Create Subsystem") opens a dedicated folder in the shared Files browser for CAD-related documents (drawings, exports, reference material) - separate from individual part STEP/PDF attachments.
- The Files browser is also reachable directly from the CAD folder in the header nav (same page as Manufacturing's Files entry).

## Troubleshooting

- **"Failed to load timeline from OnShape"**: try refreshing the page first. If it still fails, the OnShape API itself may be down or unreachable - manual CSV build creation still works in the meantime.
- **A part's stock shows "Select Stock" with no pre-selection**: this means there wasn't enough real dimensional data (bounding box or, for a manual CSV, a Thickness column) to make a confident match - pick the correct stock manually rather than trusting a guess.
- **A COTS item you expected to need a purchase order shows as "Kitted" instead**: the classifier defaults certain categories (fasteners, motors, electrical components, etc.) to Kit. Change its Workflow dropdown to Purchase in the BOM review modal or the Full BOM table if it actually needs to be bought.
