<script>
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { hasPermission, PURCHASING_ROLES } from '$lib/permissions.js';
  import { toastActions } from '$lib/toast.js';
  import { Plus, Edit, Trash2, DollarSign, Calendar, Target, Folder } from 'lucide-svelte';
  import { userStore } from '$lib/stores/user.js';
  import { formatPacificDate } from '$lib/timezone.js';
  import { calculateBudgetSpent } from '$lib/budget.js';

  export let subsystems = []; // Passed from parent or loaded here if needed

  let budgets = [];
  let loading = false;
  let showModal = false;
  let editingBudget = null;
  let saving = false;

  // Form State
  let form = {
    name: '',
    category: '',
    scope_type: 'overall', // overall, project, subsystem, build, build_group
    scope_value: '',
    amount: 0,
    start_date: '',
    end_date: '',
    notes: ''
  };

  const SCOPE_TYPES = [
    { 
      value: 'overall', 
      label: 'All Purchases', 
      description: 'Tracks all purchases across the entire organization',
      needsValue: false
    },
    { 
      value: 'project', 
      label: 'Specific Project/Category', 
      description: 'Tracks purchases with a specific Project ID (e.g., "9584 misc", "Competition")',
      needsValue: true,
      valueLabel: 'Project ID'
    },
    { 
      value: 'subsystem', 
      label: 'Subsystem', 
      description: 'Tracks purchases for a specific subsystem',
      needsValue: true,
      valueLabel: 'Subsystem'
    },
    { 
      value: 'build', 
      label: 'Specific Build', 
      description: 'Tracks purchases for a specific build (e.g., "Drivetrain-v2")',
      needsValue: true,
      valueLabel: 'Build/Release Name'
    },
    { 
      value: 'build_group', 
      label: 'Build Group', 
      description: 'Tracks all builds grouped under a project container (created by dragging builds together)',
      needsValue: true,
      valueLabel: 'Build Group'
    }
  ];

  // Common project IDs that users can select from
  const COMMON_PROJECT_IDS = [
    '9584 misc',
    'Competition',
    'Outreach + Fundraising',
    'Mechanical Supply',
    'Mechanical Consumable',
    'Electrical Supply',
    'Electrical Consumable',
    'Lab Supply',
    'Lab Consumable',
    'Software Supply',
    'Software Consumable',
    'Manufacturing Stock',
    'Other'
  ];

  // Build options for build/build_group scope types
  let buildOptions = [];
  // Build groups (project_ids from builds table)
  let buildGroupOptions = [];

  $: selectedScopeType = SCOPE_TYPES.find(t => t.value === form.scope_type);

  async function loadBuildOptionsForBudget() {
    try {
      const { data, error } = await supabase
        .from('builds')
        .select('id, release_name, project_id, subsystems(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      
      // Individual build options
      buildOptions = (data || []).map(b => {
        const label = `${b.subsystems?.name || 'Project'}-${b.release_name || ''}`;
        return { id: b.id, label };
      });
      
      // Extract unique project_ids (build groups) - exclude null and '__NO_PROJECT__'
      const projectIds = [...new Set((data || [])
        .map(b => b.project_id)
        .filter(pid => pid && pid !== '__NO_PROJECT__'))];
      buildGroupOptions = projectIds.map(pid => ({ id: pid, label: pid }));
    } catch (e) {
      console.warn('Failed to load builds', e);
      buildOptions = [];
      buildGroupOptions = [];
    }
  }

  onMount(async () => {
    // If subsystems not passed, load them
    if (!subsystems || subsystems.length === 0) {
      await loadSubsystems();
    }
    await Promise.all([loadBudgets(), loadBuildOptionsForBudget()]);
  });

  async function loadSubsystems() {
    const { data } = await supabase.from('subsystems').select('id, name, frc_team').order('name');
    subsystems = data || [];
  }

  async function loadBudgets() {
    loading = true;
    try {
      const { data, error } = await supabase
        .from('purchasing_budgets')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      // Load purchasing data to calculate spending
      const { data: purchases, error: purchaseErr } = await supabase
        .from('purchasing')
        .select('*');
      
      if (purchaseErr) throw purchaseErr;
      
      // Calculate spending for each budget
      budgets = (data || []).map(budget => ({
        ...budget,
        spent: calculateBudgetSpent(budget, purchases || [])
      }));
    } catch (err) {
      console.error('Failed to load budgets', err);
      toastActions.show('Failed to load budgets');
    } finally {
      loading = false;
    }
  }

  function openCreateModal() {
    editingBudget = null;
    form = {
      name: '',
      category: '',
      scope_type: 'project',
      scope_value: '',
      amount: 0,
      start_date: new Date().toISOString().split('T')[0],
      end_date: '',
      notes: ''
    };
    showModal = true;
  }

  function openEditModal(budget) {
    editingBudget = budget;
    form = {
      name: budget.name,
      category: budget.category || '',
      scope_type: budget.scope_type,
      scope_value: budget.scope_value || '',
      amount: budget.amount,
      start_date: budget.start_date || '',
      end_date: budget.end_date || '',
      notes: budget.notes || ''
    };
    showModal = true;
  }

  async function saveBudget() {
    if (!form.name || form.amount < 0 || !form.start_date) {
      toastActions.show('Please fill in required fields (Name, Amount >= 0, Start Date)');
      return;
    }

    const scopeType = SCOPE_TYPES.find(t => t.value === form.scope_type);
    if (scopeType?.needsValue && !form.scope_value) {
      toastActions.show(`Please specify the ${scopeType.valueLabel}`);
      return;
    }
    
    saving = true;
    try {
      let finalScopeValue = null;
      if (form.scope_type !== 'overall') {
        finalScopeValue = form.scope_value.trim();
      }

      const payload = {
        name: form.name.trim(),
        category: form.category ? form.category.trim() : null,
        scope_type: form.scope_type,
        scope_value: finalScopeValue,
        amount: form.amount,
        start_date: form.start_date,
        end_date: form.end_date || null,
        notes: form.notes ? form.notes.trim() : null,
        updated_at: new Date().toISOString()
      };

      if (editingBudget) {
        const { error } = await supabase
          .from('purchasing_budgets')
          .update(payload)
          .eq('id', editingBudget.id);
        if (error) throw error;
        toastActions.show('Budget updated');
      } else {
        payload.created_by = $userStore?.id;
        const { error } = await supabase
          .from('purchasing_budgets')
          .insert([payload]);
        if (error) throw error;
        toastActions.show('Budget created');
      }

      showModal = false;
      editingBudget = null;
      await loadBudgets();
    } catch (err) {
      console.error('Failed to save budget', err);
      toastActions.show('Failed to save budget');
    } finally {
      saving = false;
    }
  }

  async function deleteBudget(budget) {
    if (!await requestConfirmation({ title: 'Delete budget', message: `Delete budget "${budget.name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
    try {
      const { error } = await supabase.from('purchasing_budgets').delete().eq('id', budget.id);
      if (error) throw error;
      toastActions.show('Budget deleted');
      await loadBudgets();
    } catch (err) {
      console.error('Failed to delete budget', err);
      toastActions.show('Failed to delete budget');
    }
  }

  function getScopeDisplay(b) {
    if (b.scope_type === 'overall') return 'All Purchases';
    if (b.scope_type === 'project') return b.scope_value;
    if (b.scope_type === 'subsystem') {
      const sub = subsystems.find(s => s.id === b.scope_value);
      return sub ? sub.name : b.scope_value;
    }
    if (b.scope_type === 'build') return b.scope_value;
    if (b.scope_type === 'build_group') return `${b.scope_value}*`;
    return b.scope_type;
  }
</script>

<div class="budgets-container">
  <div class="header-actions">
    <h3>Budget Management</h3>
    <button class="btn btn-primary" on:click={openCreateModal}>
      <Plus size={16} /> New Budget
    </button>
  </div>

  {#if loading}
    <div class="loading">Loading budgets...</div>
  {:else if budgets.length === 0}
    <div class="empty-state">No budgets found. Create one to get started.</div>
  {:else}
    <div class="table-container">
      <table class="table">
        <thead>
          <tr>
            <th>Budget Name</th>
            <th>Tracks</th>
            <th>Amount</th>
            <th>Spent</th>
            <th>Remaining</th>
            <th>Period</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each budgets as budget}
            {@const remaining = budget.amount - budget.spent}
            {@const percentUsed = Math.round((budget.spent / budget.amount) * 100)}
            <tr>
              <td>
                <div class="fw-bold">{budget.name}</div>
                {#if budget.category}<small class="text-muted">{budget.category}</small>{/if}
                {#if budget.notes}<div class="budget-notes">{budget.notes}</div>{/if}
              </td>
              <td>
                <div class="scope-display">
                  <span class="badge scope-{budget.scope_type}">
                    {#if budget.scope_type === 'overall'}<Target size={12}/>{/if}
                    {#if budget.scope_type === 'project' || budget.scope_type === 'subsystem'}<Folder size={12}/>{/if}
                    {getScopeDisplay(budget)}
                  </span>
                </div>
              </td>
              <td class="font-mono">${Number(budget.amount).toLocaleString()}</td>
              <td>
                <div class="spending-cell">
                  <div class="spending-bar">
                    <div 
                      class="spending-fill" 
                      class:over-budget={budget.spent > budget.amount}
                      style="width: {Math.min((budget.spent / budget.amount) * 100, 100)}%"
                    ></div>
                  </div>
                  <div class="spending-text" class:over-budget={budget.spent > budget.amount}>
                    ${budget.spent.toLocaleString(undefined, {maximumFractionDigits: 0})}
                    <span class="spending-percent">({percentUsed}%)</span>
                  </div>
                </div>
              </td>
              <td class="font-mono" class:text-danger={remaining < 0} class:text-success={remaining > 0}>
                ${remaining.toLocaleString(undefined, {maximumFractionDigits: 0})}
              </td>
              <td>
                <div class="date-range">
                  <span>{formatPacificDate(budget.start_date)}</span>
                  {#if budget.end_date}
                    <span class="arrow">→</span>
                    <span>{formatPacificDate(budget.end_date)}</span>
                  {:else}
                    <span class="text-muted"> (ongoing)</span>
                  {/if}
                </div>
              </td>
              <td>
                <div class="actions">
                  <button class="btn-icon" on:click={() => openEditModal(budget)} title="Edit">
                    <Edit size={16} />
                  </button>
                  <button class="btn-icon danger" on:click={() => deleteBudget(budget)} title="Delete">
                    <Trash2 size={16} />
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showModal}
  <div class="modal-backdrop" on:click={() => showModal = false}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">
        <h3>{editingBudget ? 'Edit Budget' : 'Create Budget'}</h3>
        <button class="btn-close" on:click={() => showModal = false}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Budget Name*</label>
          <input type="text" class="form-control" bind:value={form.name} placeholder="e.g., 2025 Miscellaneous Purchases" />
          <small class="help-text">Give this budget a descriptive name</small>
        </div>

        <div class="form-group">
          <label>What should this budget track?*</label>
          <select class="form-select" bind:value={form.scope_type}>
            {#each SCOPE_TYPES as type}
              <option value={type.value}>{type.label}</option>
            {/each}
          </select>
          {#if selectedScopeType}
            <small class="help-text">{selectedScopeType.description}</small>
          {/if}
        </div>

        {#if selectedScopeType?.needsValue}
          <div class="form-group scope-value-group">
            {#if form.scope_type === 'subsystem'}
              <label>{selectedScopeType.valueLabel}*</label>
              <select class="form-select" bind:value={form.scope_value}>
                <option value="" disabled>Select Subsystem</option>
                {#each subsystems as sub}
                  <option value={sub.id}>{sub.name} ({sub.frc_team || 'General'})</option>
                {/each}
              </select>
            {:else if form.scope_type === 'project'}
              <label>{selectedScopeType.valueLabel}*</label>
              <select class="form-select" bind:value={form.scope_value}>
                <option value="" disabled>Select Project/Category</option>
                {#each COMMON_PROJECT_IDS as pid}
                  <option value={pid}>{pid}</option>
                {/each}
              </select>
              <small class="help-text">Select the Project ID to track. This must match exactly what you select when creating purchases.</small>
            {:else if form.scope_type === 'build'}
              <label>{selectedScopeType.valueLabel}*</label>
              <select class="form-select" bind:value={form.scope_value}>
                <option value="" disabled>Select Build</option>
                {#each buildOptions as build}
                  <option value={build.label}>{build.label}</option>
                {/each}
              </select>
              <small class="help-text">Select a specific build to track purchases for</small>
            {:else if form.scope_type === 'build_group'}
              <label>{selectedScopeType.valueLabel}*</label>
              <select class="form-select" bind:value={form.scope_value}>
                <option value="" disabled>Select Build Group</option>
                {#each buildGroupOptions as group}
                  <option value={group.id}>{group.label}</option>
                {/each}
              </select>
              {#if buildGroupOptions.length === 0}
                <small class="help-text text-warning">No build groups found. Create build groups on the Build page by dragging builds together.</small>
              {:else}
                <small class="help-text">Tracks all builds in the selected project container</small>
              {/if}
            {/if}
          </div>
        {/if}

        <div class="form-group">
          <label>Budget Amount ($)*</label>
          <input type="number" step="0.01" min="0" class="form-control" bind:value={form.amount} placeholder="0.00" />
          <small class="help-text">Total amount allocated for this budget</small>
        </div>

        <div class="row">
          <div class="col">
            <div class="form-group">
              <label>Start Date*</label>
              <input type="date" class="form-control" bind:value={form.start_date} />
            </div>
          </div>
          <div class="col">
             <div class="form-group">
              <label>End Date (Optional)</label>
              <input type="date" class="form-control" bind:value={form.end_date} />
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Category (Optional)</label>
          <select class="form-select" bind:value={form.category}>
            <option value="">None</option>
            <option value="Team 9584">Team 9584</option>
            <option value="Team 971">Team 971</option>
            <option value="Robot Build">Robot Build</option>
            <option value="Lab Supplies">Lab Supplies</option>
            <option value="Competition">Competition</option>
            <option value="Outreach">Outreach</option>
            <option value="Manufacturing">Manufacturing</option>
            <option value="General">General</option>
          </select>
          <small class="help-text">Optional label for organizing budgets (doesn't affect what purchases are tracked)</small>
        </div>

        <div class="form-group">
          <label>Notes (Optional)</label>
          <textarea class="form-control" rows="2" bind:value={form.notes} placeholder="Additional details about this budget..."></textarea>
        </div>

        {#if form.scope_type === 'project' && form.scope_value}
          <div class="info-box">
            <strong>This budget will track:</strong> All purchases where the Project ID is exactly "<strong>{form.scope_value}</strong>"
          </div>
        {:else if form.scope_type === 'overall'}
          <div class="info-box">
            <strong>This budget will track:</strong> All purchases across the entire organization (except items marked "Budget Exempt")
          </div>
        {:else if form.scope_type === 'build_group' && form.scope_value}
          <div class="info-box">
            <strong>This budget will track:</strong> All builds in the "<strong>{form.scope_value}</strong>" build group
          </div>
        {:else if form.scope_type === 'build' && form.scope_value}
          <div class="info-box">
            <strong>This budget will track:</strong> The specific build "<strong>{form.scope_value}</strong>"
          </div>
        {:else if form.scope_type === 'subsystem' && form.scope_value}
          <div class="info-box">
            <strong>This budget will track:</strong> All builds for the selected subsystem
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" on:click={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary" on:click={saveBudget} disabled={saving}>
          {saving ? 'Saving...' : 'Save Budget'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .header-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .table-container {
    overflow-x: auto;
    background: var(--surface-1);
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .table {
    width: 100%;
    border-collapse: collapse;
  }
  .table th, .table td {
    padding: 0.75rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .table th {
    background: var(--surface-2);
    font-weight: 500;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    color: var(--text-2);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    font-weight: 600;
    white-space: nowrap;
  }
  .scope-overall { background: var(--blue-soft); color: var(--blue-strong); border: 1px solid var(--blue-base); }
  .scope-project { background: var(--purple-soft); color: var(--purple-strong); border: 1px solid var(--purple-base); }
  .scope-subsystem { background: var(--green-soft); color: var(--green-strong); border: 1px solid var(--green-base); }
  .scope-build { background: var(--brand-gold-soft); color: var(--brand-gold-strong); border: 1px solid var(--brand-gold-base); }
  .scope-build_group { background: var(--red-soft); color: var(--red-strong); border: 1px solid var(--red-base); }
  
  .scope-display {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .font-mono { font-family: monospace; font-weight: 600; }
  .fw-bold { font-weight: 600; }
  .text-muted { color: var(--text-2); font-size: 0.85em; }
  .text-danger { color: var(--red-strong); }
  .text-success { color: var(--green-strong); }
  
  .budget-notes {
    font-size: 0.8em;
    color: var(--text-2);
    margin-top: 0.25rem;
    font-style: italic;
  }
  
  .date-range {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9em;
  }
  .arrow { color: var(--text-2); }
  
  .spending-cell {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 140px;
  }
  .spending-bar {
    width: 100%;
    height: 8px;
    background: var(--surface-2);
    border-radius: 4px;
    overflow: hidden;
  }
  .spending-fill {
    height: 100%;
    background: var(--brand-gold-strong);
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .spending-fill.over-budget {
    background: var(--red-strong);
  }
  .spending-text {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
  }
  .spending-text.over-budget {
    color: var(--red-strong);
    font-weight: 600;
  }
  .spending-percent {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }
  
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-2);
    padding: 0.25rem;
    border-radius: 0.25rem;
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text); }
  .btn-icon.danger:hover { background: #fee2e2; color: #dc2626; }
  
  .modal-backdrop {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    padding: 1rem;
  }
  .modal {
    background: var(--surface-1);
    border-radius: 4px;
    width: 100%;
    max-width: 700px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    padding: 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-header h3 {
    margin: 0;
    font-size: 1.25rem;
  }
  .modal-body { 
    padding: 1.5rem;
  }
  .modal-footer {
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    background: var(--surface-0);
  }
  .btn-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text-2);
  }
  .btn-close:hover {
    color: var(--text);
  }
  .form-group { 
    margin-bottom: 1.25rem; 
  }
  .form-group label { 
    display: block; 
    margin-bottom: 0.5rem; 
    font-weight: 600; 
    font-size: 0.9rem;
    color: var(--text);
  }
  .help-text {
    display: block;
    margin-top: 0.375rem;
    font-size: 0.8rem;
    color: var(--text-2);
    line-height: 1.4;
  }
  .form-control, .form-select {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface-0);
    color: var(--text);
    font-size: 0.95rem;
    transition: border-color 0.15s ease;
  }
  .form-control:focus, .form-select:focus {
    outline: none;
    border-color: var(--brand-gold-base);
    box-shadow: 0 0 0 3px var(--brand-gold-soft);
  }
  .scope-value-group {
    background: var(--surface-0);
    padding: 1rem;
    border-radius: 0.5rem;
    border: 2px solid var(--brand-gold-base);
  }
  .info-box {
    background: var(--blue-soft);
    border: 1px solid var(--blue-base);
    border-radius: 0.5rem;
    padding: 1rem;
    margin-top: 1rem;
    font-size: 0.9rem;
    color: var(--blue-strong);
  }
  .info-box strong {
    display: block;
    margin-bottom: 0.25rem;
  }
  .row { display: flex; gap: 1rem; }
  .col { flex: 1; }
  
  .loading, .empty-state {
    padding: 2rem;
    text-align: center;
    color: var(--text-2);
  }
</style>
