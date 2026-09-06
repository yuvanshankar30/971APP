# Fusion CAM

The Fusion-360-backed milling pipeline is a second, separate CAM path alongside `autocam/`'s existing pure-JS turning/routing generator (`turning.js`/`routing.js`/`stepProfile.js`). That system deliberately has no external dependency and stays exactly as-is; this one exists specifically because real 3-axis milling (contoured 3D surfaces) needs a real CAM engine, which pure JS geometry math can't reach - see `autocam/docs/millimplementations.md`'s "Option C."

## Structure

- **`runner/`** - the Fusion Python add-in: template application, toolpath generation, G-code export, and polling of this app's `/api/fusion-runner` endpoints. It runs locally in Fusion 360; follow [`runner/docs/team-setup-guide.md`](runner/docs/team-setup-guide.md) to install and configure it.
- **The working web feature** is native SvelteKit/Supabase code under `src/routes/autocam/fusion/` and `src/lib/fusionCam.js`. It reuses the existing `cam_jobs`/`cam_machines`/`cam_tools`/`cam_materials` tables along with the Fusion-specific tables documented in the repository README.
