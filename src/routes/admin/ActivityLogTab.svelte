<script>
  import { onMount, onDestroy } from 'svelte';
  import { supabase } from '$lib/supabase.js';

  let entries = [];
  let loading = true;
  let error = null;
  let userNames = {}; // actor uuid -> display name
  let channel = null;
  let live = false;

  const PAGE_SIZE = 200;

  // Friendly labels for table names.
  const TABLE_LABELS = {
    parts: 'Part',
    purchasing: 'Purchase',
    subsystems: 'Subsystem',
    builds: 'Build',
    build_bom: 'BOM item',
    kitting: 'Kitting',
    kitting_bins: 'Kitting bin',
    router_groups: 'Router group',
    router_group_parts: 'Router group part',
    vendors: 'Vendor',
    orders: 'Order',
    purchasing_budgets: 'Budget',
    user_profiles: 'User',
    cots_stock_items: 'COTS item',
    cots_stock_locations: 'COTS location',
    subsystem_members: 'Subsystem member',
    rosters: 'Roster',
    roster_keys: 'Roster key',
    roster_entries: 'Roster entry',
    cam_jobs: 'AutoCAM Job',
    cam_materials: 'AutoCAM Material',
    cam_tools: 'AutoCAM Tool',
    cam_machines: 'AutoCAM Machine',
    slack_messages: 'Slack message'
  };

  function tableLabel(t) { return TABLE_LABELS[t] || t; }

  function actorName(actor) {
    if (!actor) return 'System / API';
    return userNames[actor] || 'Unknown user';
  }

  // A short, human label for the affected row.
  function rowLabel(entry) {
    const data = entry.new_data || entry.old_data || {};
    if (entry.table_name === 'slack_messages') return data.message || 'Message sent';
    return data.name || data.full_name || data.release_name || data.email
      || data.part_name || (entry.row_id ? `#${entry.row_id}` : '');
  }

  function operationLabel(entry) {
    return entry.table_name === 'slack_messages' ? 'Sent' : entry.operation;
  }

  function slackRecipient(entry) {
    return entry.table_name === 'slack_messages' ? entry.new_data?.recipient : null;
  }

  function formatTime(ts) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit'
      }).format(new Date(ts));
    } catch { return ts; }
  }

  // Columns we don't want to show as "changed" noise.
  const NOISE_COLS = new Set(['updated_at', 'created_at']);
  function changedSummary(entry) {
    if (entry.operation !== 'UPDATE' || !entry.changed_columns) return '';
    const cols = entry.changed_columns.filter((c) => !NOISE_COLS.has(c));
    if (cols.length === 0) return '';
    return cols.slice(0, 6).join(', ') + (cols.length > 6 ? `, +${cols.length - 6} more` : '');
  }

  async function loadUserNames() {
    const { data } = await supabase.from('user_profiles').select('id, full_name, email');
    const map = {};
    (data || []).forEach((u) => { map[u.id] = u.full_name || u.email || u.id; });
    userNames = map;
  }

  async function loadEntries() {
    loading = true;
    error = null;
    const { data, error: err } = await supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (err) { error = err.message; loading = false; return; }
    entries = data || [];
    loading = false;
  }

  function subscribe() {
    channel = supabase
      .channel('activity_log_feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) => {
        if (payload?.new) {
          entries = [payload.new, ...entries].slice(0, PAGE_SIZE);
        }
      })
      .subscribe((status) => { live = status === 'SUBSCRIBED'; });
  }

  onMount(async () => {
    await loadUserNames();
    await loadEntries();
    subscribe();
  });

  onDestroy(() => {
    if (channel) supabase.removeChannel(channel);
  });
</script>

<section class="section-card">
  <div class="activity-header">
    <div>
      <h3>Activity Log</h3>
      <p class="muted">Every create, edit, delete, and sent Slack message across the site, in real time.</p>
    </div>
    <div class="activity-status">
      <span class="live-dot" class:on={live}></span>
      <span>{live ? 'Live' : 'Connecting…'}</span>
      <button class="btn btn-sm" on:click={loadEntries}>Refresh</button>
    </div>
  </div>

  {#if loading}
    <p class="muted">Loading activity…</p>
  {:else if error}
    <p class="error-message">Failed to load activity: {error}</p>
  {:else if entries.length === 0}
    <p class="muted">No activity recorded yet.</p>
  {:else}
    <div class="activity-list">
      {#each entries as e (e.id)}
        <div class="activity-row">
          <span class="op-badge op-{operationLabel(e).toLowerCase()}">{operationLabel(e)}</span>
          <div class="activity-main">
            <div class="activity-line">
              <strong>{tableLabel(e.table_name)}</strong>
              {#if rowLabel(e)}<span class="activity-target">{rowLabel(e)}</span>{/if}
              {#if changedSummary(e)}<span class="activity-changed">changed: {changedSummary(e)}</span>{/if}
            </div>
            <div class="activity-meta">
              <span class="activity-actor">{actorName(e.actor)}</span>
              {#if slackRecipient(e)}
                <span class="activity-dot">·</span>
                <span>to {slackRecipient(e)}</span>
              {/if}
              <span class="activity-dot">·</span>
              <span class="activity-time">{formatTime(e.created_at)}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .activity-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .activity-header h3 { margin: 0; }
  .activity-header .muted { margin: 0.25rem 0 0; }

  .activity-status {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--font-xs);
    color: var(--text-muted);
  }
  .live-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--neutral-400, #9ca3af);
  }
  .live-dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.2); }

  .activity-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
  }
  .activity-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  .activity-row:last-child { border-bottom: none; }

  .op-badge {
    flex: 0 0 auto;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    min-width: 54px;
    text-align: center;
  }
  .op-insert { background: #dcfce7; color: var(--green-strong); }
  .op-update { background: var(--blue-soft); color: #1e40af; }
  .op-delete { background: #fee2e2; color: #991b1b; }
  .op-sent { background: var(--blue-soft); color: var(--blue-base); }
  :global([data-theme="modern-dark"]) .op-insert { background: rgba(74, 222, 128, 0.16); color: #86efac; }
  :global([data-theme="modern-dark"]) .op-update,
  :global([data-theme="modern-dark"]) .op-sent { background: rgba(96, 165, 250, 0.16); color: #93c5fd; }
  :global([data-theme="modern-dark"]) .op-delete { background: rgba(248, 113, 113, 0.16); color: #fca5a5; }

  .activity-main { min-width: 0; flex: 1; }
  .activity-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; font-size: 0.85rem; }
  .activity-target { color: var(--text); font-weight: 500; }
  .op-sent + .activity-main .activity-target { font-weight: 400; }
  .activity-changed { color: var(--text-muted); font-size: 0.75rem; }
  .activity-meta { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--text-muted); margin-top: 0.15rem; }
</style>
