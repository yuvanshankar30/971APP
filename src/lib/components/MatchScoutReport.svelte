<script>
  import { MATCH_RATING_FIELDS } from '$lib/matchScouting.js';

  export let report;
  export let showTeam = false;

  const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  const valueOrDash = (value) => present(value) ? value : '-';
  const yesNo = (value) => value === true ? 'Yes' : value === false ? 'No' : '-';
  const list = (value) => Array.isArray(value) && value.length ? value.join(', ') : '-';
  const teamNumber = (value) => String(value || '').replace(/^frc/i, '') || '-';
  const matchLabel = (value) => String(value || '').split('_').at(-1) || '-';
  const points = (average, band) => present(band) ? band : present(average) ? average : '-';
  const timestamp = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
  };
</script>

<details class="match-report">
  <summary class:show-team={showTeam}>
    <strong>{matchLabel(report?.match_key)}</strong>
    {#if showTeam}<span>Team {teamNumber(report?.team_key)}</span>{/if}
    <span>{report?.scout_name || report?.created_by || 'Scout not identified'}</span>
    <time>{timestamp(report?.updated_at || report?.created_at)}</time>
  </summary>

  <div class="report-body">
    <section>
      <h4>Assignment</h4>
      <dl>
        <div><dt>Alliance</dt><dd>{valueOrDash(report?.alliance)}</dd></div>
        <div><dt>Starting position</dt><dd>{valueOrDash(report?.starting_position)}</dd></div>
      </dl>
    </section>

    <section>
      <h4>Autonomous</h4>
      <dl>
        <div><dt>Ran</dt><dd>{report?.auto_moved === 'ran' ? 'Yes' : report?.auto_moved === 'did-not-run' ? 'No' : valueOrDash(report?.auto_moved)}</dd></div>
        <div><dt>Start zone</dt><dd>{valueOrDash(report?.auto_start_zone)}</dd></div>
        <div><dt>Points</dt><dd>{points(report?.auto_points_average, report?.auto_points_band)}</dd></div>
        <div><dt>Finish</dt><dd>{valueOrDash(report?.auto_finish)}</dd></div>
        <div><dt>Fuel sources</dt><dd>{list(report?.ball_sources)}</dd></div>
        <div><dt>Collision</dt><dd>{yesNo(report?.auto_collision)}</dd></div>
        <div><dt>Path</dt><dd>{valueOrDash(report?.auto_path_name)} ({Array.isArray(report?.auto_path) ? report.auto_path.length : 0} points)</dd></div>
      </dl>
      {#if present(report?.auto_collision_notes)}<p>{report.auto_collision_notes}</p>{/if}
    </section>

    <section>
      <h4>Teleop</h4>
      <dl>
        <div><dt>Balls scored</dt><dd>{points(report?.balls_scored_average, report?.balls_scored_band)}</dd></div>
        <div><dt>Roles</dt><dd>{list(report?.teleop_roles)}</dd></div>
        <div><dt>Intake speed</dt><dd>{valueOrDash(report?.intake_speed)}</dd></div>
        <div><dt>Intake jammed</dt><dd>{yesNo(report?.intake_jammed)}</dd></div>
        <div><dt>Crash or break</dt><dd>{yesNo(report?.crash_or_break)}</dd></div>
        {#each MATCH_RATING_FIELDS as field}
          <div><dt>{field}</dt><dd>{valueOrDash(report?.ratings?.[field])}</dd></div>
        {/each}
      </dl>
      {#if present(report?.teleop_notes)}<p>{report.teleop_notes}</p>{/if}
    </section>

    <section>
      <h4>Post-match</h4>
      <dl>
        <div><dt>Robot status</dt><dd>{valueOrDash(report?.robot_disabled)}</dd></div>
        <div><dt>Card</dt><dd>{present(report?.card) ? report.card : 'None'}</dd></div>
        <div><dt>Driver skill</dt><dd>{valueOrDash(report?.driver_skill)}</dd></div>
      </dl>
      {#if present(report?.post_notes)}<p>{report.post_notes}</p>{/if}
    </section>
  </div>
</details>

<style>
  .match-report { border-top:1px solid var(--border); }
  .match-report:last-child { border-bottom:1px solid var(--border); }
  summary { display:grid; grid-template-columns:minmax(7rem, .7fr) minmax(8rem, 1fr) minmax(10rem, 1.4fr); gap:var(--space-2); align-items:center; min-height:2.75rem; padding:var(--space-2) var(--space-3); cursor:pointer; }
  summary.show-team { grid-template-columns:minmax(6rem, .6fr) minmax(7rem, .7fr) minmax(9rem, 1.2fr) minmax(10rem, 1fr); }
  summary time { color:var(--text-muted); font-size:.75rem; text-align:right; }
  .report-body { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); border-top:1px solid var(--border); }
  section { min-width:0; padding:var(--space-3); border-right:1px solid var(--border); border-bottom:1px solid var(--border); }
  section:nth-child(2n) { border-right:0; }
  section:nth-last-child(-n + 2) { border-bottom:0; }
  h4 { margin:0 0 var(--space-2); font-size:.82rem; }
  dl { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:var(--space-2); margin:0; }
  dl div { min-width:0; }
  dt { color:var(--text-muted); font-size:.7rem; text-transform:uppercase; }
  dd { margin:2px 0 0; overflow-wrap:anywhere; font-size:.82rem; }
  p { margin:var(--space-2) 0 0; padding-top:var(--space-2); border-top:1px solid var(--border); white-space:pre-wrap; overflow-wrap:anywhere; font-size:.82rem; }
  @media (max-width:720px) {
    summary, summary.show-team { grid-template-columns:1fr 1fr; }
    summary time { text-align:left; }
    .report-body { grid-template-columns:1fr; }
    section, section:nth-child(2n) { border-right:0; border-bottom:1px solid var(--border); }
    section:last-child { border-bottom:0; }
  }
</style>
