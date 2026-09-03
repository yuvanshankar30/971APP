# Scouting Autonomous Path Drive Export

## Goal

Give coaches a shared, visual library of named autonomous routes without
asking scouts to take screenshots or upload files by hand. A successful
"Save as new file" in Match Scouting remains the system of record in
Supabase and, when enabled, also places a rendered field-map image in one
Google Drive folder.

## Behavior

`POST /api/matchscout` saves the normalized route first. It then renders the
same alliance-relative field geometry, route, and start/end points into a
self-contained SVG image and uploads it to Drive. SVG is a standard image
format that Drive previews directly and stays sharp when a route is enlarged.
The generated filename includes the event, team, route name, and save time.

Drive export is intentionally best-effort. A Drive outage or bad folder
configuration never discards the saved scouting path. The Match Scouting UI
confirms a successful export or notes that the saved route could not be
exported.

## Configuration

1. Create or choose the shared Google Drive folder that should hold route
   images.
2. Share that folder as **Editor** with the service-account email from
   `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY`.
3. Set `SCOUTING_AUTO_PATHS_DRIVE_FOLDER_ID` to the folder ID (the portion
   after `/folders/` in its Google Drive URL) in the deployment environment.
4. Keep `GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` configured as the service-account
   JSON already used by other Drive-backed app features.

With either value absent, normal path saving continues and no Drive request
is attempted. This makes the integration safe to deploy before the team has
picked its production folder.

## Code Map

- `src/lib/autoPathImage.js`: deterministic SVG route-image rendering and
  Drive-safe filename generation.
- `src/lib/server/google_drive.js`: reusable multipart Drive upload helper.
- `src/lib/server/auto_path_drive_export.js`: configuration boundary,
  service-account authentication, and best-effort export result.
- `src/routes/api/matchscout/+server.js`: invokes the export only after the
  database write succeeds.
