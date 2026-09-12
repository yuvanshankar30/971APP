<script>
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore } from '$lib/stores/auth.js';
  import { hasPermission, TEAM_ROLES } from '$lib/permissions.js';
  import { goto } from '$app/navigation';
  import { Settings, Save, RefreshCw, Power, Wrench, AlertTriangle, Check } from 'lucide-svelte';
  import stockData from '$lib/stock.json';
  import { toastActions } from '$lib/toast.js';

  let profile = null;
  let loading = true;
  let saving = false;
  
  // Global settings
  let globalEnabled = true;
  let defaultToolDiameter = 0.25;
  let apiEndpoint = '';
  
  // Profiles
  let profiles = [];
  let materialPresets = [];
  let serviceStatus = null;
  
  // Get sheet stock types from stock.json (router workflow only)
  $: sheetStocks = stockData.router?.filter(s => s.dimensions === 'Sheet') || [];
  
  // Permission check
  $: isManufacturingLead = profile?.team_role === TEAM_ROLES.MANUFACTURING_LEAD || 
                          profile?.general_role === 'lead' || 
                          profile?.role === 'admin';

  onMount(() => {
    const unsub = userStore.subscribe(v => {
      profile = v;
      if (profile && !isManufacturingLead) {
        // Redirect non-leads
        goto('/manufacture');
      }
    });
    loadData();
    return unsub;
  });

  async function loadData() {
    loading = true;
    try {
      // Load global settings
      const { data: settings } = await supabase
        .from('autocam_settings')
        .select('*')
        .eq('id', 'global')
        .single();
      
      if (settings) {
        globalEnabled = settings.enabled;
        defaultToolDiameter = settings.default_tool_diameter || 0.25;
        apiEndpoint = settings.api_endpoint || '';
      }
      
      // Load profiles
      const { data: profileData } = await supabase
        .from('autocam_profiles')
        .select('*')
        .order('stock_id');
      
      profiles = profileData || [];
      
      // Check service status
      await checkServiceStatus();
      
      // Load material presets from service
      await loadMaterialPresets();
    } catch (e) {
      console.error('Failed to load autocam settings:', e);
      toastActions.show('Failed to load settings', 'error');
    } finally {
      loading = false;
    }
  }

  async function checkServiceStatus() {
    try {
      const response = await fetch('/api/autocam?action=health');
      if (response.ok) {
        serviceStatus = await response.json();
      } else {
        serviceStatus = { status: 'unavailable' };
      }
    } catch {
      serviceStatus = { status: 'unavailable' };
    }
  }

  async function loadMaterialPresets() {
    try {
      const response = await fetch('/api/autocam?action=presets');
      if (response.ok) {
        const data = await response.json();
        materialPresets = Object.entries(data.presets || {}).map(([key, val]) => ({
          id: key,
          ...val
        }));
      }
    } catch {
      materialPresets = [
        { id: 'aluminum', name: 'Aluminum' },
        { id: 'plywood', name: 'Plywood' },
        { id: 'polycarbonate', name: 'Polycarbonate' }
      ];
    }
  }

  async function saveGlobalSettings() {
    saving = true;
    try {
      const { error } = await supabase
        .from('autocam_settings')
        .upsert({
          id: 'global',
          enabled: globalEnabled,
          default_tool_diameter: defaultToolDiameter,
          api_endpoint: apiEndpoint || null,
          updated_at: new Date().toISOString(),
          updated_by: profile?.id
        });
      
      if (error) throw error;
      toastActions.show('Settings saved!');
    } catch (e) {
      console.error('Failed to save settings:', e);
      toastActions.show('Failed to save settings', 'error');
    } finally {
      saving = false;
    }
  }

  async function saveProfile(p) {
    try {
      const { error } = await supabase
        .from('autocam_profiles')
        .upsert({
          id: p.id,
          stock_id: p.stock_id,
          material_preset: p.material_preset,
          tool_diameter: p.tool_diameter,
          feed_rate: p.feed_rate || null,
          ramp_feed_rate: p.ramp_feed_rate || null,
          plunge_rate: p.plunge_rate || null,
          spindle_speed: p.spindle_speed || null,
          ramp_angle: p.ramp_angle || null,
          stepover_percentage: p.stepover_percentage || null,
          tab_width: p.tab_width || null,
          tab_height: p.tab_height || null,
          tab_spacing: p.tab_spacing || null,
          enabled: p.enabled,
          updated_at: new Date().toISOString()
        });
      
      if (error) throw error;
      toastActions.show(`Profile saved for ${p.stock_id}`);
    } catch (e) {
      console.error('Failed to save profile:', e);
      toastActions.show('Failed to save profile', 'error');
    }
  }

  function createProfileForStock(stock) {
    // Determine default material preset from stock material
    let preset = 'aluminum';
    const mat = stock.material?.toLowerCase() || '';
    if (mat.includes('polycarb') || mat.includes('pc')) preset = 'polycarbonate';
    else if (mat.includes('wood') || mat.includes('birch') || mat.includes('plywood')) preset = 'plywood';
    
    const newProfile = {
      id: crypto.randomUUID(),
      stock_id: stock.id,
      material_preset: preset,
      tool_diameter: defaultToolDiameter,
      enabled: true,
      feed_rate: null,
      ramp_feed_rate: null,
      plunge_rate: null,
      spindle_speed: null,
      ramp_angle: null,
      stepover_percentage: null,
      tab_width: null,
      tab_height: null,
      tab_spacing: null
    };
    profiles = [...profiles, newProfile];
  }

  function getStockForProfile(profile) {
    return sheetStocks.find(s => s.id === profile.stock_id);
  }

  function getProfileForStock(stock) {
    return profiles.find(p => p.stock_id === stock.id);
  }

  // Sheet stocks without profiles
  $: unconfiguredStocks = sheetStocks.filter(s => !getProfileForStock(s));
