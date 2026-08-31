<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { userStore, fetchUserProfile, signOut } from '$lib/stores/auth.js';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';
  import { requestConfirmation } from '$lib/confirmation.js';
  import navigation from '$lib/navigation.json';
  import { theme, setTheme, specialThemesAllowed, SPECIAL_THEME_GROUPS } from '$lib/stores/theme.js';
  import { setLoginScreenStyle } from '$lib/stores/loginScreenPref.js';
  import { defaultHeaderTabs } from '$lib/defaultTabs.js';
  import HeaderPreview from '$lib/components/HeaderPreview.svelte';
  import { NOTIFICATION_UI_OPTIONS } from '$lib/notifications/constants.js';
  import { mergeNotificationSettings } from '$lib/notifications/settings.js';
  import { FRC_TEAMS } from '$lib/permissions.js';

  let user = null;
  let unsub;

  // Editable fields
  let full_name = '';
  let email = '';
  let frc_team = '';
  let currentPassword = '';
  let newPassword = '';
  let passwordConfirm = '';

  let savingProfile = false;
  let changingPassword = false;
  let loggingOut = false;
  // Appearance / customization
  let header_tabs = null; // array structure stored in DB
  let dashboard_layout = 'grid';
  let login_screen_style = 'legacy';
  let newFolderName = '';
  let addTabKey = '';
  let targetFolderIdx = '';
  let resettingNav = false;
  let notificationSettings = mergeNotificationSettings();

  const frcTeamOptions = Object.values(FRC_TEAMS);

  function formatFrcTeamLabel(value) {
    if (!value) return 'Not Set';
    if (value === 'Mentor') return 'Mentor';
    return `Team ${value}`;
  }

  // Matches WORKFLOW_LABELS in src/lib/server/slack_notifications.js - keep
  // in sync if a new manufacturing workflow notification category is added.
  const MANUFACTURING_WORKFLOW_LABELS = {
    'router': 'Router',
    'lathe': 'Lathe',
    'mill': 'Mill',
    'laser-cut': 'Laser Cut',
    '3d-print': '3D Print'
  };

  function formatNotificationRoleLabel(u) {
    const workflows = Array.isArray(u?.manufacturing_lead_workflows) ? u.manufacturing_lead_workflows : [];
    if (!workflows.length) return 'Unassigned';
    return workflows.map((w) => MANUFACTURING_WORKFLOW_LABELS[w] || w).join(', ');
  }

  async function logout() {
    if (loggingOut) return;
    loggingOut = true;
    try {
      await signOut();
      goto('/');
    } catch (e) {
      console.error('logout error', e);
      toastActions.show('Failed to sign out');
    } finally {
      loggingOut = false;
    }
  }

  // Basic tab manipulation helpers (in-memory; saved when profile saved)
  // When a user hasn't customized their nav yet (header_tabs is null/empty),
  // they're currently seeing the default tabs. Seed those defaults so that
  // adding a tab APPENDS to them instead of replacing the whole bar with the
  // single new tab.
  function ensureHeaderTabs() {
    if (!header_tabs || !Array.isArray(header_tabs) || header_tabs.length === 0) {
      header_tabs = defaultHeaderTabs();
    }
  }

  function createFolder() {
    if (!newFolderName.trim()) return toastActions.show('Folder name required');
    ensureHeaderTabs();
    // Normalize label: keep CAD uppercase, otherwise capitalize first char
    const raw = newFolderName.trim();
    const label = raw.toLowerCase() === 'cad' ? 'CAD' : raw.replace(/^(.)/, (m) => m.toUpperCase());
    header_tabs.push({ type: 'folder', label, children: [] });
    header_tabs = header_tabs.slice();
    toastActions.show('Folder added');
    newFolderName = '';
    autosave();
  }

  // Does a tab with this key already exist anywhere (top level or in a folder)?
  function tabKeyExists(key) {
    if (!Array.isArray(header_tabs)) return false;
    return header_tabs.some(it =>
      (it?.type === 'tab' && it.key === key) ||
      (it?.type === 'folder' && Array.isArray(it.children) && it.children.some(c => c?.key === key))
    );
  }

  function addTab() {
    if (!addTabKey) return toastActions.show('Select a tab to add');
    ensureHeaderTabs();
    if (tabKeyExists(addTabKey)) {
      toastActions.show('That tab is already in your navigation');
      addTabKey = '';
      return;
    }
    const raw = String(addTabKey || '').trim();
    const label = raw.toLowerCase() === 'cad' ? 'CAD' : raw.replace(/^(.)/, (m) => m.toUpperCase());
    const newTab = { type: 'tab', key: addTabKey, label };
    if (targetFolderIdx !== '' && header_tabs[Number(targetFolderIdx)]?.type === 'folder') {
      const f = header_tabs[Number(targetFolderIdx)];
      f.children = Array.isArray(f.children) ? f.children : [];
      f.children.push(newTab);
    } else {
      header_tabs.push(newTab);
    }
    header_tabs = header_tabs.slice();
    toastActions.show('Tab added');
    addTabKey = '';
    autosave();
  }

  async function removeEntry(idx) {
    ensureHeaderTabs();
    if (!await requestConfirmation({ message: 'Remove this tab or folder?', confirmLabel: 'Remove', danger: true })) return;
    header_tabs.splice(idx, 1);
    header_tabs = header_tabs.slice();
    toastActions.show('Removed');
    autosave();
  }

  async function removeChild(folderIdx, childIdx) {
    ensureHeaderTabs();
    const f = header_tabs[folderIdx];
    if (!await requestConfirmation({ message: 'Remove this tab from the folder?', confirmLabel: 'Remove', danger: true })) return;
    if (f && Array.isArray(f.children)) f.children.splice(childIdx, 1);
    header_tabs = header_tabs.slice();
    toastActions.show('Removed');
    autosave();
  }

  // Drag and drop handler
  function handleDrop(event) {
    const { payload, target } = event.detail;
    ensureHeaderTabs();

    // Extract the item being dragged
    let draggedItem;
    if (payload.fromType === 'top') {
      draggedItem = header_tabs[payload.idx];
      header_tabs.splice(payload.idx, 1);
    } else if (payload.fromType === 'child') {
      const folder = header_tabs[payload.folderIdx];
      if (folder && Array.isArray(folder.children)) {
        draggedItem = folder.children[payload.childIdx];
        folder.children.splice(payload.childIdx, 1);
      }
    }

    if (!draggedItem) return;

    // Insert at target
    if (target.type === 'folder') {
      const targetFolder = header_tabs[target.folderIdx];
      if (targetFolder && targetFolder.type === 'folder') {
        targetFolder.children = Array.isArray(targetFolder.children) ? targetFolder.children : [];
        targetFolder.children.push(draggedItem);
      }
    } else if (target.type === 'index') {
      header_tabs.splice(target.idx, 0, draggedItem);
    } else if (target.type === 'end') {
      header_tabs.push(draggedItem);
    }

    header_tabs = header_tabs.slice();
    toastActions.show('Reordered');
    autosave();
  }

  function autosave() {
    try { saveProfile(); } catch (e) { console.warn('autosave failed', e); }
  }

  onMount(() => {
    unsub = userStore.subscribe((v) => {
      user = v;
      if (user) {
        full_name = user.full_name || '';
        email = user.email || '';
        frc_team = user.frc_team || '';
        // load appearance settings if present
        header_tabs = user.header_tabs || null;
        dashboard_layout = user.dashboard_layout || 'grid';
        login_screen_style = user.login_screen_style || 'legacy';
        // Sync this browser's cache so the signed-out screen (which can't
        // read user_profiles before auth) picks up the account's saved
        // preference the next time this user logs out here.
        setLoginScreenStyle(login_screen_style);
        notificationSettings = mergeNotificationSettings(user.notification_settings);
      }
    });
    return () => unsub?.();
  });

  function toggleNotification(key, enabled) {
    notificationSettings = {
      ...notificationSettings,
      [key]: enabled
    };
  }

  async function saveLoginScreenStyle(value) {
    if (!user?.id) return toastActions.show('Not signed in');
    login_screen_style = value;
    setLoginScreenStyle(value);
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ login_screen_style: value })
        .eq('id', user.id);
      if (error) throw error;
      toastActions.show('Login screen updated');
    } catch (e) {
      console.error('login screen style update error', e);
      toastActions.show(e.message || 'Failed to update login screen');
    }
  }

  async function saveProfile() {
  if (!user?.id) return toastActions.show('Not signed in');
    savingProfile = true;
    try {
      // Save basic profile + appearance customizations
      const payload = {
        full_name: full_name,
        email: email,
        frc_team: frc_team || null,
        dashboard_layout: dashboard_layout,
        header_tabs: header_tabs,
        login_screen_style: login_screen_style,
        notification_settings: notificationSettings
      };
      console.log('saveProfile payload', payload);

      const { data, error } = await supabase
        .from('user_profiles')
        .update(payload)
        .eq('id', user.id)
        .select()
        .single();

      if (error) throw error;
  toastActions.show('Profile updated');
      setLoginScreenStyle(login_screen_style);
      // Refresh profile from DB so we display the canonical saved manifest
      try {
        const refreshed = await fetchUserProfile(user.id);
        if (refreshed) {
          header_tabs = refreshed.header_tabs || null;
          dashboard_layout = refreshed.dashboard_layout || 'grid';
          login_screen_style = refreshed.login_screen_style || 'legacy';
        }
      } catch (e) {
        console.warn('Failed to refresh profile after save', e);
      }
    } catch (e) {
      console.error('profile update error', e);
  toastActions.show(e.message || 'Failed to update profile');
    } finally {
      savingProfile = false;
    }
  }

  async function changePassword() {
  if (!user) return toastActions.show('Not signed in');
  if (!newPassword) return toastActions.show('New password required');
  if (newPassword !== passwordConfirm) return toastActions.show('Passwords do not match');
    changingPassword = true;
    try {
      // Supabase requires re-auth or uses auth.updateUser with password.
      const { data, error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
  toastActions.show('Password changed');
      currentPassword = '';
      newPassword = '';
      passwordConfirm = '';
    } catch (e) {
      console.error('change password error', e);
  toastActions.show(e.message || 'Failed to change password');
    } finally {
      changingPassword = false;
    }
  }

  async function resetNavigation() {
    if (!user?.id) return toastActions.show('Not signed in');
    if (!await requestConfirmation({ title: 'Reset navigation', message: 'Reset navigation to defaults? This removes all custom folders and tabs you have added.', confirmLabel: 'Reset navigation', danger: true })) return;
    resettingNav = true;
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ header_tabs: null })
        .eq('id', user.id);
      if (error) throw error;
      header_tabs = null;
      toastActions.show('Navigation reset. Reloading profile...');
      try { await fetchUserProfile(user.id); } catch (e) { /* ignore */ }
    } catch (e) {
      console.error('resetNavigation error', e);
      toastActions.show(e.message || 'Failed to reset navigation');
    } finally {
      resettingNav = false;
    }
  }

  function formatRoleLabel(value) {
    if (!value) return 'Unassigned';
    return String(value)
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  }
</script>

