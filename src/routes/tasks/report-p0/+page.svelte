<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { formatPacific } from '$lib/timezone.js';

  const GENERAL_TYPES = ['CAD', 'Mechanical', 'Electrical', 'Software', 'Other'];
  const YES_NO_OPTIONS = ['yes', 'no'];
  const REPORT_AREAS = ['vision', 'software', 'electrical', 'mechanical', 'brownout'];
  const AREA_LABELS = {
    vision: 'Vision issues',
    software: 'Other software issues',
    electrical: 'Electrical issues',
    mechanical: 'Mechanical issues',
    brownout: 'Brownout issues'
  };

  let loading = true;
  let saving = false;
  let user = null;
  let apiError = '';
  let info = '';

  let context = {
    itemId: '',
    source: 'drive_practice',
    practiceLabel: 'Drive Practice',
    scheduledFor: ''
  };

  let plannerItems = [];
  let allP0Bugs = [];
  let taskSubsystems = [];
  let taskSubsystemMembers = {};
  let taskGeneralCandidates = {};
  let practiceItem = null;

  let formState = {
    practiceFocus: '',
    softwareWorkedOnAutos: '',
    softwareVisionIssues: '',
    softwareOtherIssues: '',
    servicedInPit: '',
    electricalIssues: '',
    mechanicalIssues: '',
    browningOutIssues: '',
    robotLocation: '',
    summaryNotes: ''
  };

  let showP0BugModal = false;
  let showExistingPickerFor = '';
  let currentReportArea = '';
  let p0BugDraft = createP0BugDraft();

  function createP0BugDraft() {
    return {
      title: '',
      description: '',
      scope: 'general',
      general_type: 'Other',
      subsystem_id: '',
      owner_id: user?.id || '',
      needs_manufacturing: false,
      status: 'red'
    };
  }

  function getP0BugOwner(bug) {
    return bug?.owner || bug?.assignee || null;
  }

  function formatPerson(person) {
    if (!person) return 'Unknown';
    return person.full_name || person.email || person.id || 'Unknown';
  }

  function formatReportMoment(value) {
    if (!value) return '';
    try {
      const formatted = formatPacific(value, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      return formatted ? `${formatted} PT` : '';
    } catch {
      return String(value || '');
    }
  }

  function parseContext() {
    if (typeof window === 'undefined') return context;
    const url = new URL(window.location.href);
    return {
      itemId: url.searchParams.get('item_id') || '',
      source: url.searchParams.get('source') || 'drive_practice',
      practiceLabel: url.searchParams.get('practice_label') || 'Drive Practice',
      scheduledFor: url.searchParams.get('scheduled_for') || ''
    };
  }

  async function authHeader() {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function apiRequest(url, method = 'GET', body = null) {
    const headers = {
      ...(await authHeader())
    };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function resolvePracticeItem() {
    if (context.itemId) {
      return plannerItems.find((item) => item.id === context.itemId) || null;
    }
    const targetTime = context.scheduledFor ? new Date(context.scheduledFor).toISOString() : '';
    return plannerItems.find((item) =>
      item?.category === 'drive_practice' &&
      String(item?.title || '') === String(context.practiceLabel || '') &&
      String(item?.scheduled_end_at || '') === targetTime
    ) || null;
  }

  function buildPracticeSummary() {
    const lines = [
      `Drive practice: ${context.practiceLabel}`
    ];
    if (context.scheduledFor) lines.push(`Ended: ${formatReportMoment(context.scheduledFor)}`);
    if (formState.practiceFocus) lines.push(`Practice focus: ${formState.practiceFocus}`);
    if (formState.softwareWorkedOnAutos) lines.push(`Worked on autos: ${formState.softwareWorkedOnAutos}`);
    if (formState.servicedInPit) lines.push(`Serviced in pit: ${formState.servicedInPit}`);
    if (formState.robotLocation) lines.push(`Robot location: ${formState.robotLocation}`);
    if (formState.summaryNotes.trim()) lines.push(`General notes: ${formState.summaryNotes.trim()}`);
    return lines.join('\n');
  }

  function defaultGeneralTypeForArea(area) {
    if (area === 'vision' || area === 'software') return 'Software';
    if (area === 'electrical' || area === 'brownout') return 'Electrical';
    if (area === 'mechanical') return 'Mechanical';
    return 'Other';
  }

  function defaultTitleForArea(area) {
    if (area === 'vision') return 'Vision issue during drive practice';
    if (area === 'software') return 'Software issue during drive practice';
    if (area === 'electrical') return 'Electrical issue during drive practice';
    if (area === 'mechanical') return 'Mechanical issue during drive practice';
    if (area === 'brownout') return 'Brownout issue during drive practice';
    return 'P0 bug during drive practice';
  }

  function defaultPromptForArea(area) {
    if (area === 'vision') return 'What happened with vision?';
    if (area === 'software') return 'What other software issue happened?';
    if (area === 'electrical') return 'What electrical issue happened?';
    if (area === 'mechanical') return 'What mechanical issue happened?';
    if (area === 'brownout') return 'What caused the brownout or when did it happen?';
    return 'What happened?';
  }

  function p0BugOwnerOptions() {
    const base = p0BugDraft.scope === 'subsystem'
      ? (taskSubsystemMembers?.[p0BugDraft.subsystem_id] || [])
      : (taskGeneralCandidates?.[p0BugDraft.general_type] || []);
    if (!user?.id) return base;
    if (base.some((member) => member.id === user.id)) return base;
    return [{ id: user.id, full_name: user.full_name, email: user.email }, ...base];
  }

  function syncP0BugOwnerSelection() {
    const options = p0BugOwnerOptions();
    if (p0BugDraft.scope === 'subsystem' && !p0BugDraft.subsystem_id && taskSubsystems.length > 0) {
      p0BugDraft = { ...p0BugDraft, subsystem_id: taskSubsystems[0].id };
      return;
    }
    if (options.length > 0 && !options.some((opt) => opt.id === p0BugDraft.owner_id)) {
      p0BugDraft = { ...p0BugDraft, owner_id: options[0].id };
    }
  }

  function openCreateP0BugModal(area) {
    currentReportArea = area;
    showExistingPickerFor = '';
    p0BugDraft = {
      ...createP0BugDraft(),
      title: defaultTitleForArea(area),
      description: `${buildPracticeSummary()}\n\n${defaultPromptForArea(area)}\n- `,
      general_type: defaultGeneralTypeForArea(area)
    };
    showP0BugModal = true;
  }

  function closeP0BugModal() {
    showP0BugModal = false;
    currentReportArea = '';
    p0BugDraft = createP0BugDraft();
  }

  async function linkBugToPractice(taskIds, area) {
    if (!practiceItem?.id || !taskIds.length) return;
    await apiRequest('/api/tasks', 'POST', {
      action: 'link-drive-practice-bugs',
      planner_item_id: practiceItem.id,
      report_area: area,
      task_ids: taskIds
    });
  }

  async function saveP0Bug() {
    saving = true;
    apiError = '';
    try {
      const created = await apiRequest('/api/tasks', 'POST', {
        action: 'create',
        ...p0BugDraft
      });
      const createdTaskId = String(created?.created_task_id || '').trim();
      if (createdTaskId && currentReportArea) {
        await linkBugToPractice([createdTaskId], currentReportArea);
      }
      await loadData();
      info = 'P0 bug created and linked to this drive practice.';
      closeP0BugModal();
    } catch (error) {
      apiError = error?.message || 'Failed to create P0 bug.';
    } finally {
      saving = false;
    }
  }

  function bugsForArea(area) {
    return allP0Bugs.filter((bug) =>
      (bug?.reported_drive_practices || []).some((entry) => entry.id === practiceItem?.id && entry.report_area === area)
    );
  }

  function availableExistingBugs(area) {
    const selected = new Set(bugsForArea(area).map((bug) => bug.id));
    return allP0Bugs.filter((bug) => !selected.has(bug.id));
  }

  async function tagExistingBug(bugId, area) {
    apiError = '';
    try {
      await linkBugToPractice([bugId], area);
      await loadData();
      info = 'Existing P0 bug linked to this drive practice.';
      showExistingPickerFor = '';
    } catch (error) {
      apiError = error?.message || 'Failed to tag existing P0 bug.';
    }
  }

  function shouldShowSoftwareBranch() {
    return formState.practiceFocus === 'Software';
  }

  function shouldShowPitIssues() {
    return formState.servicedInPit === 'yes' || formState.practiceFocus === 'Drive Team';
  }

  async function loadData() {
    const [plannerPayload, tasksPayload] = await Promise.all([
      apiRequest('/api/planner'),
      apiRequest('/api/tasks')
    ]);
    plannerItems = plannerPayload?.data?.items || [];
    allP0Bugs = plannerPayload?.data?.p0_bugs || [];
    taskSubsystems = tasksPayload?.data?.subsystems || [];
    taskSubsystemMembers = tasksPayload?.data?.subsystem_members || {};
    taskGeneralCandidates = tasksPayload?.data?.general_candidates || {};
    practiceItem = resolvePracticeItem();
    if (!context.itemId && practiceItem?.id) context = { ...context, itemId: practiceItem.id };
  }

  onMount(async () => {
    const unsub = userStore.subscribe((value) => {
      user = value;
    });
    context = parseContext();
    await loadUserFromUUID(supabase);
    const { data } = await supabase.auth.getSession();
    if (!data?.session?.user) {
      goto('/');
      return () => unsub?.();
    }
    try {
      await loadData();
      syncP0BugOwnerSelection();
    } catch (error) {
      apiError = error?.message || 'Failed to load drive practice report.';
    } finally {
      loading = false;
    }
    return () => unsub?.();
  });

  $: if (showP0BugModal) {
    syncP0BugOwnerSelection();
  }
</script>

<svelte:head>
  <title>Drive Practice Report - Spartans Hub</title>
</svelte:head>

<div class="container report-page">
  <section class="section-card hero-card">
    <p class="eyebrow">Drive Practice Report</p>
    <h1>{context.practiceLabel}</h1>
    {#if context.scheduledFor}
      <p class="hero-copy">Ended {formatReportMoment(context.scheduledFor)}</p>
    {/if}
  </section>

  {#if apiError}
    <div class="feedback error">{apiError}</div>
  {/if}
  {#if info}
    <div class="feedback success">{info}</div>
  {/if}

  {#if loading}
    <section class="section-card"><p>Loading report...</p></section>
  {:else}
    <section class="section-card report-card">
      <div class="question-grid">
        <label class="form-group">
          <span class="form-label">What kind of practice was this?</span>
          <select class="form-select" bind:value={formState.practiceFocus}>
            <option value="">Select one</option>
            <option value="Software">Software-focused</option>
            <option value="Drive Team">Drive team practice</option>
          </select>
        </label>

        {#if shouldShowSoftwareBranch()}
          <label class="form-group">
            <span class="form-label">Did they work on autos?</span>
            <select class="form-select" bind:value={formState.softwareWorkedOnAutos}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>

      {#if shouldShowSoftwareBranch()}
        <section class="issue-section">
          <div class="issue-head">
            <div>
              <h2>Vision</h2>
              <p>Were there issues with vision?</p>
            </div>
            <select class="form-select issue-toggle" bind:value={formState.softwareVisionIssues}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </div>
          <div class="tag-list">
            {#each bugsForArea('vision') as bug (bug.id)}
              <span class="chip">{bug.title}</span>
            {/each}
          </div>
          {#if formState.softwareVisionIssues === 'yes'}
            <div class="issue-actions">
              <button class="btn btn-primary btn-sm" type="button" on:click={() => openCreateP0BugModal('vision')}>Report P0 Bug</button>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => showExistingPickerFor = showExistingPickerFor === 'vision' ? '' : 'vision'}>Tag Existing P0 Bug</button>
            </div>
            {#if showExistingPickerFor === 'vision'}
              <div class="existing-picker">
                {#each availableExistingBugs('vision') as bug (bug.id)}
                  <button class="picker-row" type="button" on:click={() => tagExistingBug(bug.id, 'vision')}>
                    <strong>{bug.title}</strong>
                    <span>{bug.general_type || 'General'} • {formatPerson(getP0BugOwner(bug))}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </section>

        <section class="issue-section">
          <div class="issue-head">
            <div>
              <h2>Other Software</h2>
              <p>Were there other software issues?</p>
            </div>
            <select class="form-select issue-toggle" bind:value={formState.softwareOtherIssues}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </div>
          <div class="tag-list">
            {#each bugsForArea('software') as bug (bug.id)}
              <span class="chip">{bug.title}</span>
            {/each}
          </div>
          {#if formState.softwareOtherIssues === 'yes'}
            <div class="issue-actions">
              <button class="btn btn-primary btn-sm" type="button" on:click={() => openCreateP0BugModal('software')}>Report P0 Bug</button>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => showExistingPickerFor = showExistingPickerFor === 'software' ? '' : 'software'}>Tag Existing P0 Bug</button>
            </div>
            {#if showExistingPickerFor === 'software'}
              <div class="existing-picker">
                {#each availableExistingBugs('software') as bug (bug.id)}
                  <button class="picker-row" type="button" on:click={() => tagExistingBug(bug.id, 'software')}>
                    <strong>{bug.title}</strong>
                    <span>{bug.general_type || 'General'} • {formatPerson(getP0BugOwner(bug))}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </section>

        <div class="question-grid">
          <label class="form-group">
            <span class="form-label">Did they have to service the robot in the pit?</span>
            <select class="form-select" bind:value={formState.servicedInPit}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </label>
        </div>
      {/if}

      {#if shouldShowPitIssues()}
        <section class="issue-section">
          <div class="issue-head">
            <div>
              <h2>Electrical</h2>
              <p>Were there electrical issues?</p>
            </div>
            <select class="form-select issue-toggle" bind:value={formState.electricalIssues}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </div>
          <div class="tag-list">
            {#each bugsForArea('electrical') as bug (bug.id)}
              <span class="chip">{bug.title}</span>
            {/each}
          </div>
          {#if formState.electricalIssues === 'yes'}
            <div class="issue-actions">
              <button class="btn btn-primary btn-sm" type="button" on:click={() => openCreateP0BugModal('electrical')}>Report P0 Bug</button>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => showExistingPickerFor = showExistingPickerFor === 'electrical' ? '' : 'electrical'}>Tag Existing P0 Bug</button>
            </div>
            {#if showExistingPickerFor === 'electrical'}
              <div class="existing-picker">
                {#each availableExistingBugs('electrical') as bug (bug.id)}
                  <button class="picker-row" type="button" on:click={() => tagExistingBug(bug.id, 'electrical')}>
                    <strong>{bug.title}</strong>
                    <span>{bug.general_type || 'General'} • {formatPerson(getP0BugOwner(bug))}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </section>

        <section class="issue-section">
          <div class="issue-head">
            <div>
              <h2>Mechanical</h2>
              <p>Were there mechanical issues?</p>
            </div>
            <select class="form-select issue-toggle" bind:value={formState.mechanicalIssues}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </div>
          <div class="tag-list">
            {#each bugsForArea('mechanical') as bug (bug.id)}
              <span class="chip">{bug.title}</span>
            {/each}
          </div>
          {#if formState.mechanicalIssues === 'yes'}
            <div class="issue-actions">
              <button class="btn btn-primary btn-sm" type="button" on:click={() => openCreateP0BugModal('mechanical')}>Report P0 Bug</button>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => showExistingPickerFor = showExistingPickerFor === 'mechanical' ? '' : 'mechanical'}>Tag Existing P0 Bug</button>
            </div>
            {#if showExistingPickerFor === 'mechanical'}
              <div class="existing-picker">
                {#each availableExistingBugs('mechanical') as bug (bug.id)}
                  <button class="picker-row" type="button" on:click={() => tagExistingBug(bug.id, 'mechanical')}>
                    <strong>{bug.title}</strong>
                    <span>{bug.general_type || 'General'} • {formatPerson(getP0BugOwner(bug))}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </section>
      {/if}

      {#if formState.practiceFocus === 'Drive Team'}
        <section class="issue-section">
          <div class="issue-head">
            <div>
              <h2>Brownout</h2>
              <p>Were there issues with browning out?</p>
            </div>
            <select class="form-select issue-toggle" bind:value={formState.browningOutIssues}>
              <option value="">Select one</option>
              {#each YES_NO_OPTIONS as value}
                <option value={value}>{value === 'yes' ? 'Yes' : 'No'}</option>
              {/each}
            </select>
          </div>
          <div class="tag-list">
            {#each bugsForArea('brownout') as bug (bug.id)}
              <span class="chip">{bug.title}</span>
            {/each}
          </div>
          {#if formState.browningOutIssues === 'yes'}
            <div class="issue-actions">
              <button class="btn btn-primary btn-sm" type="button" on:click={() => openCreateP0BugModal('brownout')}>Report P0 Bug</button>
              <button class="btn btn-secondary btn-sm" type="button" on:click={() => showExistingPickerFor = showExistingPickerFor === 'brownout' ? '' : 'brownout'}>Tag Existing P0 Bug</button>
            </div>
            {#if showExistingPickerFor === 'brownout'}
              <div class="existing-picker">
                {#each availableExistingBugs('brownout') as bug (bug.id)}
                  <button class="picker-row" type="button" on:click={() => tagExistingBug(bug.id, 'brownout')}>
                    <strong>{bug.title}</strong>
                    <span>{bug.general_type || 'General'} • {formatPerson(getP0BugOwner(bug))}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </section>
      {/if}

      <div class="question-grid">
        <label class="form-group">
          <span class="form-label">Where is the robot now?</span>
          <select class="form-select" bind:value={formState.robotLocation}>
            <option value="">Select one</option>
            <option value="Lab">Lab</option>
            <option value="Kohls">Kohls</option>
          </select>
        </label>
        <label class="form-group">
          <span class="form-label">Anything else the next person should know?</span>
          <textarea class="form-input" rows="4" bind:value={formState.summaryNotes}></textarea>
        </label>
      </div>
    </section>
  {/if}

  {#if showP0BugModal}
    <div class="modal-backdrop" role="button" tabindex="0" on:click|self={closeP0BugModal}>
      <section class="modal modal--wide planner-modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <p class="eyebrow">P0 Bug</p>
            <h2>Report {AREA_LABELS[currentReportArea] || 'Issue'}</h2>
          </div>
          <button class="modal-close-button" type="button" on:click={closeP0BugModal}>x</button>
        </div>
        <div class="modal-body">
          <div class="question-grid">
            <label class="form-group">
              <span class="form-label">Bug Title</span>
              <input class="form-input" bind:value={p0BugDraft.title} />
            </label>
            <label class="form-group">
              <span class="form-label">Type Mode</span>
              <select class="form-select" bind:value={p0BugDraft.scope} on:change={syncP0BugOwnerSelection}>
                <option value="general">General Type</option>
                <option value="subsystem">Subsystem</option>
              </select>
            </label>
            {#if p0BugDraft.scope === 'general'}
              <label class="form-group">
                <span class="form-label">General Type</span>
                <select class="form-select" bind:value={p0BugDraft.general_type} on:change={syncP0BugOwnerSelection}>
                  {#each GENERAL_TYPES as type}
                    <option value={type}>{type}</option>
                  {/each}
                </select>
              </label>
            {:else}
              <label class="form-group">
                <span class="form-label">Subsystem</span>
                <select class="form-select" bind:value={p0BugDraft.subsystem_id} on:change={syncP0BugOwnerSelection}>
                  {#each taskSubsystems as subsystem}
                    <option value={subsystem.id}>{subsystem.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            <label class="form-group">
              <span class="form-label">Owner</span>
              <select class="form-select" bind:value={p0BugDraft.owner_id}>
                {#each p0BugOwnerOptions() as person}
                  <option value={person.id}>{formatPerson(person)}</option>
                {/each}
              </select>
            </label>
            <label class="form-group">
              <span class="form-label">Status</span>
              <select class="form-select" bind:value={p0BugDraft.status}>
                <option value="red">Red</option>
                <option value="yellow">Yellow</option>
                <option value="green">Green</option>
                <option value="completed">Completed</option>
              </select>
            </label>
          </div>
          <label class="form-group">
            <span class="form-label">Description</span>
            <textarea class="form-input" rows="8" bind:value={p0BugDraft.description}></textarea>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" type="button" on:click={closeP0BugModal}>Cancel</button>
          <button class="btn btn-primary btn-sm" type="button" disabled={saving || !p0BugDraft.title.trim() || !p0BugDraft.owner_id} on:click={saveP0Bug}>
            {saving ? 'Saving...' : 'Create P0 Bug'}
          </button>
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .report-page { padding-top: var(--space-6); padding-bottom: var(--space-7); display: grid; gap: var(--gap-4); max-width: 1040px; }
  /* Was a hardcoded navy -> teal gradient with white ink: a card that
     ignored the theme and went dark on a light page. Uses the app's own
     raised surface instead. */
  .hero-card { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  .eyebrow { margin: 0 0 var(--space-2); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.74; }
  .hero-card h1, .issue-head h2 { margin: 0; }
  .hero-copy { margin: var(--space-2) 0 0; }
  .feedback { border-radius: var(--radius-lg); border: 1px solid var(--border); padding: var(--space-3) var(--space-4); font-size: var(--font-xs); }
  .feedback.error { background: var(--red-soft); border-color: var(--red-base); color: var(--red-strong); }
  .feedback.success { background: var(--green-soft); border-color: var(--green-base); color: var(--green-strong); }
  .report-card { display: grid; gap: var(--gap-4); }
  .question-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap-3); }
  .issue-section { border: 1px solid var(--border); border-radius: var(--radius-xl); padding: var(--space-4); display: grid; gap: var(--gap-3); background: var(--surface-1); }
  .issue-head { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: var(--gap-3); align-items: end; }
  .issue-head p { margin: var(--space-1) 0 0; color: var(--text-muted); }
  .issue-toggle { max-width: 180px; justify-self: end; }
  .issue-actions { display: flex; gap: var(--gap-2); flex-wrap: wrap; }
  .tag-list { display: flex; gap: var(--gap-2); flex-wrap: wrap; min-height: 1.5rem; }
  .chip { display: inline-flex; align-items: center; padding: 0.2rem 0.6rem; border-radius: 999px; background: var(--brand-gold-soft); border: 1px solid var(--brand-gold-base); }
  .existing-picker { display: grid; gap: var(--gap-2); }
  .picker-row { display: grid; gap: 0.25rem; text-align: left; padding: var(--space-3); border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--surface-2); }
  .modal-body { display: grid; gap: var(--gap-3); }
  @media (max-width: 720px) {
    .question-grid, .issue-head { grid-template-columns: 1fr; }
    .issue-toggle { justify-self: stretch; max-width: none; }
  }
</style>
