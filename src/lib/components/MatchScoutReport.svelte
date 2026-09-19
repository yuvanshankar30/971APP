<script>
  import { MATCH_RATING_FIELDS, MATCH_FORM_RATING_FIELDS, ACCURACY_LABELS, BPS_LABELS } from '$lib/matchScouting.js';
  import RebuiltFieldMap from './RebuiltFieldMap.svelte';

  export let report;
  export let showTeam = false;
  // Scoping this to an explicit prop rather than just deleting the
  // display:none below - Strategy/Power Rankings deliberately hide the
  // scout name below 1050px to make room for quick-stats, and that's not
  // what was asked to change. Scouting Admin's whole point is knowing who
  // submitted a report, so it opts in to keeping that visible everywhere.
  export let showScout = false;
  // Optional - only Scouting Admin's review list passes this. A plain
  // callback rather than a dispatched event since the caller (which knows
  // how to actually delete a report) varies more than a fixed event
  // contract would buy us here.
  export let onRemove = null;

  const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  const valueOrDash = (value) => present(value) ? value : '-';
  const yesNo = (value) => value === true ? 'Yes' : value === false ? 'No' : '-';
  const list = (value) => Array.isArray(value) && value.length ? value.join(', ') : '-';
  const teamNumber = (value) => String(value || '').replace(/^frc/i, '') || '-';
  const matchLabel = (value) => String(value || '').split('_').at(-1) || '-';
  const points = (average, band) => present(band) ? band : present(average) ? average : '-';
  const dateValue = (value, compact = false) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return compact
      ? date.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
      : date.toLocaleString();
  };

  $: reportTime = report?.updated_at || report?.created_at;
  $: autoScore = points(report?.auto_points_average, report?.auto_points_band);
  $: ballsScore = points(report?.balls_scored_average, report?.balls_scored_band);
  $: robotStatus = report?.form_version === 2
    ? valueOrDash(report?.teleop_robot_status)
    : valueOrDash(report?.robot_disabled);
  $: incidentLabels = [
    report?.auto_collision ? 'Collision' : '',
    report?.significant_crash || report?.crash_or_break ? 'Crash' : '',
    report?.mechanical_break ? 'Break' : '',
    present(report?.card) ? `${report.card} card` : ''
  ].filter(Boolean);
</script>