<svelte:head>
  <title>Profile</title>
</svelte:head>

{#if user}
  <div class="profile-page">
    <h2>Profile</h2>

    <section class="card">
      <h3>Account</h3>
      <label class="form-label">Full name
        <input class="form-input" type="text" bind:value={full_name} />
      </label>
      <label class="form-label">Email
        <input class="form-input" type="email" bind:value={email} />
      </label>
      <label class="form-label">FRC Team Affiliation
        <select class="form-select" bind:value={frc_team}>
          <option value="">Not Set</option>
          {#each frcTeamOptions as teamValue}
            <option value={teamValue}>{formatFrcTeamLabel(teamValue)}</option>
          {/each}
        </select>
        <small class="form-help">Which FRC team are you affiliated with?</small>
      </label>
      <label class="form-label" for="theme-select">Theme
        <select class="form-select" id="theme-select" value={$theme} on:change={(e) => setTheme(e.target.value)}>
          <option value="modern">Modern Light (default)</option>
          <option value="modern-dark">Modern Dark</option>
          <option value="light">Legacy</option>
        </select>
        <small class="form-help">Applies instantly and is remembered on this device.</small>
      </label>
      {#if $specialThemesAllowed}
        <div class="special-themes" aria-label="Arin-only special themes">
          <div class="special-theme-heading"><div><strong>Special themes</strong><small>Private theme gallery for Arin Rao.</small></div></div>
          {#each SPECIAL_THEME_GROUPS as group}
            <h4>{group.label}</h4>
            <div class="theme-grid">
              {#each group.themes as specialTheme}
                <button type="button" class="theme-card" class:selected={$theme === specialTheme.id} aria-pressed={$theme === specialTheme.id} on:click={() => setTheme(specialTheme.id)}>
                  <span class="theme-swatch" style={`--swatch-a:${specialTheme.preview[0]};--swatch-b:${specialTheme.preview[1]}`}></span>
                  <span>{specialTheme.label}</span>
                </button>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
      <label class="form-label" for="login-screen-select">Login Screen
        <select class="form-select" id="login-screen-select" value={login_screen_style} on:change={(e) => saveLoginScreenStyle(e.target.value)}>
          <option value="legacy">Legacy Login</option>
          <option value="modern">Modern Login</option>
        </select>
        <small class="form-help">Applies instantly and is saved to your account.</small>
      </label>
      <div class="actions">
        <button class="btn" on:click={saveProfile} disabled={savingProfile}>{savingProfile ? 'Saving...' : 'Save'}</button>
        <button class="btn btn-outline" on:click={logout} disabled={loggingOut} style="margin-left:8px">{loggingOut ? 'Signing out...' : 'Sign Out'}</button>
      </div>
    </section>

    <section class="card">
      <h3>Your Roles</h3>
      <div class="roles-grid">
        <div class="role-box">
          <div class="role-label">FRC Team</div>
          <div class="role-value">{formatFrcTeamLabel(user.frc_team)}</div>
        </div>
        <div class="role-box">
          <div class="role-label">General Role</div>
          <div class="role-value">{formatRoleLabel(user.general_role || user.role || 'Unassigned')}</div>
        </div>
        <div class="role-box">
          <div class="role-label">Purchasing Role</div>
          <div class="role-value">{formatRoleLabel(user.purchasing_role || 'Unassigned')}</div>
        </div>
        <div class="role-box">
          <div class="role-label">Team / Other Role</div>
          <div class="role-value">{formatRoleLabel(user.team_role || (Array.isArray(user.roster_keys) && user.roster_keys[0]) || 'Unassigned')}</div>
        </div>
        <div class="role-box">
          <div class="role-label">Notification Role</div>
          <div class="role-value">{formatNotificationRoleLabel(user)}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>Change Password</h3>
      <label class="form-label">New password
        <input class="form-input" type="password" bind:value={newPassword} />
      </label>
      <label class="form-label">Confirm password
        <input class="form-input" type="password" bind:value={passwordConfirm} />
      </label>
      <div class="actions">
        <button class="btn" on:click={changePassword} disabled={changingPassword}>{changingPassword ? 'Changing...' : 'Change Password'}</button>
      </div>
    </section>

    <section class="card">
      <h3>Customize Navigation</h3>
      <p class="muted">Drag and drop to reorder tabs and folders. Add new tabs or create folders to organize your navigation.</p>

      <!-- Live Preview -->
      <div class="preview-container">
        <h4>Preview</h4>
        <HeaderPreview header_tabs={header_tabs} on:drop={handleDrop} />
      </div>

      <!-- Quick Actions -->
      <div class="quick-actions">
        <div class="action-group">
          <label class="form-label" for="new-folder-name">Create folder</label>
          <div class="input-group">
            <input class="form-input" id="new-folder-name" placeholder="Folder name" bind:value={newFolderName} />
            <button class="btn btn-sm btn-nowrap" on:click={createFolder} disabled={!newFolderName.trim()}>Create</button>
          </div>
        </div>

        <div class="action-group">
          <label class="form-label" for="add-tab-select">Add tab</label>
          <div class="input-group">
            <select class="form-select" id="add-tab-select" bind:value={addTabKey}>
              <option value="">-- Select tab --</option>
              {#each Object.keys(navigation.tabs) as key}
                <option value={key}>{key}</option>
              {/each}
            </select>

            <select class="form-select" id="target-folder-select" title="Add to" bind:value={targetFolderIdx}>
              <option value="">Top level</option>
              {#each (header_tabs && Array.isArray(header_tabs) ? header_tabs : []) as it, i}
                {#if it.type === 'folder'}
                  <option value={i}>{it.label ? (it.label.toLowerCase() === 'cad' ? 'CAD' : it.label.replace(/^(.)/, (m) => m.toUpperCase())) : ''}</option>
                {/if}
              {/each}
            </select>

            <button class="btn btn-sm btn-nowrap" on:click={addTab} disabled={!addTabKey}>Add</button>
          </div>
        </div>
      </div>

      <!-- Management -->
      {#if header_tabs && Array.isArray(header_tabs) && header_tabs.length > 0}
        <div class="manage-section">
          <h4>Manage Items</h4>
          <div class="items-list">
            {#each header_tabs as item, idx}
              <div class="item-row">
                <div class="item-info">
                  <span class="item-label">{item.label ? (item.label.toLowerCase() === 'cad' ? 'CAD' : item.label.replace(/^(.)/, (m) => m.toUpperCase())) : ''}</span>
                  {#if item.type === 'folder'}
                    <span class="badge">Folder</span>
                    {#if Array.isArray(item.children) && item.children.length > 0}
                      <span class="item-meta">{item.children.length} items</span>
                    {/if}
                  {:else}
                    <span class="badge badge-tab">Tab</span>
                  {/if}
                </div>
                <button class="btn-remove" on:click={() => removeEntry(idx)} aria-label={"Remove " + (item.label ? (item.label.toLowerCase() === 'cad' ? 'CAD' : item.label.replace(/^(.)/, (m) => m.toUpperCase())) : '')}>Remove</button>
              </div>

              {#if item.type === 'folder' && Array.isArray(item.children) && item.children.length > 0}
                <div class="folder-items">
                  {#each item.children as child, cidx}
                    <div class="item-row child">
                      <span class="item-label">{child.label ? (child.label.toLowerCase() === 'cad' ? 'CAD' : child.label.replace(/^(.)/, (m) => m.toUpperCase())) : ''}</span>
                      <button class="btn-remove small" on:click={() => removeChild(idx, cidx)} aria-label={"Remove " + (child.label ? (child.label.toLowerCase() === 'cad' ? 'CAD' : child.label.replace(/^(.)/, (m) => m.toUpperCase())) : '')}>✕</button>
                    </div>
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      <div class="actions">
        <button class="btn btn-outline" disabled={resettingNav} on:click={resetNavigation}>
          {resettingNav ? 'Resetting...' : 'Reset to Defaults'}
        </button>
      </div>
    </section>

    <section class="card">
      <h3>Notifications</h3>
      <p class="muted"><strong>New users:</strong> Choose which Slack DMs you want to receive.</p>
      <div class="notification-grid">
        {#each NOTIFICATION_UI_OPTIONS as option}
          <label class="notify-row">
            <input
              type="checkbox"
              checked={notificationSettings?.[option.key] !== false}
              on:change={(event) => toggleNotification(option.key, event.currentTarget.checked)}
            />
            <div>
              <div class="notify-label">{option.label}</div>
              <div class="notify-desc">{option.description}</div>
            </div>
          </label>
        {/each}
      </div>
      <div class="actions">
        <button class="btn" on:click={saveProfile} disabled={savingProfile}>{savingProfile ? 'Saving...' : 'Save Notifications'}</button>
      </div>
    </section>
  </div>
{:else}
  <div class="profile-page">
    <h2>Profile</h2>
    <p>Please sign in to view your profile.</p>
  </div>
{/if}

<style>
  .profile-page { max-width: 860px; margin: 0 auto; padding: var(--space-4); }
  .profile-page :global(.card) { padding: var(--space-6); margin-bottom: var(--space-6); }
  .profile-page :global(.card h3) { margin-top: 0; margin-bottom: var(--space-4); font-size: 1.25rem; }
  .profile-page :global(.card h4) { margin: var(--space-4) 0 var(--space-2); font-size: 1rem; font-weight: 600; }
  .profile-page :global(.actions) { margin-top: var(--space-4); }

  .roles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--gap-4); }
  .role-box { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); text-align: center; }
  .role-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: var(--space-2); }
  .role-value { font-size: 1.1rem; font-weight: 600; color: var(--text); }

  .muted { color: var(--muted); font-size: 0.9rem; margin-bottom: var(--space-4); }
  .attendance-card-header { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-4); }
  .attendance-stats { display: flex; flex-wrap: wrap; gap: var(--gap-4); margin-bottom: var(--space-4); }
  .stat-block { flex: 1 1 220px; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); background: var(--surface-1); }
  .stat-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .stat-value { font-size: 1.5rem; margin-top: 0.35rem; display: block; }
  .attendance-history h4 { margin-top: 0; margin-bottom: var(--space-2); }
  .attendance-history ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .attendance-history li { display: flex; justify-content: space-between; gap: var(--gap-4); padding-bottom: var(--space-2); border-bottom: 1px solid var(--border); }
  .attendance-history li:last-child { border-bottom: none; padding-bottom: 0; }

  .preview-container { margin: var(--space-6) 0; padding: var(--space-4); background: var(--background); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .preview-container h4 { margin-top: 0; margin-bottom: var(--space-3); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
  .notification-grid { display: flex; flex-direction: column; gap: var(--space-3); }
  .special-themes { margin:var(--space-5) 0; padding-top:var(--space-4); border-top:1px solid var(--border); }
  .special-theme-heading div { display:grid; gap:2px; }
  .special-theme-heading small { color:var(--text-muted); }
  .special-themes h4 { color:var(--text-muted); }
  .theme-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--gap-3); }
  .theme-card { min-height:5.2rem; display:flex; align-items:center; gap:var(--gap-3); padding:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface-1); color:var(--text); text-align:left; font-weight:600; cursor:pointer; }
  .theme-card:hover { border-color:var(--text-muted); background:var(--surface-2); }
  .theme-card.selected { border-color:var(--blue-base); box-shadow:0 0 0 1px var(--blue-base); }
  .theme-swatch { width:3.5rem; height:3.5rem; flex:0 0 3.5rem; border-radius:50%; border:1px solid rgba(255,255,255,.18); background:linear-gradient(135deg,var(--swatch-a),var(--swatch-b)); }
  .notify-row { display: flex; gap: var(--gap-3); align-items: flex-start; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
  .notify-row:last-child { border-bottom: none; }
  .notify-label { font-weight: 600; }
  .notify-desc { color: var(--muted); font-size: 0.85rem; }

  .quick-actions { display: flex; flex-direction: column; gap: var(--gap-4); margin: var(--space-6) 0; }
  .action-group { display: flex; flex-direction: column; gap: var(--gap-2); }
  .action-group :global(.form-label) { margin-bottom: var(--space-1); }
  .input-group { display: flex; gap: var(--gap-2); }
  .input-group :global(.form-input), .input-group :global(.form-select) { flex: 1; min-width: 0; }

  .manage-section { margin-top: var(--space-6); padding-top: var(--space-6); border-top: 1px solid var(--border); }
  .items-list { display: flex; flex-direction: column; gap: var(--gap-2); }
  .item-row { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3); background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .item-row.child { margin-left: 2rem; padding: var(--space-2) var(--space-3); background: transparent; border: 1px dashed var(--border); }
  .item-info { display: flex; align-items: center; gap: var(--gap-2); flex: 1; }
  .item-label { font-weight: 500; }
  .item-meta { font-size: 0.85rem; color: var(--muted); }
  .badge-tab { background: var(--muted-bg); color: var(--muted); }
  .folder-items { display: flex; flex-direction: column; gap: 0.35rem; margin-top: var(--space-2); }

  /* Mobile Responsive Styles */
  @media (max-width: 768px) {
    .profile-page {
      padding: var(--space-3);
    }
    
    .profile-page :global(.card) {
      padding: var(--space-4);
      margin-bottom: var(--space-4);
    }
    
    .profile-page :global(.card h3) {
      font-size: 1.1rem;
    }
    
    .roles-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: var(--gap-2);
    }
    .theme-grid { grid-template-columns:1fr; }
    
    .role-box {
      padding: var(--space-3);
    }
    
    .role-label {
      font-size: 0.7rem;
    }
    
    .role-value {
      font-size: 0.9rem;
    }
    
    .attendance-card-header {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--gap-2);
    }
    
    .attendance-stats {
      flex-direction: column;
    }
    
    .stat-block {
      flex: 1 1 100%;
    }
    
    .stat-value {
      font-size: 1.25rem;
    }
    
    .attendance-history li {
      flex-direction: column;
      gap: var(--gap-2);
    }
    
    .input-group {
      flex-direction: column;
    }
    
    .input-group :global(.form-input), 
    .input-group :global(.form-select) {
      width: 100%;
    }
    
    .item-row {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--gap-2);
    }
    
    .item-row.child {
      margin-left: 1rem;
    }
    
    .notify-row {
      flex-direction: column;
      gap: var(--gap-2);
    }
  }

  @media (max-width: 480px) {
    .profile-page {
      padding: var(--space-2);
    }
    
    .profile-page :global(.card) {
      padding: var(--space-3);
    }
    
    .roles-grid {
      grid-template-columns: 1fr;
    }
    
    .preview-container {
      padding: var(--space-3);
      margin: var(--space-4) 0;
    }
  }

  @media (max-width: 640px) {
    .input-group { flex-direction: column; }
    .input-group :global(.form-input), .input-group :global(.form-select) { width: 100%; }
  }
</style>
