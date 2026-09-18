<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount, tick } from 'svelte';
  import { Camera, ChevronRight, Eye, RefreshCw, Upload, Video, LayoutDashboard, UploadCloud } from 'lucide-svelte';
  import { getAuthHeader, supabase } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { userStore } from '$lib/stores/auth.js';
  import { hasPermission } from '$lib/permissions.js';
  import { evaluateVisionReadiness, formatBytes } from '$lib/visionReadiness.js';
  import VisionCalibrator from '$lib/components/VisionCalibrator.svelte';
  import VisionHeatmap from '$lib/components/VisionHeatmap.svelte';

  let user = null;
  userStore.subscribe((v) => { user = v; });
  $: canRelease = hasPermission(user, 'VISION_RELEASE');

  let matches = [];
  let selectedId = '';
  let selectedRunId = '';
  let detail = null;
  let loading = true;
  let error = '';
  let eventKey = '';
  let matchKey = '';
  let captureNotes = '';
  let cameraLabel = 'Full field';
  let cameraPosition = 'Elevated fixed tripod';
  let syncOffsetMs = 0;
  let homographyText = '';
  let fieldMaskText = '';
  let goalZonesText = '';
  let files = [];
  let modelName = 'frc-vision-hybrid';
  let modelVersion = 'qwen3.8-27b-bf16+yolo-v1';
  let qwenModel = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
  let qwenRevision = '9c4b90e1e4ba969fd3b5378b57d966d725f1b86c';
  // Must match VALID_CLIMB_POS in api/vision - anything else is refused at
  // release rather than corrupting power-ranking aggregation.
  const CLIMB_LEVELS = ['L1', 'L2', 'L3', 'Failed', 'N/A'];
  let defaultClimbLevel = 'L1';
  let confidenceFloor = 0.35;
  let hsvLowerText = '20,100,100';
  let hsvUpperText = '35,255,255';
  let minPieceArea = 40;
  let minCircularity = 0.55;
  let busy = false;
  let reviewNotes = {};
  let trackTeamDraft = {};
  let observationTeamDraft = {};
  let observationValueDraft = {};
  let viewPlayers = {};
  let runners = [];
  let acknowledgeReadinessWarnings = false;
  let releasePreview = null;
  let focusedObservationId = '';

  // Observation timestamps are in match time (the runner already added the
  // view's sync offset), so subtract it back out to land on the right frame of
  // this particular recording.
  // Constrains identity assignment to the teams actually in this match. An
  // alliance-less track can be any of the six; with no roster cached the UI
  // falls back to free text so a missing TBA key never blocks review.
  function rosterFor(alliance) {
    const roster = detail?.match?.team_roster || {};
    if (alliance === 'red' || alliance === 'blue') return roster[alliance] || [];
    return [...(roster.red || []), ...(roster.blue || [])];
  }

  // Six robots play a match. Materially more tracks than that means the
  // tracker split one robot across an occlusion; materially fewer means it
  // lost one entirely. Either way the identities below are suspect, and it
  // costs nothing to say so before someone assigns them.
  $: expectedRobots = (detail?.match?.team_roster?.red?.length || 0) + (detail?.match?.team_roster?.blue?.length || 0);
  $: trackCountWarning = expectedRobots && detail?.tracks?.length && detail.tracks.length !== expectedRobots
    ? `${detail.tracks.length} tracks for ${expectedRobots} robots — ${detail.tracks.length > expectedRobots ? 'a robot was probably split across an occlusion' : 'a robot was probably never picked up'}.`
    : '';

  async function refreshRoster() {
    busy = true;
    error = '';
    try {
      await post({ action: 'refresh-roster', id: detail.match.id, match_key: detail.match.match_key });
      await loadDetail(selectedId);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  function calibrationSummary(view) {
    const parts = [];
    if (view.field_mask?.length) parts.push('mask');
    if (view.goal_zones?.length) parts.push(`${view.goal_zones.length} zone${view.goal_zones.length === 1 ? '' : 's'}`);
    if (view.homography) parts.push('homography');
    return parts.length ? `calibrated: ${parts.join(', ')}` : 'not calibrated';
  }

  async function saveCalibration(payload) {
    busy = true;
    error = '';
    try {
      await post(payload);
      await loadDetail(selectedId);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  function jumpToObservation(observation) {
    const view = (detail?.views || []).find((candidate) => candidate.id === observation.view_id);
    const player = viewPlayers[observation.view_id];
    if (!view || !player) return;
    player.currentTime = Math.max(0, (observation.started_ms - (view.sync_offset_ms || 0)) / 1000);
    player.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function api(path = '', options = {}) {
    const headers = { ...(await getAuthHeader()), ...(options.headers || {}) };
    const response = await fetch(`/api/vision${path}`, { ...options, headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) throw new Error(payload?.error || `Vision API failed (${response.status})`);
    return payload.data;
  }

  async function loadMatches() {
    loading = true;
    error = '';
    try {
      const [matchRows, dashboard] = await Promise.all([
        api(),
        eventKey ? api(`?dashboard=${encodeURIComponent(eventKey)}`).catch(() => null) : Promise.resolve(null)
      ]);
      matches = matchRows;
      runners = dashboard?.runners || [];
      if (selectedId) await loadDetail(selectedId);
    } catch (exception) {
      error = exception.message;
    } finally {
      loading = false;
    }
  }

  async function loadDetail(id, runId = selectedRunId) {
    selectedId = id;
    const query = new URLSearchParams({ id });
    if (runId) query.set('run_id', runId);
    detail = await api(`?${query}`);
    releasePreview = null;
    acknowledgeReadinessWarnings = false;
    selectedRunId = detail.runs?.some((run) => run.id === runId) ? runId : (detail.runs?.[0]?.id || '');
    for (const track of detail.tracks || []) trackTeamDraft[track.id] = track.team_key || '';
    for (const observation of detail.observations || []) {
      observationTeamDraft[observation.id] = observation.team_key || '';
      observationValueDraft[observation.id] = JSON.stringify(observation.value || {});
    }
  }

  async function selectRun(run) {
    busy = true;
    error = '';
    try {
      await loadDetail(selectedId, run.id);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function post(body) {
    return api('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function createMatch() {
    if (!eventKey || !matchKey) return;
    busy = true;
    try {
      const created = await post({ action: 'create-match', event_key: eventKey, match_key: matchKey, capture_notes: captureNotes });
      matchKey = '';
      captureNotes = '';
      await loadMatches();
      await loadDetail(created.id);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function uploadViews() {
    if (!selectedId || !files.length) return;
    busy = true;
    error = '';
    try {
      let homography = null;
      if (homographyText.trim()) {
        homography = JSON.parse(homographyText);
        if (!Array.isArray(homography) || homography.flat(Infinity).length !== 9) throw new Error('Homography must contain exactly nine numbers.');
      }
      // Field mask / goal zones: normalized (0-1) polygons, same shape the
      // hybrid classical-CV game-piece pipeline reads server-side (see
      // docs/guides/scoutingvision.md). A plain JSON textarea for now, matching the
      // existing homography field - a visual polygon-drawing tuner is a
      // natural future enhancement, not built here.
      let fieldMask = null;
      if (fieldMaskText.trim()) {
        fieldMask = JSON.parse(fieldMaskText);
        if (!Array.isArray(fieldMask) || fieldMask.length < 3) throw new Error('Field mask must be an array of at least 3 [x,y] points.');
      }
      let goalZones = [];
      if (goalZonesText.trim()) {
        goalZones = JSON.parse(goalZonesText);
        if (!Array.isArray(goalZones)) throw new Error('Goal zones must be an array of {label, alliance, polygon}.');
      }
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const result = await post({
          action: 'add-view', vision_match_id: selectedId,
          label: files.length > 1 ? `${cameraLabel} ${index + 1}` : cameraLabel,
          camera_position: cameraPosition, file_name: file.name,
          sync_offset_ms: Number(syncOffsetMs) || 0, homography,
          field_mask: fieldMask, goal_zones: goalZones
        });
        const { error: uploadError } = await supabase.storage.from('vision-recordings').uploadToSignedUrl(result.upload.path, result.upload.token, file, { contentType: file.type || 'video/quicktime' });
        if (uploadError) throw uploadError;
      }
      files = [];
      await loadDetail(selectedId);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  function parseHsv(text, fallback) {
    const parts = text.split(',').map((part) => Number(part.trim()));
    return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
  }

  async function queueRun() {
    busy = true;
    try {
      await post({
        action: 'queue-run', vision_match_id: selectedId, model_name: modelName, model_version: modelVersion,
        qwen_model: qwenModel, qwen_revision: qwenRevision,
        acknowledge_readiness_warnings: acknowledgeReadinessWarnings,
        config: {
          confidence_floor: Number(confidenceFloor),
          // Hybrid classical-CV game-piece detection tuning (see
          // docs/guides/scoutingvision.md) - HSV threshold range for the game piece
          // color, plus contour area/circularity filters. Defaults on the
          // runner side if left blank; per-venue lighting is exactly why
          // this is tunable per run rather than hardcoded.
          hsv_lower: parseHsv(hsvLowerText, undefined),
          hsv_upper: parseHsv(hsvUpperText, undefined),
          min_piece_area: Number(minPieceArea) || undefined,
          min_circularity: Number(minCircularity) || undefined,
          // Detected climbs carry no level of their own unless Qwen reads one
          // off the video. Without a fallback the value defaults to the
          // literal 'success', which isn't a real climb_pos, so release-run
          // drops every climb. This is what makes them releasable.
          default_climb_level: defaultClimbLevel || undefined
        }
      });
      await loadMatches();
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function cancelRun(run) {
    if (!await requestConfirmation({ title: 'Cancel vision run', message: `Cancel ${run.model_name} ${run.model_version}? A runner already working on it will fail the job when it finishes.`, confirmLabel: 'Cancel run', danger: true })) return;
    busy = true;
    error = '';
    try {
      await post({ action: 'cancel-run', id: run.id });
      await loadDetail(selectedId);
      await loadMatches();
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function retryRun(run) {
    busy = true;
    error = '';
    try {
      await post({ action: 'retry-run', id: run.id });
      await loadDetail(selectedId);
      await loadMatches();
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  let releasingRunId = '';
  async function previewRelease(run) {
    releasingRunId = run.id;
    error = '';
    try {
      const result = await post({ action: 'preview-release', run_id: run.id });
      releasePreview = { runId: run.id, ...result };
    } catch (exception) {
      releasePreview = null;
      error = exception.message;
    } finally {
      releasingRunId = '';
    }
  }

  async function releaseRun(run) {
    if (releasePreview?.runId !== run.id) {
      error = 'Preview the exact scouting rows before releasing this run.';
      return;
    }
    if (!await requestConfirmation({ title: 'Release scouting results', message: `Release ${run.model_name} ${run.model_version}'s results into real scouting data? This cannot be undone.`, confirmLabel: 'Release', danger: true })) return;
    releasingRunId = run.id;
    error = '';
    try {
      const result = await post({ action: 'release-run', run_id: run.id, preview_rows: releasePreview.rows });
      await loadDetail(selectedId);
      const skipped = result.skipped_climbs?.length
        ? ` ${result.skipped_climbs.length} climb(s) skipped for an unrecognized level.`
        : '';
      import('$lib/toast.js').then((m) => m.toastActions.show(`Released ${result.released_count} scout_data_events row(s).${skipped}`));
    } catch (exception) {
      error = exception.message;
    } finally {
      releasingRunId = '';
    }
  }

  async function resolveFlag(flag, status) {
    await post({ action: 'review', id: flag.id, status, review_notes: reviewNotes[flag.id] || '' });
    await loadDetail(selectedId);
  }

  async function saveTrackIdentity(track) {
    await post({ action: 'update-track', id: track.id, team_key: trackTeamDraft[track.id] });
    await loadDetail(selectedId);
  }

  let observationSource = 'all';
  let observationStatus = 'unreviewed';
  let observationAttribution = 'all';
  let observationMinConfidence = 0;
  let observationOrder = 'priority';

  function reviewPriority(observation) {
    if (!observation.team_key) return 0;
    if ((Number(observation.confidence) || 0) < 0.65) return 1;
    if (observation.source === 'qwen3_vl') return 2;
    return 3;
  }

  function applyObservationPreset(preset) {
    if (preset === 'attention') {
      observationStatus = 'unreviewed';
      observationSource = 'all';
      observationAttribution = 'all';
      observationMinConfidence = 0;
      observationOrder = 'priority';
    } else if (preset === 'unreviewed') {
      observationStatus = 'unreviewed';
      observationSource = 'all';
      observationAttribution = 'all';
      observationMinConfidence = 0;
      observationOrder = 'timeline';
    } else if (preset === 'attributed') {
      observationStatus = 'all';
      observationSource = 'all';
      observationAttribution = 'attributed';
      observationMinConfidence = 0;
      observationOrder = 'timeline';
    } else {
      observationStatus = 'all';
      observationSource = 'all';
      observationAttribution = 'all';
      observationMinConfidence = 0;
      observationOrder = 'timeline';
    }
  }

  $: visibleObservations = (detail?.observations || []).filter((observation) => {
    if (observationSource !== 'all' && (observation.source || 'legacy') !== observationSource) return false;
    if (observationStatus !== 'all' && (observation.review_status || 'unreviewed') !== observationStatus) return false;
    if (observationAttribution === 'attributed' && !observation.team_key) return false;
    if (observationAttribution === 'unattributed' && observation.team_key) return false;
    return (Number(observation.confidence) || 0) >= Number(observationMinConfidence);
  }).sort((left, right) => observationOrder === 'priority'
    ? ((left.review_status || 'unreviewed') === 'unreviewed' ? 0 : 1) - ((right.review_status || 'unreviewed') === 'unreviewed' ? 0 : 1)
      || reviewPriority(left) - reviewPriority(right) || left.started_ms - right.started_ms
    : left.started_ms - right.started_ms);
  $: bulkReviewable = visibleObservations.filter(
    (observation) => (observation.review_status || 'unreviewed') === 'unreviewed'
  );
  $: priorityReviewCount = bulkReviewable.filter((observation) => reviewPriority(observation) < 3).length;
  $: readiness = (detail?.observations || []).reduce((summary, observation) => {
    const status = observation.review_status || 'unreviewed';
    summary[status] = (summary[status] || 0) + 1;
    if (!observation.team_key) summary.unattributed += 1;
    if (['accepted', 'corrected'].includes(status) && observation.team_key) summary.eligible += 1;
    return summary;
  }, { accepted: 0, corrected: 0, rejected: 0, unobservable: 0, unreviewed: 0, unattributed: 0, eligible: 0 });
  $: selectedRun = detail?.runs?.find((run) => run.id === selectedRunId) || null;
  $: queueReadiness = evaluateVisionReadiness({ match: detail?.match, views: detail?.views || [], modelName, modelVersion, runners });
  $: selectedUploadBytes = files.reduce((total, file) => total + (file.size || 0), 0);
  $: sortedDiscrepancies = [...(detail?.discrepancies || [])].sort((left, right) => {
    const open = Number(left.status !== 'open') - Number(right.status !== 'open');
    const severity = (left.severity === 'critical' ? 0 : 1) - (right.severity === 'critical' ? 0 : 1);
    return open || severity;
  });

  async function reviewVisible(status) {
    if (!bulkReviewable.length) return;
    if (!await requestConfirmation({ title: 'Review observations', message: `Mark ${bulkReviewable.length} shown observation(s) as ${status}?`, confirmLabel: 'Confirm' })) return;
    busy = true;
    error = '';
    try {
      await post({ action: 'review-observations', ids: bulkReviewable.map((o) => o.id), status });
      await loadDetail(selectedId);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function reviewObservation(observation, status) {
    const priorIndex = visibleObservations.findIndex((candidate) => candidate.id === observation.id);
    busy = true;
    error = '';
    try {
      await post({ action: 'review-observation', id: observation.id, status });
      await loadDetail(selectedId);
      await tick();
      if (visibleObservations.length) focusObservation(Math.max(0, priorIndex));
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  async function correctObservation(observation) {
    let value;
    try { value = JSON.parse(observationValueDraft[observation.id] || '{}'); }
    catch { error = 'Corrected observation value must be valid JSON.'; return; }
    if (!value || Object.keys(value).length === 0) {
      error = 'A correction needs an event value; review the original evidence before saving it.';
      return;
    }
    busy = true;
    error = '';
    try {
      await post({
        action: 'review-observation', id: observation.id, status: 'corrected',
        team_key: observationTeamDraft[observation.id], value
      });
      await loadDetail(selectedId);
    } catch (exception) { error = exception.message; }
    finally { busy = false; }
  }

  function focusObservation(index) {
    if (!visibleObservations.length) return;
    const bounded = Math.max(0, Math.min(index, visibleObservations.length - 1));
    focusedObservationId = visibleObservations[bounded].id;
    document.getElementById(`vision-observation-${focusedObservationId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function handleReviewShortcut(event) {
    const tag = event.target?.tagName?.toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
    const current = visibleObservations.findIndex((observation) => observation.id === focusedObservationId);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      focusObservation(event.key === 'j' ? (current < 0 ? 0 : current + 1) : (current < 0 ? 0 : current - 1));
      return;
    }
    const observation = visibleObservations[current];
    const status = { a: 'accepted', r: 'rejected', u: 'unobservable' }[event.key.toLowerCase()];
    if (observation && status && !busy && (observation.review_status || 'unreviewed') === 'unreviewed') {
      event.preventDefault();
      reviewObservation(observation, status);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleReviewShortcut);
    (async () => {
      eventKey = (await fetchActiveScoutingEventKey()) || '';
      await loadMatches();
    })();
    return () => window.removeEventListener('keydown', handleReviewShortcut);
  });
</script>

<svelte:head><title>Vision Review | Scouting</title></svelte:head>

<div class="page-header">
  <div class="header-content">
    <h1><Eye size={22} /> Vision Scouting</h1>
    <p>Post-match multi-view ML processing, TBA reconciliation, and evidence-backed human review.</p>
  </div>
  <div class="actions">
    <a class="btn btn-sm" href="/scouting/vision/dashboard{eventKey ? `?event_key=${encodeURIComponent(eventKey)}` : ''}"><LayoutDashboard size={14} /> Event dashboard</a>
    <button class="btn btn-sm" on:click={loadMatches} disabled={loading}><RefreshCw size={14} /> Refresh</button>
  </div>
</div>

{#if error}<div class="error-container"><p>{error}</p></div>{/if}

<div class="vision-layout">
  <aside class="surface-card sidebar">
    <h2>Recordings</h2>
    <div class="create-form">
      <input class="form-input" placeholder="Event key" bind:value={eventKey} />
      <input class="form-input" placeholder="Match key (event_qm1)" bind:value={matchKey} />
      <textarea class="form-input" placeholder="Capture notes" bind:value={captureNotes}></textarea>
      <button class="btn btn-primary btn-sm" on:click={createMatch} disabled={busy || !eventKey || !matchKey}><Camera size={14} /> New match</button>
    </div>
    {#if loading}<p class="text-muted">Loading...</p>{/if}
    <div class="match-list">
      {#each matches as match}
        <button class:active={selectedId === match.id} on:click={() => loadDetail(match.id)}>
          <span><b>{match.match_key}</b><small>{match.status} · {match.vision_views?.[0]?.count || 0} views</small></span><ChevronRight size={14} />
        </button>
      {/each}
    </div>
  </aside>

  <main class="vision-main">
    {#if !detail}
      <div class="empty-state"><Video size={40} /><h3>Select or create a match</h3><p>Pick a match on the left, or create one to get started.</p></div>
    {:else}
      <section class="surface-card section">
        <h2>{detail.match.match_key} · Camera views</h2>
        <div class="view-list">
          {#each detail.views as view (view.id)}
            <div>
              <Video size={16} />
              <span>
                <b>{view.label}</b>
                <small>
                  {view.camera_position || 'Position not recorded'} · offset {view.sync_offset_ms}ms
                  · {calibrationSummary(view)}
                </small>
              </span>
              {#if view.signed_url}
                <video bind:this={viewPlayers[view.id]} controls muted preload="metadata" src={view.signed_url} aria-label={`${view.label} evidence recording`}></video>
              {/if}
            </div>
            {#if view.signed_url}
              <details class="calibrate-panel">
                <summary>Calibrate {view.label}</summary>
                <VisionCalibrator {view} {busy} onSave={saveCalibration} />
              </details>
            {/if}
          {/each}
        </div>
        <div class="upload-grid">
          <label>View label <input class="form-input" placeholder="Full field" bind:value={cameraLabel} /></label>
          <label>Camera position <input class="form-input" placeholder="Elevated fixed tripod" bind:value={cameraPosition} /></label>
          <label>Sync offset (ms) <input class="form-input" type="number" bind:value={syncOffsetMs} /></label>
          <label>Recording file(s) <input class="form-input" type="file" accept="video/*" multiple on:change={(event) => files = [...event.currentTarget.files]} />{#if files.length}<small>{files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(selectedUploadBytes)}</small>{/if}</label>
        </div>
        <details class="hybrid-cv-config">
          <summary>Calibration (optional)</summary>
          <div class="upload-grid">
            <label>3×3 homography JSON <input class="form-input" placeholder="[[1,0,0],[0,1,0],[0,0,1]]" bind:value={homographyText} /></label>
            <label>Field mask JSON <input class="form-input" placeholder="[[x,y], ...] normalized 0-1" bind:value={fieldMaskText} title="Region of interest excluding audience/background - see docs/guides/scoutingvision.md" /></label>
            <label>Goal zones JSON <input class="form-input" placeholder='[{"label","alliance","polygon"}]' bind:value={goalZonesText} title="Where a scored game piece's trajectory ends - required for automatic fuel attribution" /></label>
          </div>
        </details>
        <button class="btn btn-sm upload-button" on:click={uploadViews} disabled={busy || !files.length}><Upload size={14} /> Upload {files.length || ''} view{files.length === 1 ? '' : 's'}</button>
      </section>

      <section class="surface-card section">
        <h2>ML processing</h2>
        <div class="run-controls">
          <label>Model name <input class="form-input" bind:value={modelName} /></label>
          <label>Version <input class="form-input" bind:value={modelVersion} /></label>
          <label>Qwen model <input class="form-input" bind:value={qwenModel} /></label>
          <label>Qwen revision <input class="form-input" bind:value={qwenRevision} /></label>
          <label>Confidence <input class="form-input" type="number" min="0" max="1" step="0.05" bind:value={confidenceFloor} /></label>
          <label>Default climb level
            <select class="form-input" bind:value={defaultClimbLevel}>
              {#each CLIMB_LEVELS as level}<option value={level}>{level}</option>{/each}
            </select>
          </label>
          <button class="btn btn-primary btn-sm" on:click={queueRun} disabled={busy || queueReadiness.blocking.length || (queueReadiness.warnings.length && !acknowledgeReadinessWarnings)}>Queue shadow run</button>
        </div>
        <div class="queue-readiness">
          <b>Run readiness</b>
          <ul>
            {#each queueReadiness.checks as check}
              <li class:ready={check.ready} class:blocking={!check.ready && check.level === 'blocking'}>{check.ready ? '✓' : check.level === 'blocking' ? '✕' : '⚠'} {check.label}</li>
            {/each}
          </ul>
          {#if queueReadiness.warnings.length}
            <label class="acknowledge"><input type="checkbox" bind:checked={acknowledgeReadinessWarnings} /> Queue as a shadow run with these warnings; manual scouting remains authoritative.</label>
          {/if}
        </div>
        <details class="hybrid-cv-config">
          <summary>Hybrid game-piece detection tuning (optional)</summary>
          <div class="run-controls">
            <label>HSV lower (H,S,V) <input class="form-input" bind:value={hsvLowerText} /></label>
            <label>HSV upper (H,S,V) <input class="form-input" bind:value={hsvUpperText} /></label>
            <label>Min area (px²) <input class="form-input" type="number" min="0" bind:value={minPieceArea} /></label>
            <label>Min circularity <input class="form-input" type="number" min="0" max="1" step="0.05" bind:value={minCircularity} /></label>
          </div>
        </details>
        <div class="run-list">
          {#each detail.runs as run (run.id)}
            <span class={`status ${run.status}`}>
              <span>{run.model_name} {run.model_version} · {run.status}{run.error ? ` · ${run.error}` : ''}</span>
              <span class="run-actions">
                <button class="btn btn-sm" class:active-run={selectedRunId === run.id} on:click={() => selectRun(run)} disabled={busy}>Review results</button>
              {#if run.released_at}
                <em class="released-tag">released</em>
              {:else if run.status === 'complete' && canRelease}
                <button class="btn btn-sm" on:click={() => previewRelease(run)} disabled={releasingRunId === run.id}>Preview release</button>
                <button class="btn btn-sm btn-primary" on:click={() => releaseRun(run)} disabled={releasingRunId === run.id || releasePreview?.runId !== run.id}><UploadCloud size={12} /> Release to scouting data</button>
              {:else if ['queued', 'claimed', 'processing'].includes(run.status)}
                <button class="btn btn-sm" on:click={() => cancelRun(run)} disabled={busy}>Cancel</button>
              {:else if ['failed', 'cancelled'].includes(run.status)}
                <button class="btn btn-sm" on:click={() => retryRun(run)} disabled={busy}><RefreshCw size={12} /> Retry</button>
              {/if}
              </span>
            </span>
          {/each}
        </div>
      </section>

      {#if selectedRun?.status === 'complete' && !selectedRun.released_at}
        <section class="surface-card section release-readiness">
          <div>
            <h2>Release readiness</h2>
            <p>Review state for the selected run. Only accepted or corrected, team-attributed actions can enter scouting data.</p>
          </div>
          <div class="readiness-grid">
            <span><b>{readiness.eligible}</b> eligible</span>
            <span class:needs-review={readiness.unreviewed > 0}><b>{readiness.unreviewed}</b> unreviewed</span>
            <span class:needs-review={readiness.unattributed > 0}><b>{readiness.unattributed}</b> unattributed</span>
            <span><b>{readiness.rejected + readiness.unobservable}</b> excluded</span>
          </div>
          {#if !readiness.eligible}
            <p class="readiness-warning">Nothing can be released yet. Accept or correct an observation and assign it to a team.</p>
          {/if}
        </section>
        {#if releasePreview?.runId === selectedRun.id}
          <section class="surface-card section release-preview">
            <h2>Exact release preview · {releasePreview.rows.length} row{releasePreview.rows.length === 1 ? '' : 's'}</h2>
            <p>These are the rows the atomic release will write. Previewing does not change scouting data.</p>
            <div class="table-wrap"><table><thead><tr><th>Team</th><th>Field</th><th>Value</th><th>Match</th></tr></thead><tbody>
              {#each releasePreview.rows as row}
                <tr><td data-label="Team">{row.team_key.replace(/^frc/i, '')}</td><td data-label="Field">{row.event_type.replaceAll('_', ' ')}</td><td data-label="Value">{row.event_value}</td><td data-label="Match">{row.match_key}</td></tr>
              {/each}
            </tbody></table></div>
            {#if releasePreview.skipped_climbs?.length}<p class="readiness-warning">{releasePreview.skipped_climbs.length} climb value(s) will be skipped. Correct them before release.</p>{/if}
          </section>
        {/if}
      {/if}

      {#if detail.tracks.length}
        <section class="surface-card section">
          <h2>Robot tracks & mobility</h2>
          <VisionHeatmap tracks={detail.tracks} />
          <div class="roster-bar">
            {#if expectedRobots}
              <span>Match roster: {rosterFor('red').map((k) => k.replace(/^frc/i, '')).join(', ') || '—'} vs {rosterFor('blue').map((k) => k.replace(/^frc/i, '')).join(', ') || '—'}</span>
            {:else}
              <span>No match roster cached — team identity is free text until one is fetched.</span>
            {/if}
            <button class="btn btn-sm" on:click={refreshRoster} disabled={busy}>Refresh from TBA</button>
          </div>
          {#if trackCountWarning}<p class="track-warning">{trackCountWarning}</p>{/if}
          <div class="table-wrap"><table><thead><tr><th>Team identity</th><th>Alliance</th><th>Confidence</th><th>Distance</th><th>P90 speed</th><th>Turn rate</th></tr></thead><tbody>
            {#each detail.tracks as track}<tr>
              <td data-label="Team identity">
                <div class="identity-editor">
                  {#if rosterFor(track.alliance).length}
                    <select class="form-input" bind:value={trackTeamDraft[track.id]} aria-label="Team identity">
                      <option value="">unassigned</option>
                      {#each rosterFor(track.alliance) as teamKey}
                        <option value={teamKey}>{teamKey.replace(/^frc/i, '')}</option>
                      {/each}
                    </select>
                  {:else}
                    <input class="form-input" placeholder="frc971" bind:value={trackTeamDraft[track.id]} />
                  {/if}
                  <button class="btn btn-sm" on:click={() => saveTrackIdentity(track)}>Save</button>
                </div>
              </td>
              <td data-label="Alliance">{track.alliance || '—'}</td><td data-label="Confidence">{Math.round(track.tracking_confidence * 100)}%</td>
              <td data-label="Distance">{track.metrics?.distanceMeters?.toFixed?.(1) ?? '—'} m</td><td data-label="P90 speed">{track.metrics?.p90SpeedMps?.toFixed?.(2) ?? '—'} m/s</td><td data-label="Turn rate">{track.metrics?.p90TurnRateRadS?.toFixed?.(2) ?? '—'} rad/s</td>
            </tr>{/each}
          </tbody></table></div>
        </section>
      {/if}

      {#if detail.observations.length}
        <section class="surface-card section">
          <h2>Detected actions ({visibleObservations.length} of {detail.observations.length})</h2>
          <p class="review-shortcuts">Keyboard: <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>A</kbd> accept · <kbd>R</kbd> reject · <kbd>U</kbd> unobservable</p>

          <div class="review-presets" aria-label="Observation filter presets">
            <button class="btn btn-sm" on:click={() => applyObservationPreset('attention')}>Needs attention</button>
            <button class="btn btn-sm" on:click={() => applyObservationPreset('unreviewed')}>Unreviewed</button>
            <button class="btn btn-sm" on:click={() => applyObservationPreset('attributed')}>Attributed only</button>
            <button class="btn btn-sm" on:click={() => applyObservationPreset('all')}>All results</button>
          </div>

          <div class="observation-filters">
            <label>Source
              <select class="form-input" bind:value={observationSource}>
                <option value="all">All</option>
                <option value="qwen3_vl">Qwen</option>
                <option value="yolo">YOLO</option>
                <option value="classical_cv">Classical CV</option>
              </select>
            </label>
            <label>Status
              <select class="form-input" bind:value={observationStatus}>
                <option value="unreviewed">Unreviewed</option>
                <option value="all">All</option>
                <option value="accepted">Accepted</option>
                <option value="corrected">Corrected</option>
                <option value="rejected">Rejected</option>
                <option value="unobservable">Unobservable</option>
              </select>
            </label>
            <label>Attribution
              <select class="form-input" bind:value={observationAttribution}>
                <option value="all">All</option>
                <option value="attributed">Attributed</option>
                <option value="unattributed">Unattributed</option>
              </select>
            </label>
            <label>Min confidence
              <input class="form-input" type="number" min="0" max="1" step="0.05" bind:value={observationMinConfidence} />
            </label>
            <label>Review order
              <select class="form-input" bind:value={observationOrder}>
                <option value="priority">Priority first</option>
                <option value="timeline">Match timeline</option>
              </select>
            </label>
            <div class="bulk-actions">
              <button class="btn btn-sm" on:click={() => reviewVisible('accepted')} disabled={busy || !bulkReviewable.length}>Accept {bulkReviewable.length} shown</button>
              <button class="btn btn-sm" on:click={() => reviewVisible('rejected')} disabled={busy || !bulkReviewable.length}>Reject shown</button>
            </div>
          </div>

          {#if observationOrder === 'priority' && priorityReviewCount}
            <p class="review-priority-note">{priorityReviewCount} unreviewed action{priorityReviewCount === 1 ? '' : 's'} need attention first: unattributed, low-confidence, or Qwen-proposed.</p>
          {/if}

          {#if !visibleObservations.length}
            <p class="empty-state">No observations match these filters.</p>
          {/if}

          <div class="observation-list">
            {#each visibleObservations as observation (observation.id)}
              <div id={`vision-observation-${observation.id}`} class:focused={focusedObservationId === observation.id}>
                <b>{observation.observation_type.replaceAll('_', ' ')}</b>
                <span>
                  {observation.team_key || observation.alliance || 'unattributed'} ·
                  {(observation.started_ms / 1000).toFixed(1)}s ·
                  {Math.round(observation.confidence * 100)}% ·
                  {observation.source || 'legacy'}
                </span>
                <code>{JSON.stringify(observation.value)}</code>
                <span class="observation-actions">
                  {#if viewPlayers[observation.view_id]}
                    <button class="btn btn-sm" on:click={() => jumpToObservation(observation)} title="Seek this view's recording to the moment described">Watch</button>
                  {/if}
                  <span class={`observation-review ${observation.review_status || 'unreviewed'}`}>
                    {observation.review_status || 'unreviewed'}
                  </span>
                </span>
                {#if !['accepted', 'corrected', 'rejected', 'unobservable'].includes(observation.review_status)}
                  <div class="observation-correction">
                    {#if rosterFor(observation.alliance).length}
                      <select class="form-input" bind:value={observationTeamDraft[observation.id]} aria-label="Corrected observation team">
                        <option value="">unassigned</option>
                        {#each rosterFor(observation.alliance) as teamKey}
                          <option value={teamKey}>{teamKey.replace(/^frc/i, '')}</option>
                        {/each}
                      </select>
                    {:else}
                      <input class="form-input" placeholder="frc971" bind:value={observationTeamDraft[observation.id]} />
                    {/if}
                    <input class="form-input" aria-label="Corrected observation JSON" bind:value={observationValueDraft[observation.id]} />
                    <button class="btn btn-sm" on:click={() => correctObservation(observation)} disabled={busy}>Save correction</button>
                  </div>
                  <div class="review-actions">
                    <button class="btn btn-sm" on:click={() => reviewObservation(observation, 'accepted')} disabled={busy}>Accept</button>
                    <button class="btn btn-sm" on:click={() => reviewObservation(observation, 'rejected')} disabled={busy}>Reject</button>
                    <button class="btn btn-sm" on:click={() => reviewObservation(observation, 'unobservable')} disabled={busy}>Unobservable</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if detail.qwenClips?.length}
        <section class="surface-card section"><h2>Qwen clip audit</h2><div class="qwen-clip-list">{#each detail.qwenClips as clip}<div><b>{(clip.started_ms / 1000).toFixed(1)}–{(clip.ended_ms / 1000).toFixed(1)}s</b><span>{clip.clip_quality || 'unknown quality'} · {clip.event_count} proposals · {clip.latency_ms ?? '—'} ms</span><small>{clip.model}@{clip.revision?.slice(0, 8)} · {clip.dtype}</small>{#if clip.normalized_result?.error}<p class="clip-error">Clip skipped: {clip.normalized_result.error}</p>{:else if clip.normalized_result?.review_notes}<p>{clip.normalized_result.review_notes}</p>{/if}</div>{/each}</div></section>
      {/if}

      <section class="surface-card section">
        <h2>Human review ({detail.discrepancies.filter((flag) => flag.status === 'open').length} open)</h2>
        {#if !detail.discrepancies.length}<p class="text-muted">No discrepancies generated yet.</p>{/if}
        <div class="flag-list">{#each sortedDiscrepancies as flag}<article class:resolved={flag.status !== 'open'}><header><b>{flag.metric.replaceAll('_', ' ')}</b><span class={`severity ${flag.severity}`}>{flag.severity}</span></header><p>{flag.reason}</p><div class="values"><span>Vision: <code>{JSON.stringify(flag.vision_value)}</code></span><span>TBA: <code>{JSON.stringify(flag.reference_value)}</code></span></div><textarea class="form-input" placeholder="Review notes" bind:value={reviewNotes[flag.id]} disabled={flag.status !== 'open'}></textarea>{#if flag.status === 'open'}<div class="review-actions"><button class="btn btn-sm" on:click={() => resolveFlag(flag, 'accepted_vision')}>Accept Vision</button><button class="btn btn-sm" on:click={() => resolveFlag(flag, 'accepted_reference')}>Accept TBA</button><button class="btn btn-sm" on:click={() => resolveFlag(flag, 'unobservable')}>Unobservable</button><button class="btn btn-sm" on:click={() => resolveFlag(flag, 'dismissed')}>Dismiss</button></div>{:else}<small>Resolved: {flag.status}</small>{/if}</article>{/each}</div>
      </section>
    {/if}
  </main>
</div>

<style>
  h1 { display:flex; gap:var(--gap-2); align-items:center; }
  h2 { font-size:1rem; margin:0 0 var(--space-3); }
  .vision-layout { display:grid; grid-template-columns:18rem minmax(0,1fr); gap:var(--gap-4); align-items:start; }
  .sidebar,.section { padding:var(--space-4); }
  .sidebar { position:sticky; top:var(--space-4); max-height:calc(100vh - 2 * var(--space-4)); overflow:auto; }
  .create-form,.match-list,.vision-main,.view-list,.run-list,.observation-list,.flag-list { display:grid; gap:var(--space-2); }
  .qwen-clip-list { display:grid; gap:var(--space-2); }
  .qwen-clip-list > div { display:grid; grid-template-columns:auto 1fr auto; gap:var(--gap-2); padding:var(--space-2); border-bottom:1px solid var(--border); }
  .qwen-clip-list p { grid-column:1/-1; margin:0; color:var(--text-muted); }
  .qwen-clip-list p.clip-error { color:var(--danger); }
  .match-list button { display:flex; justify-content:space-between; align-items:center; text-align:left; border:1px solid var(--border); border-radius:var(--radius-md); padding:var(--space-2); background:transparent; color:var(--text); cursor:pointer; }
  .match-list button.active { border-color:var(--brand-primary,#d9a413); background:var(--surface-2); }
  .match-list span,.view-list span { display:grid; }
  small { color:var(--text-muted); }
  .view-list > div { display:grid; grid-template-columns:auto minmax(0,1fr) minmax(14rem,18rem); align-items:center; gap:var(--gap-2); padding:var(--space-2); border-bottom:1px solid var(--border); }
  .view-list video { width:100%; max-height:10rem; background:#000; }
  .upload-grid,.run-controls { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:var(--gap-4); margin-top:var(--space-4); }
  .upload-grid label,.run-controls label { display:grid; gap:var(--space-1); font-size:.8rem; color:var(--text-muted); }
  .run-controls { align-items:end; }
  .upload-button { margin-top:var(--space-4); }
  .hybrid-cv-config { margin-top:var(--space-4); }
  .hybrid-cv-config summary { cursor:pointer; color:var(--text-muted); font-size:.85rem; padding:var(--space-1) 0; }
  .hybrid-cv-config .upload-grid,.hybrid-cv-config .run-controls { margin-top:var(--space-3); }
  .queue-readiness { margin-top:var(--space-3); padding:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-md); background:var(--surface-2); }
  .queue-readiness ul { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:var(--gap-1) var(--gap-3); margin:var(--space-2) 0; padding:0; list-style:none; }
  .queue-readiness li { color:var(--brand-gold-strong); font-size:.8rem; }
  .queue-readiness li.ready { color:var(--green-strong); }
  .queue-readiness li.blocking { color:var(--danger); }
  .acknowledge { display:flex; align-items:flex-start; gap:var(--gap-2); color:var(--text-muted); font-size:.8rem; }
  .status { padding:var(--space-2); border-radius:var(--radius-sm); background:var(--surface-2); display:flex; align-items:center; justify-content:space-between; gap:var(--gap-2); overflow-wrap:anywhere; }
  .status.failed { color:var(--red,#c33); }
  .status button { display:inline-flex; align-items:center; gap:4px; }
  .run-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:var(--gap-2); }
  .active-run { border-color:var(--brand-gold-base,#d9a413); background:var(--brand-gold-soft); }
  .released-tag { color:var(--brand-gold-base,#d9a413); font-style:normal; font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
  .table-wrap { overflow:auto; } table { width:100%; border-collapse:collapse; } th,td { padding:var(--space-2); border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }
  .identity-editor { display:flex; gap:var(--gap-1); }
  .roster-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--gap-2); margin:var(--space-4) 0 var(--space-2); color:var(--text-muted); font-size:.82rem; }
  .track-warning { margin:0 0 var(--space-2); color:var(--danger); font-size:.82rem; }
  .observation-list > div { display:grid; grid-template-columns:minmax(9rem,.75fr) minmax(11rem,1fr) minmax(0,1.5fr) auto; gap:var(--gap-2); padding:var(--space-3) var(--space-2); border-bottom:1px solid var(--border); align-items:center; }
  .observation-list > div.focused { outline:2px solid var(--brand-gold-base,#d9a413); outline-offset:-2px; background:var(--surface-2); }
  .observation-list code { min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; font-size:.78rem; color:var(--text-muted); }
  .observation-filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:var(--gap-3); align-items:end; margin-bottom:var(--space-3); }
  .bulk-actions { display:flex; gap:var(--gap-2); flex-wrap:wrap; }
  .review-presets { display:flex; flex-wrap:wrap; gap:var(--gap-2); margin-bottom:var(--space-3); }
  .review-priority-note { margin:calc(-1 * var(--space-1)) 0 var(--space-3); color:var(--text-muted); font-size:.8rem; }
  .review-shortcuts { margin:calc(-1 * var(--space-1)) 0 var(--space-3); color:var(--text-muted); font-size:.78rem; }
  kbd { border:1px solid var(--border); border-bottom-width:2px; border-radius:3px; padding:0 .3rem; background:var(--surface-2); color:var(--text); font:inherit; }
  .release-readiness { display:grid; grid-template-columns:minmax(14rem,1fr) auto; gap:var(--gap-4); align-items:center; }
  .release-readiness h2 { margin-bottom:var(--space-1); }
  .release-readiness p { margin:0; color:var(--text-muted); font-size:.82rem; }
  .readiness-grid { display:grid; grid-template-columns:repeat(4, minmax(5rem,1fr)); gap:var(--gap-2); }
  .readiness-grid span { display:grid; gap:2px; padding:var(--space-2); background:var(--surface-2); color:var(--text-muted); font-size:.75rem; text-align:center; }
  .readiness-grid b { color:var(--text); font-size:1.1rem; }
  .readiness-grid .needs-review b { color:var(--brand-gold-strong); }
  .release-readiness .readiness-warning { grid-column:1/-1; color:var(--danger); }
  .release-preview p { color:var(--text-muted); font-size:.82rem; }
  .release-preview .readiness-warning { color:var(--danger); }
  .calibrate-panel { border:1px solid var(--border); border-radius:var(--radius-md); padding:var(--space-2) var(--space-3); }
  .calibrate-panel summary { cursor:pointer; font-size:.85rem; color:var(--text-muted); }
  .calibrate-panel[open] summary { margin-bottom:var(--space-3); }
  .observation-actions { display:flex; align-items:center; gap:var(--gap-2); justify-content:flex-end; }
  .observation-review { font-size:.7rem; text-transform:uppercase; color:var(--text-muted); }
  .observation-review.accepted,.observation-review.corrected { color:var(--green-strong); }
  .observation-correction { grid-column:1/-1; display:grid; grid-template-columns:minmax(7rem,.4fr) minmax(12rem,1fr) auto; gap:var(--gap-2); }
  .flag-list article { border:1px solid var(--border); border-left:4px solid var(--brand-gold-base,#d9a413); border-radius:var(--radius-md); padding:var(--space-3); }
  .flag-list article.resolved { opacity:.65; }
  .flag-list header,.values,.review-actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--gap-2); }
  .severity { text-transform:uppercase; font-size:.7rem; } .severity.critical { color:var(--red,#c33); }
  .values { justify-content:flex-start; color:var(--text-muted); margin-bottom:var(--space-2); }
  .review-actions { justify-content:flex-start; margin-top:var(--space-2); }
  @media (max-width:1050px) {
    .view-list > div { grid-template-columns:auto minmax(0,1fr); }
    .view-list video { grid-column:1/-1; max-width:32rem; }
    .observation-list > div { grid-template-columns:minmax(9rem,1fr) minmax(0,1fr) auto; }
    .observation-list code { grid-column:1/-1; }
  }
  @media (max-width:900px) {
    .vision-layout { grid-template-columns:1fr; }
    .sidebar { position:static; max-height:none; }
    .run-controls,.upload-grid,.observation-correction { grid-template-columns:1fr; }
    .release-readiness { grid-template-columns:1fr; }
    .observation-list > div { grid-template-columns:1fr; }
    .observation-actions { justify-content:flex-start; }
  }
  @media (max-width:560px) {
    .qwen-clip-list > div { grid-template-columns:1fr; }
    .status { align-items:flex-start; flex-direction:column; }
    .run-actions { justify-content:flex-start; }
    .readiness-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
    .identity-editor { flex-direction:column; }
    /* The release-preview and robot-tracks tables become one card per row -
       a data-label attribute on each <td> supplies the printed label since
       the real <th> row is hidden here. */
    .table-wrap { overflow:visible; }
    .table-wrap table thead { display:none; }
    .table-wrap table, .table-wrap table tbody, .table-wrap table tr, .table-wrap table td { display:block; width:100%; }
    .table-wrap table tr { border:1px solid var(--border); border-radius:var(--radius-lg); margin-bottom:var(--space-2); overflow:hidden; }
    .table-wrap table td { white-space:normal; border:0; border-bottom:1px solid var(--border); }
    .table-wrap table tr td:last-child { border-bottom:0; }
    .table-wrap table td::before { content:attr(data-label); display:block; color:var(--text-muted); font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; margin-bottom:2px; }
  }
</style>