<details class="match-report">
  <summary>
    <span class="identity">
      <strong class="match-badge">{matchLabel(report?.match_key)}</strong>
      {#if showTeam}<strong class="team-badge">Team {teamNumber(report?.team_key)}</strong>{/if}
    </span>
    <span class="quick-stats" aria-label="Report summary">
      <span><small>Auto</small><b>{autoScore}</b></span>
      <span><small>Balls</small><b>{ballsScore}</b></span>
      <span><small>Status</small><b class:status-active={String(robotStatus).toLowerCase() === 'active'}>{robotStatus}</b></span>
      <span class:has-alerts={incidentLabels.length > 0}>
        <small>Incidents</small><b>{incidentLabels.length ? incidentLabels.join(', ') : 'Clear'}</b>
      </span>
    </span>
    <span class="report-meta" class:force-visible={showScout}>
      <span>{report?.scout_name || report?.created_by || 'Unknown scout'}</span>
      <time datetime={reportTime || undefined} title={dateValue(reportTime)}>{dateValue(reportTime, true)}</time>
    </span>
    {#if onRemove}
      <button
        class="remove-btn"
        type="button"
        title="Remove this match report"
        aria-label={`Remove the ${matchLabel(report?.match_key)} report for team ${teamNumber(report?.team_key)}`}
        on:click|stopPropagation|preventDefault={() => onRemove(report)}
      >&times;</button>
    {/if}
  </summary>

  <div class="report-body">
    <section class="assignment">
      <h4>Assignment</h4>
      <dl>
        <div><dt>Alliance</dt><dd>{valueOrDash(report?.alliance)}</dd></div>
        <div><dt>Starting position</dt><dd>{valueOrDash(report?.starting_position)}</dd></div>
        {#if report?.form_version === 2}<div><dt>Preload</dt><dd>{yesNo(report.preload)}</dd></div>{/if}
      </dl>
    </section>

    <section class="auto">
      <h4>Autonomous</h4>
      <dl>
        <div><dt>Ran</dt><dd>{report?.auto_moved === 'ran' ? 'Yes' : report?.auto_moved === 'did-not-run' ? 'No' : valueOrDash(report?.auto_moved)}</dd></div>
        <div><dt>Start zone</dt><dd>{valueOrDash(report?.auto_start_zone)}</dd></div>
        <div><dt>Points</dt><dd>{autoScore}</dd></div>
        <div><dt>Finish</dt><dd>{valueOrDash(report?.auto_finish)}</dd></div>
        <div><dt>Fuel sources</dt><dd>{list(report?.ball_sources)}</dd></div>
        {#if report?.form_version === 2}<div><dt>Auto cycles</dt><dd>{valueOrDash(report.auto_cycles)}</dd></div>{/if}
        <div><dt>Collision</dt><dd>{yesNo(report?.auto_collision)}</dd></div>
        {#if present(report?.auto_path_name) || report?.auto_path?.length}<div><dt>Path</dt><dd>{valueOrDash(report?.auto_path_name)} ({Array.isArray(report?.auto_path) ? report.auto_path.length : 0} points)</dd></div>{/if}
      </dl>
      {#if report?.auto_path?.length}
        <div class="auto-path-preview">
          <RebuiltFieldMap alliance={report?.alliance === 'red' ? 'red' : 'blue'} path={report.auto_path} readonly />
        </div>
      {/if}
    </section>

    <section class="teleop">
      <h4>Teleop</h4>
      <dl>
        <div><dt>Balls scored</dt><dd>{ballsScore}</dd></div>
        <div><dt>Roles</dt><dd>{report?.teleop_roles_none ? 'None observed' : list(report?.teleop_roles)}</dd></div>
        {#if report?.form_version === 2}
          <div><dt>Significant crash</dt><dd>{yesNo(report.significant_crash)}</dd></div>
          {#if report.significant_crash}<div><dt>Crash target</dt><dd>{valueOrDash(report.crash_target)}</dd></div>{/if}
          <div><dt>Teleop status</dt><dd>{valueOrDash(report.teleop_robot_status)}</dd></div>
        {:else}
        <div><dt>Intake speed</dt><dd>{valueOrDash(report?.intake_speed)}</dd></div>
        <div><dt>Intake jammed</dt><dd>{yesNo(report?.intake_jammed)}</dd></div>
        <div><dt>Crash or break</dt><dd>{yesNo(report?.crash_or_break)}</dd></div>
        {/if}
        {#each report?.form_version === 2 ? MATCH_FORM_RATING_FIELDS : MATCH_RATING_FIELDS as field}
          <div><dt>{field}</dt><dd>{report?.ratings_unknown?.includes(field) ? 'Unknown' : valueOrDash(report?.ratings?.[field])}{#if report?.form_version === 2 && report?.ratings?.[field]} · {(field === 'BPS' ? BPS_LABELS : ACCURACY_LABELS)[report.ratings[field] - 1]}{/if}</dd></div>
        {/each}
      </dl>
    </section>

    <section class="post-match">
      <h4>Post-match</h4>
      <dl>
        <div><dt>Robot status</dt><dd>{valueOrDash(report?.robot_disabled)}</dd></div>
        <div><dt>Card</dt><dd>{present(report?.card) ? report.card : 'None'}</dd></div>
        <div><dt>Driver skill</dt><dd>{valueOrDash(report?.driver_skill)}</dd></div>
        {#if report?.form_version === 2}<div><dt>Mechanical break</dt><dd>{yesNo(report.mechanical_break)}</dd></div>{/if}
      </dl>
    </section>
  </div>
  {#if present(report?.auto_collision_notes) || present(report?.teleop_notes) || present(report?.crash_details) || present(report?.post_notes)}
    <div class="report-notes">
      {#if present(report?.auto_collision_notes)}<p><strong>Auto</strong>{report.auto_collision_notes}</p>{/if}
      {#if present(report?.teleop_notes)}<p><strong>Teleop</strong>{report.teleop_notes}</p>{/if}
      {#if present(report?.crash_details)}<p><strong>Crash</strong>{report.crash_details}</p>{/if}
      {#if present(report?.post_notes)}<p><strong>Post-match</strong>{report.post_notes}</p>{/if}
    </div>
  {/if}
</details>

<style>
  .match-report {
    overflow:hidden;
    margin:0 0 var(--space-2);
    border:1px solid var(--border);
    border-radius:8px;
    background:var(--surface-1, #fff);
  }
  .match-report[open] { box-shadow:0 5px 18px rgb(55 45 25 / 8%); }
  summary {
    display:grid;
    grid-template-columns:minmax(8rem, .7fr) minmax(24rem, 2fr) minmax(9rem, .7fr);
    gap:var(--space-3);
    align-items:center;
    min-height:3.25rem;
    padding:.55rem var(--space-3);
    cursor:pointer;
    list-style-position:outside;
  }
  summary:hover { background:color-mix(in srgb, var(--accent, #c99525) 6%, transparent); }
  summary:focus-visible { outline:2px solid var(--accent, #b98000); outline-offset:-2px; }
  .identity { display:flex; gap:.4rem; align-items:center; min-width:0; }
  .match-badge, .team-badge {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-height:1.7rem;
    padding:0 .55rem;
    border-radius:999px;
    white-space:nowrap;
    font-size:.78rem;
  }
  /* Fixed width (not just padding) so "8" and "Quals 47" read as the same
     size pill instead of the badge shrink-wrapping to whatever match label
     happens to be longest in this list - direct feedback that a list of
     these side by side looked visually uneven. */
  .match-badge { min-width:5.75rem; background:var(--text, #201c15); color:var(--surface-1, #fff); }
  .team-badge { border:1px solid color-mix(in srgb, var(--accent, #b98000) 45%, var(--border)); background:color-mix(in srgb, var(--accent, #c99525) 12%, transparent); }
  .quick-stats { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); min-width:0; }
  .quick-stats > span { min-width:0; padding:0 .65rem; border-left:1px solid var(--border); }
  .quick-stats small, .quick-stats b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .quick-stats small { color:var(--text-muted); font-size:.61rem; letter-spacing:.055em; text-transform:uppercase; }
  .quick-stats b { margin-top:1px; font-size:.78rem; font-weight:650; }
  .quick-stats .status-active { color:#177348; }
  .quick-stats .has-alerts b { color:#b33a2f; }
  .report-meta { display:flex; flex-direction:column; min-width:0; text-align:right; }
  .report-meta > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.75rem; }
  .report-meta time { color:var(--text-muted); font-size:.66rem; }
  summary:has(.remove-btn) { grid-template-columns:minmax(8rem, .7fr) minmax(20rem, 2fr) minmax(9rem, .7fr) auto; }
  .remove-btn {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    width:1.7rem;
    height:1.7rem;
    border:1px solid var(--border);
    border-radius:50%;
    background:var(--surface-1, #fff);
    color:#b33a2f;
    font-size:1.1rem;
    line-height:1;
    cursor:pointer;
  }
  .remove-btn:hover { background:rgba(239, 68, 68, .12); border-color:#b33a2f; }
  .remove-btn { justify-self:end; }
  .report-body {
    display:grid;
    grid-template-columns:minmax(9rem, .72fr) repeat(3, minmax(12rem, 1fr));
    gap:1px;
    padding-top:1px;
    background:var(--border);
  }
  section { --section-color:#8b6b24; min-width:0; padding:.75rem; background:var(--surface-1, #fff); box-shadow:inset 0 3px var(--section-color); }
  section.assignment { --section-color:#687076; }
  section.auto { --section-color:#b98000; }
  .auto-path-preview { max-width:min(320px, 100%); margin:.5rem 0 0; font-size:.7rem; }
  section.teleop { --section-color:#306fa8; }
  section.post-match { --section-color:#437d55; }
  h4 { margin:0 0 .45rem; color:var(--section-color); font-size:.73rem; letter-spacing:.055em; text-transform:uppercase; }
  dl { display:grid; gap:0; margin:0; }
  dl div { display:flex; gap:.6rem; justify-content:space-between; min-width:0; padding:.27rem 0; border-top:1px solid color-mix(in srgb, var(--border) 70%, transparent); }
  dl div:first-child { border-top:0; }
  dt { flex:0 1 auto; color:var(--text-muted); font-size:.67rem; }
  dd { flex:1 1 auto; margin:0; overflow-wrap:anywhere; text-align:right; font-size:.72rem; font-weight:600; }
  .report-notes { display:grid; grid-template-columns:repeat(auto-fit, minmax(14rem, 1fr)); gap:1px; border-top:1px solid var(--border); background:var(--border); }
  .report-notes p { margin:0; padding:.65rem .75rem; background:var(--surface-1, #fff); white-space:pre-wrap; overflow-wrap:anywhere; font-size:.74rem; line-height:1.4; }
  .report-notes strong { display:block; margin-bottom:.2rem; color:var(--text-muted); font-size:.62rem; letter-spacing:.055em; text-transform:uppercase; }
  @media (max-width:1050px) {
    summary { grid-template-columns:minmax(8rem, .7fr) minmax(20rem, 2fr); }
    .report-meta { display:none; }
    .report-body { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  }
  /* showScout's whole point is staying visible at any width - restore the
     column .report-meta was hidden by removing above (:has() rather than a
     showScout-specific class on <summary>, since that element has no prop
     access of its own). */
  @media (max-width:1050px) {
    summary:has(.report-meta.force-visible) { grid-template-columns:minmax(8rem, .7fr) minmax(18rem, 2fr) minmax(7rem, .5fr); }
    summary:has(.report-meta.force-visible):has(.remove-btn) { grid-template-columns:minmax(8rem, .7fr) minmax(16rem, 2fr) minmax(7rem, .5fr) auto; }
    summary:has(.remove-btn):not(:has(.report-meta.force-visible)) { grid-template-columns:minmax(8rem, .7fr) minmax(20rem, 2fr) auto; }
    .report-meta.force-visible { display:flex; }
  }
  @media (max-width:680px) {
    summary { grid-template-columns:1fr; gap:.45rem; padding:.7rem var(--space-3); }
    .quick-stats > span:first-child { border-left:0; padding-left:0; }
    .quick-stats > span { padding:0 .4rem; }
    .report-body { grid-template-columns:1fr; }
  }
</style>
