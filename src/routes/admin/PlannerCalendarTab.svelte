<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { getAuthHeader } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { PLANNER_TIME_ZONE } from '$lib/planner/constants.js';

  export let currentUser = null;

  const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const plannerDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: PLANNER_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

  let mounted = false;
  let loading = false;
  let saving = false;
  let error = '';
  let info = '';
  let calendarRules = [];
  let warnings = [];
  let editingRuleId = null;
  let ruleDraft = createRuleDraft('blocked');
  let lastLoadedTeam = null;

  function plannerTeamEnabled(team) {
    return team === '971' || team === '9584';
  }

  function createRuleDraft(ruleType = 'blocked') {
    const normalizedRuleType = ruleType === 'work_window' ? 'work_window' : 'blocked';
    const isWorkWindow = normalizedRuleType === 'work_window';
    return {
      rule_type: normalizedRuleType,
      label: '',
      weekday: '',
      specific_date: '',
      starts_at: isWorkWindow ? '08:00' : '18:00',
      ends_at: isWorkWindow ? '17:00' : '19:00',
      enabled: true
    };
  }

  function createRuleDraftFromExisting(rule) {
    return {
      rule_type: rule?.rule_type === 'work_window' ? 'work_window' : 'blocked',
      label: String(rule?.label || ''),
      weekday: rule?.weekday === null || rule?.weekday === undefined ? '' : String(rule.weekday),
      specific_date: String(rule?.specific_date || ''),
      starts_at: String(rule?.starts_at || '').slice(0, 5),
      ends_at: String(rule?.ends_at || '').slice(0, 5),
      enabled: rule?.enabled !== false
    };
  }

  async function plannerRequest(method = 'GET', body = null) {
    const headers = {
      ...(await getAuthHeader())
    };
    if (body) headers['content-type'] = 'application/json';

    const response = await fetch('/api/planner', {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.error || `Planner request failed (${response.status})`);
    }

    return payload;
  }

  function hydrateBundle(data) {
    calendarRules = data?.calendar_rules || [];
    warnings = data?.warnings || [];
  }

  async function loadPlannerCalendar() {
    if (!plannerAvailable) return;
    loading = true;
    error = '';
    info = '';

    try {
      const payload = await plannerRequest('GET');
      hydrateBundle(payload?.data || {});
    } catch (loadError) {
      error = loadError.message || 'Failed to load the planner calendar.';
    } finally {
      loading = false;
    }
  }

  async function submitPlannerAction(body, successMessage = '') {
    saving = true;
    error = '';
    info = '';

    try {
      const payload = await plannerRequest('POST', body);
      hydrateBundle(payload?.data || {});
      if (successMessage) {
        info = successMessage;
        toastActions.show(successMessage);
      }
      return payload;
    } catch (submitError) {
      error = submitError.message || 'Planner calendar request failed.';
      toastActions.show(error);
      throw submitError;
    } finally {
      saving = false;
    }
  }

  function openNewRule(ruleType = 'blocked') {
    editingRuleId = null;
    error = '';
    info = '';
    ruleDraft = createRuleDraft(ruleType);
  }

  function openRuleEditor(rule) {
    editingRuleId = rule?.id || null;
    error = '';
    info = '';
    ruleDraft = createRuleDraftFromExisting(rule);
  }

  function cancelRuleEditor() {
    openNewRule(ruleDraft?.rule_type || 'blocked');
  }

  function setRuleType(nextType) {
    const normalizedRuleType = nextType === 'work_window' ? 'work_window' : 'blocked';
    const nextDraft = createRuleDraft(normalizedRuleType);

    ruleDraft = {
      ...nextDraft,
      label: ruleDraft.label,
      weekday: ruleDraft.specific_date ? '' : ruleDraft.weekday,
      specific_date: ruleDraft.specific_date,
      enabled: ruleDraft.enabled !== false
    };
  }

  function setRecurrenceMode(mode) {
    if (mode === 'specific_date') {
      ruleDraft = {
        ...ruleDraft,
        weekday: ''
      };
      return;
    }

    ruleDraft = {
      ...ruleDraft,
      specific_date: ''
    };
  }

  function validateRuleDraft() {
    if (!ruleDraft.label.trim()) return 'Calendar rule label is required.';
    if (!ruleDraft.weekday && !ruleDraft.specific_date) return 'Choose either a weekday or a specific date.';
    if (!ruleDraft.starts_at || !ruleDraft.ends_at) return 'Start and end times are required.';
    if (ruleDraft.starts_at >= ruleDraft.ends_at) return 'End time must be after the start time.';
    return '';
  }

  async function saveRule() {
    const validationError = validateRuleDraft();
    if (validationError) {
      error = validationError;
      toastActions.show(validationError);
      return;
    }

    const action = editingRuleId ? 'update-calendar-rule' : 'create-calendar-rule';
    const payload = {
      action,
      ...(editingRuleId ? { rule_id: editingRuleId } : {}),
      ...ruleDraft,
      weekday: ruleDraft.specific_date ? null : (ruleDraft.weekday === '' ? null : Number(ruleDraft.weekday)),
      specific_date: ruleDraft.specific_date || null
    };

    await submitPlannerAction(
      payload,
      editingRuleId ? 'Planner calendar rule updated.' : (ruleDraft.rule_type === 'work_window' ? 'Work window created.' : 'Meeting scheduled.')
    );

    const nextRuleType = payload.rule_type === 'work_window' ? 'work_window' : 'blocked';
    editingRuleId = null;
    ruleDraft = createRuleDraft(nextRuleType);
  }

  async function deleteRule(ruleId) {
    if (!ruleId) return;
    if (!await requestConfirmation({ title: 'Delete calendar rule', message: 'Delete this planner calendar rule?', confirmLabel: 'Delete', danger: true })) return;

    await submitPlannerAction({
      action: 'delete-calendar-rule',
      rule_id: ruleId
    }, 'Planner calendar rule deleted.');

    if (editingRuleId === ruleId) {
      editingRuleId = null;
      ruleDraft = createRuleDraft('blocked');
    }
  }

  function formatTimeValue(value) {
    const timeValue = String(value || '').slice(0, 5);
    return timeValue || '--:--';
  }

  function formatRuleWhen(rule) {
    if (rule?.specific_date) {
      const isoValue = `${rule.specific_date}T12:00:00`;
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: PLANNER_TIME_ZONE,
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        }).format(new Date(isoValue));
      } catch {
        return rule.specific_date;
      }
    }

    if (rule?.weekday === 0 || rule?.weekday) {
      return DAY_LABELS[rule.weekday] || 'Custom';
    }

    return 'Custom';
  }

  function formatRuleWindow(rule) {
    return `${formatTimeValue(rule?.starts_at)} to ${formatTimeValue(rule?.ends_at)} PT`;
  }

  function formatRuleRecurrence(rule) {
    return rule?.specific_date ? 'One-off' : 'Weekly';
  }

  function formatBlockedRuleType(rule) {
    return rule?.rule_type === 'drive_practice' ? 'Legacy Drive Practice' : 'Meeting';
  }

  function formatWarningMessage(warning) {
    if (!warning) return '';
    return typeof warning === 'string' ? warning : String(warning?.message || warning);
  }

  function formatLastUpdated(rule) {
    if (!rule?.updated_at) return 'Not yet updated';
    try {
      return plannerDateTimeFormatter.format(new Date(rule.updated_at));
    } catch {
      return String(rule.updated_at);
    }
  }

  $: plannerAvailable = plannerTeamEnabled(currentUser?.frc_team);
  $: blockedRules = (calendarRules || []).filter((rule) => rule.rule_type === 'blocked' || rule.rule_type === 'drive_practice');
  $: legacyDrivePracticeRules = blockedRules.filter((rule) => rule.rule_type === 'drive_practice');
  $: workWindowRules = (calendarRules || []).filter((rule) => rule.rule_type === 'work_window');
  $: recurrenceMode = ruleDraft?.specific_date ? 'specific_date' : 'weekday';

  onMount(() => {
    mounted = true;
    if (plannerAvailable) {
      lastLoadedTeam = currentUser?.frc_team || null;
      loadPlannerCalendar();
    }
  });

  $: if (mounted && plannerAvailable && currentUser?.frc_team && currentUser.frc_team !== lastLoadedTeam) {
    lastLoadedTeam = currentUser.frc_team;
    loadPlannerCalendar();
  }