</script>

<svelte:head><title>Autocam Settings | Spartans Hub</title></svelte:head>

<div class="page-header">
  <h1><Settings size={28} /> Autocam Settings</h1>
  <div class="page-actions">
    <a href="/manufacture/router" class="btn btn-secondary">Back to Router</a>
  </div>
</div>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else if !isManufacturingLead}
  <div class="card">
    <p class="warning"><AlertTriangle size={16} /> You don't have permission to access autocam settings.</p>
  </div>
{:else}
  <!-- Service Status -->
  <div class="card">
    <div class="card-header">
      <h2><Wrench size={20} /> Service Status</h2>
      <button class="btn btn-ghost btn-sm" on:click={checkServiceStatus}>
        <RefreshCw size={14} /> Refresh
      </button>
    </div>
    
    {#if serviceStatus?.status === 'healthy'}
      <div class="status-good">
        <Check size={16} /> Autocam service is online
        {#if serviceStatus.version}
          <span class="version">(v{serviceStatus.version})</span>
        {/if}
      </div>
      {#if serviceStatus.material_presets}
        <p class="hint">Available presets: {serviceStatus.material_presets.join(', ')}</p>
      {/if}
    {:else}
      <div class="status-error">
        <AlertTriangle size={16} /> Autocam service is unavailable
      </div>
      <p class="hint">Autocam processing will not work until the service is running.</p>
    {/if}
  </div>

  <!-- Global Settings -->
  <div class="card">
    <div class="card-header">
      <h2><Power size={20} /> Global Settings</h2>
    </div>
    
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={globalEnabled} />
        <span>Enable Autocam System</span>
      </label>
      <p class="hint">When disabled, new sheet stock parts will follow the manual CAM workflow.</p>
    </div>
    
    <div class="form-row">
      <div class="form-group">
        <label for="defaultTool">Default Tool Diameter (inches)</label>
        <input 
          type="number" 
          id="defaultTool"
          bind:value={defaultToolDiameter}
          step="0.0625"
          min="0.125"
          max="0.5"
        />
      </div>
      
      <div class="form-group">
        <label for="apiEndpoint">API Endpoint (optional)</label>
        <input 
          type="text" 
          id="apiEndpoint"
          bind:value={apiEndpoint}
          placeholder="http://localhost:8080"
        />
        <p class="hint">Leave blank to use default local service.</p>
      </div>
    </div>
    
    <button class="btn btn-primary" on:click={saveGlobalSettings} disabled={saving}>
      <Save size={16} /> {saving ? 'Saving...' : 'Save Global Settings'}
    </button>
  </div>

  <!-- Material Profiles -->
  <div class="card">
    <div class="card-header">
      <h2>Material Profiles</h2>
      <p class="hint">Configure CAM parameters for each stock type.</p>
    </div>
    
    {#if profiles.length === 0}
      <p class="empty">No profiles configured yet.</p>
    {:else}
      <div class="profiles-list">
        {#each profiles as profile (profile.id)}
          {@const stock = getStockForProfile(profile)}
          <div class="profile-card" class:disabled={!profile.enabled}>
            <div class="profile-header">
              <div class="profile-title">
                <strong>{stock?.description || profile.stock_id}</strong>
                <span class="stock-id">{profile.stock_id}</span>
              </div>
              <label class="checkbox-label compact">
                <input type="checkbox" bind:checked={profile.enabled} />
                Enabled
              </label>
            </div>
            
            <div class="profile-form">
              <div class="form-row">
                <div class="form-group">
                  <label for="preset-{profile.stock_type}">Material Preset</label>
                  <select id="preset-{profile.stock_type}" bind:value={profile.material_preset}>
                    {#each materialPresets as preset}
                      <option value={preset.id}>{preset.name}</option>
                    {/each}
                  </select>
                </div>
                
                <div class="form-group">
                  <label for="tool-{profile.stock_type}">Tool Diameter (in)</label>
                  <input 
                    id="tool-{profile.stock_type}"
                    type="number" 
                    bind:value={profile.tool_diameter}
                    step="0.0625"
                    min="0.125"
                    max="0.5"
                  />
                </div>
              </div>
              
              <details class="advanced-settings">
                <summary>Advanced Overrides</summary>
                <div class="form-row">
                  <div class="form-group">
                    <label for="feed-{profile.stock_type}">Feed Rate (IPM)</label>
                    <input id="feed-{profile.stock_type}" type="number" bind:value={profile.feed_rate} placeholder="Use preset" />
                  </div>
                  <div class="form-group">
                    <label for="spindle-{profile.stock_type}">Spindle Speed (RPM)</label>
                    <input id="spindle-{profile.stock_type}" type="number" bind:value={profile.spindle_speed} placeholder="Use preset" />
                  </div>
                </div>
                <div class="form-row">
                  <div class="form-group">
                    <label for="tabw-{profile.stock_type}">Tab Width (in)</label>
                    <input id="tabw-{profile.stock_type}" type="number" bind:value={profile.tab_width} step="0.0625" placeholder="0.25" />
                  </div>
                  <div class="form-group">
                    <label for="tabh-{profile.stock_type}">Tab Height (in)</label>
                    <input id="tabh-{profile.stock_type}" type="number" bind:value={profile.tab_height} step="0.05" placeholder="0.15" />
                  </div>
                  <div class="form-group">
                    <label for="tabs-{profile.stock_type}">Tab Spacing (in)</label>
                    <input id="tabs-{profile.stock_type}" type="number" bind:value={profile.tab_spacing} step="0.5" placeholder="6.0" />
                  </div>
                </div>
              </details>
              
              <button class="btn btn-secondary btn-sm" on:click={() => saveProfile(profile)}>
                <Save size={14} /> Save Profile
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    
    {#if unconfiguredStocks.length > 0}
      <div class="unconfigured-section">
        <h3>Add Profile for Stock Type</h3>
        <div class="stock-buttons">
          {#each unconfiguredStocks as stock}
            <button class="btn btn-ghost btn-sm" on:click={() => createProfileForStock(stock)}>
              + {stock.description}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .card {
    background: var(--surface-1);
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1rem;
  }
  
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  
  .card-header h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1.1rem;
  }
  
  .form-group {
    margin-bottom: 1rem;
  }
  
  .form-group label {
    display: block;
    margin-bottom: 0.25rem;
    font-weight: 500;
    font-size: 0.9rem;
  }
  
  .form-group input,
  .form-group select {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--background);
    color: var(--text);
  }
  
  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }
  
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  
  .checkbox-label.compact {
    font-size: 0.85rem;
  }
  
  .hint {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin-top: 0.25rem;
  }
  
  .status-good {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--success);
    padding: 0.75rem;
    background: rgba(34, 197, 94, 0.1);
    border-radius: 4px;
    margin-bottom: 0.5rem;
  }
  
  .status-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--danger);
    padding: 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 4px;
    margin-bottom: 0.5rem;
  }
  
  .version {
    font-size: 0.8rem;
    opacity: 0.7;
  }
  
  .profiles-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  .profile-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem;
  }
  
  .profile-card.disabled {
    opacity: 0.6;
  }
  
  .profile-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }
  
  .profile-title strong {
    display: block;
  }
  
  .stock-id {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: monospace;
  }
  
  .advanced-settings {
    margin: 1rem 0;
    padding: 0.5rem;
    background: var(--background);
    border-radius: 4px;
  }
  
  .advanced-settings summary {
    cursor: pointer;
    font-weight: 500;
    font-size: 0.9rem;
  }
  
  .advanced-settings[open] summary {
    margin-bottom: 1rem;
  }
  
  .unconfigured-section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  
  .unconfigured-section h3 {
    font-size: 0.95rem;
    margin-bottom: 0.75rem;
  }
  
  .stock-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  
  .warning {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--warning);
  }
  
  .empty {
    color: var(--text-secondary);
    font-style: italic;
  }

  @media (max-width: 768px) {
    .card-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.75rem;
    }

    .profile-header {
      flex-direction: column;
      gap: 0.5rem;
    }

    .stock-buttons {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