</script>

<section class="section-card">
  <div class="section-header">
    <div>
      <h3>Gantt Calendar</h3>
      <p class="text-muted">Edit the work windows the scheduler can use and schedule meetings that block time out of the Gantt calendar.</p>
    </div>
    <div class="section-actions">
      <button class="btn btn-secondary" type="button" on:click={loadPlannerCalendar} disabled={!plannerAvailable || loading || saving}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <a class="btn btn-outline" href="/planner">Open Planner</a>
    </div>
  </div>

  {#if !plannerAvailable}
    <div class="empty-state">
      <h3>Planner calendar unavailable</h3>
      <p>This admin pane is currently enabled only for Team 971 and Team 9584 users. Your profile is set to {currentUser?.frc_team || 'no team'}.</p>
    </div>
  {:else}
    {#if error}
      <div class="planner-admin-banner planner-admin-banner--danger">{error}</div>
    {/if}

    {#if info}
      <div class="planner-admin-banner planner-admin-banner--success">{info}</div>
    {/if}

    {#if legacyDrivePracticeRules.length > 0}
      <div class="planner-admin-banner planner-admin-banner--warning">
        {legacyDrivePracticeRules.length} legacy drive practice calendar block{legacyDrivePracticeRules.length === 1 ? '' : 's'} still exist. Recreate them as planner tasks when you get a chance.
      </div>
    {/if}

    <div class="planner-admin-stats">
      <article class="planner-admin-stat">
        <span class="planner-admin-stat-label">Meeting Blocks</span>
        <strong>{blockedRules.length}</strong>
        <small>Blocked time that the Gantt must skip.</small>
      </article>
      <article class="planner-admin-stat">
        <span class="planner-admin-stat-label">Work Windows</span>
        <strong>{workWindowRules.length}</strong>
        <small>Time windows the scheduler is allowed to use.</small>
      </article>
      <article class="planner-admin-stat">
        <span class="planner-admin-stat-label">Scheduler Warnings</span>
        <strong>{warnings.length}</strong>
        <small>Warnings returned after the latest recompute.</small>
      </article>
    </div>

    <div class="planner-admin-grid">
      <section class="planner-admin-panel">
        <div class="planner-admin-panel-head">
          <div>
            <h4>{editingRuleId ? 'Edit Calendar Rule' : 'Create Calendar Rule'}</h4>
            <p>{ruleDraft.rule_type === 'work_window' ? 'Define when the Gantt is allowed to place work.' : 'Schedule a meeting or manual block that removes time from the Gantt.'}</p>
          </div>
          <div class="section-actions">
            <button class="btn btn-secondary btn-sm" type="button" on:click={() => openNewRule('blocked')} disabled={saving}>New Meeting</button>
            <button class="btn btn-secondary btn-sm" type="button" on:click={() => openNewRule('work_window')} disabled={saving}>New Work Window</button>
          </div>
        </div>

        {#if loading}
          <div class="empty-state">
            <h3>Loading planner calendar…</h3>
            <p>Pulling the current schedule rules from the planner API.</p>
          </div>
        {:else}
          <div class="planner-admin-help">
            Blocked meetings carve time out of the schedule. Work windows tell the Gantt which hours are available for scheduling.
          </div>

          <div class="planner-form-grid">
            <label class="planner-form-group planner-form-group--full">
              <span class="form-label">Rule Label</span>
              <input
                class="form-input"
                type="text"
                bind:value={ruleDraft.label}
                placeholder={ruleDraft.rule_type === 'work_window' ? 'Wednesday shop hours' : 'Wednesday build meeting'}
              />
            </label>

            <label class="planner-form-group">
              <span class="form-label">Rule Type</span>
              <select class="form-select" bind:value={ruleDraft.rule_type} on:change={(event) => setRuleType(event.currentTarget.value)}>
                <option value="blocked">Meeting / Block</option>
                <option value="work_window">Work Window</option>
              </select>
            </label>

            <div class="planner-form-group">
              <span class="form-label">Recurrence</span>
              <div class="planner-segmented-control" role="group" aria-label="Rule recurrence">
                <button
                  type="button"
                  class:active={recurrenceMode === 'weekday'}
                  on:click={() => setRecurrenceMode('weekday')}
                >
                  Weekly
                </button>
                <button
                  type="button"
                  class:active={recurrenceMode === 'specific_date'}
                  on:click={() => setRecurrenceMode('specific_date')}
                >
                  One-off
                </button>
              </div>
            </div>

            {#if recurrenceMode === 'weekday'}
              <label class="planner-form-group">
                <span class="form-label">Day of Week</span>
                <select class="form-select" bind:value={ruleDraft.weekday}>
                  <option value="">Choose a day</option>
                  {#each DAY_LABELS as day, index}
                    <option value={index}>{day}</option>
                  {/each}
                </select>
              </label>
            {:else}
              <label class="planner-form-group">
                <span class="form-label">Specific Date</span>
                <input class="form-input" type="date" bind:value={ruleDraft.specific_date} />
              </label>
            {/if}

            <label class="planner-form-group">
              <span class="form-label">Start Time</span>
              <input class="form-input" type="time" bind:value={ruleDraft.starts_at} />
            </label>

            <label class="planner-form-group">
              <span class="form-label">End Time</span>
              <input class="form-input" type="time" bind:value={ruleDraft.ends_at} />
            </label>

            <label class="planner-form-group planner-form-group--toggle">
              <input type="checkbox" bind:checked={ruleDraft.enabled} />
              <span>Rule enabled</span>
            </label>
          </div>

          <div class="form-actions">
            <button class="btn btn-primary" type="button" on:click={saveRule} disabled={saving}>
              {saving ? 'Saving…' : editingRuleId ? 'Update Rule' : (ruleDraft.rule_type === 'work_window' ? 'Create Work Window' : 'Schedule Meeting')}
            </button>
            {#if editingRuleId}
              <button class="btn btn-outline" type="button" on:click={cancelRuleEditor} disabled={saving}>Cancel Edit</button>
              <button class="btn btn-outline-danger" type="button" on:click={() => deleteRule(editingRuleId)} disabled={saving}>Delete Rule</button>
            {/if}
          </div>
        {/if}
      </section>

      <div class="planner-admin-lists">
        <section class="planner-admin-panel">
          <div class="planner-admin-panel-head">
            <div>
              <h4>Meetings and Blocks</h4>
              <p>These remove time from the Gantt calendar and can be weekly or one-off.</p>
            </div>
            <div class="section-actions">
              <span class="badge-soft">{blockedRules.length} total</span>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => openNewRule('blocked')} disabled={saving}>Add Meeting</button>
            </div>
          </div>

          {#if loading}
            <div class="empty-state">Loading meetings…</div>
          {:else if blockedRules.length === 0}
            <div class="empty-state">
              <h3>No meetings scheduled</h3>
              <p>Add a blocked meeting here to carve time out of the Gantt calendar.</p>
            </div>
          {:else}
            <div class="planner-rule-list">
              {#each blockedRules as rule (rule.id)}
                <article class="planner-rule-card">
                  <div class="planner-rule-copy">
                    <div class="planner-rule-title">
                      <strong>{rule.label}</strong>
                      <span class="badge-soft">{formatBlockedRuleType(rule)}</span>
                      <span class={`planner-enabled-pill planner-enabled-pill--${rule.enabled ? 'on' : 'off'}`}>
                        {rule.enabled ? 'Enabled' : 'Paused'}
                      </span>
                    </div>
                    <div class="planner-rule-meta">
                      <span>{formatRuleRecurrence(rule)}</span>
                      <span>{formatRuleWhen(rule)}</span>
                      <span>{formatRuleWindow(rule)}</span>
                    </div>
                    <small class="text-muted">Updated {formatLastUpdated(rule)}</small>
                  </div>
                  <div class="section-actions">
                    <button class="btn btn-outline btn-sm" type="button" on:click={() => openRuleEditor(rule)}>Edit</button>
                    <button class="btn btn-outline-danger btn-sm" type="button" on:click={() => deleteRule(rule.id)}>Delete</button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>

        <section class="planner-admin-panel">
          <div class="planner-admin-panel-head">
            <div>
              <h4>Work Windows</h4>
              <p>These are the hours the planner scheduler is allowed to use for tasks.</p>
            </div>
            <div class="section-actions">
              <span class="badge-soft">{workWindowRules.length} total</span>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => openNewRule('work_window')} disabled={saving}>Add Work Window</button>
            </div>
          </div>

          {#if loading}
            <div class="empty-state">Loading work windows…</div>
          {:else if workWindowRules.length === 0}
            <div class="empty-state">
              <h3>No work windows configured</h3>
              <p>Create at least one work window so the Gantt knows when it can schedule work.</p>
            </div>
          {:else}
            <div class="planner-rule-list">
              {#each workWindowRules as rule (rule.id)}
                <article class="planner-rule-card">
                  <div class="planner-rule-copy">
                    <div class="planner-rule-title">
                      <strong>{rule.label}</strong>
                      <span class="badge-soft">Work Window</span>
                      <span class={`planner-enabled-pill planner-enabled-pill--${rule.enabled ? 'on' : 'off'}`}>
                        {rule.enabled ? 'Enabled' : 'Paused'}
                      </span>
                    </div>
                    <div class="planner-rule-meta">
                      <span>{formatRuleRecurrence(rule)}</span>
                      <span>{formatRuleWhen(rule)}</span>
                      <span>{formatRuleWindow(rule)}</span>
                    </div>
                    <small class="text-muted">Updated {formatLastUpdated(rule)}</small>
                  </div>
                  <div class="section-actions">
                    <button class="btn btn-outline btn-sm" type="button" on:click={() => openRuleEditor(rule)}>Edit</button>
                    <button class="btn btn-outline-danger btn-sm" type="button" on:click={() => deleteRule(rule.id)}>Delete</button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    </div>

    {#if warnings.length > 0}
      <section class="planner-admin-warning-panel">
        <div class="planner-admin-panel-head">
          <div>
            <h4>Scheduler Warnings</h4>
            <p>These warnings come from the planner recompute after rule changes.</p>
          </div>
        </div>
        <div class="planner-warning-list">
          {#each warnings as warning, index}
            <div class="planner-warning-item" data-warning-index={index}>
              {formatWarningMessage(warning)}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</section>

<style>
  .planner-admin-banner {
    margin-bottom: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    font-size: var(--font-base);
  }

  .planner-admin-banner--danger {
    color: var(--red-strong);
    background: var(--red-soft);
    border-color: var(--danger);
  }

  .planner-admin-banner--success {
    color: var(--green-strong);
    background: var(--green-soft);
    border-color: var(--success);
  }

  .planner-admin-banner--warning {
    color: var(--accent-strong);
    background: var(--accent-subtle);
    border-color: var(--accent);
  }

  .planner-admin-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--gap-3);
    margin-bottom: var(--space-4);
  }

  .planner-admin-stat {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: linear-gradient(180deg, var(--surface-1), var(--surface-2));
  }

  .planner-admin-stat-label {
    color: var(--text-muted);
    font-size: var(--font-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .planner-admin-stat strong {
    font-size: 1.8rem;
    line-height: 1;
  }

  .planner-admin-stat small {
    color: var(--text-muted);
    line-height: 1.5;
  }

  .planner-admin-grid {
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    gap: var(--gap-4);
    align-items: start;
  }

  .planner-admin-lists {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  .planner-admin-panel,
  .planner-admin-warning-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    padding: var(--space-4);
  }

  .planner-admin-panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap-3);
    margin-bottom: var(--space-4);
  }

  .planner-admin-panel-head h4 {
    margin: 0;
  }

  .planner-admin-panel-head p {
    margin: var(--space-1) 0 0 0;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .planner-admin-help {
    margin-bottom: var(--space-4);
    padding: var(--space-3);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .planner-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-3);
    margin-bottom: var(--space-4);
  }

  .planner-form-group {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  .planner-form-group--full {
    grid-column: 1 / -1;
  }

  .planner-form-group--toggle {
    align-self: end;
    flex-direction: row;
    align-items: center;
    gap: var(--gap-2);
    min-height: var(--control-height);
  }

  .planner-segmented-control {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }

  .planner-segmented-control button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    padding: 0.45rem 0.8rem;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .planner-segmented-control button.active {
    background: var(--surface-1);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  .planner-rule-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .planner-rule-card {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }

  .planner-rule-copy {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    min-width: 0;
  }

  .planner-rule-title {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex-wrap: wrap;
  }

  .planner-rule-title strong {
    color: var(--text);
  }

  .planner-rule-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    color: var(--text-muted);
    font-size: var(--font-xs);
  }

  .planner-enabled-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.18rem 0.5rem;
    border-radius: var(--radius-full);
    font-size: var(--font-xs);
    font-weight: 600;
  }

  .planner-enabled-pill--on {
    background: var(--green-soft);
    color: var(--green-strong);
  }

  .planner-enabled-pill--off {
    background: var(--surface-3);
    color: var(--text-muted);
  }

  .planner-admin-warning-panel {
    margin-top: var(--space-4);
  }

  .planner-warning-list {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  .planner-warning-item {
    padding: var(--space-3);
    border-radius: var(--radius-lg);
    border: 1px solid var(--accent);
    background: var(--accent-subtle);
    color: var(--accent-strong);
    line-height: 1.5;
  }

  @media (max-width: 1100px) {
    .planner-admin-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .planner-admin-stats,
    .planner-form-grid {
      grid-template-columns: 1fr;
    }

    .planner-rule-card,
    .planner-admin-panel-head {
      flex-direction: column;
    }
  }
</style>
