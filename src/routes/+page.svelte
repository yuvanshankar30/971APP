<script>
  import { onMount } from 'svelte';
  import { supabase, getAuthHeader } from '$lib/supabase.js';
  import { initAuth, userStore, signOut, authReady as authReadyStore, user as authUserStore } from '$lib/stores/auth.js';
  import { LogIn, UserPlus, Mail, Lock, User, Shield, CheckCircle, AlertCircle, LogOut, Users, GripVertical, X, Plus, LayoutGrid, ClipboardCheck, Factory, ShoppingCart, ListChecks } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import { FRC_TEAMS, hasPermission } from '$lib/permissions.js';
  import { theme, setTheme } from '$lib/stores/theme.js';
  import { loginScreenStyle, setLoginScreenStyle } from '$lib/stores/loginScreenPref.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  
  let user = null;
  let authUser = null;

  function can(perm) {
    return hasPermission(user, perm);
  }
  let loading = true;
  // Do not leave a signed-in member behind an infinite spinner when their
  // profile request fails or is delayed. The auth store keeps retrying the
  // profile load; this only releases the page shell after a short grace period.
  let profileWaitExpired = false;
  $: isLoading = loading || (authUser !== null && user === null && !profileWaitExpired);
  let scoutingLoaded = false;

  // --- Home dashboard section customization (drag to reorder, delete, restore) ---
  // Mirrors the header_tabs pattern in +layout.svelte: a nullable JSONB column
  // (dashboard_sections) stores an ordered array of section keys. Null/empty
  // means "no customization yet" — fall back to every section in its default
  // order. Admin is opt-in per user (defaults to visible for admins, but can
  // be dragged/removed like anything else) rather than pinned like the top
  // nav's Admin tab, since admins always retain nav access regardless.
  const ALL_DASHBOARD_SECTIONS = [
    { key: 'workspace', label: 'Team Workspace' },
    { key: 'assignment-queue', label: 'Your Scouting Assignments' }
  ];
  const LEGACY_SECTION_MIGRATIONS = Object.freeze({
    stats: 'workspace',
    'quick-actions': 'workspace',
    analysis: 'workspace',
    subsystems: 'workspace',
    builds: 'workspace',
    purchases: 'workspace'
  });

  function sectionLabel(key) {
    if (key === 'admin') return 'Admin Panel';
    return ALL_DASHBOARD_SECTIONS.find(d => d.key === key)?.label || key;
  }

  function sanitizeSectionKeys(raw) {
    if (!Array.isArray(raw)) return null;
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
      const rawKey = typeof entry === 'string' ? entry : entry?.key;
      const key = LEGACY_SECTION_MIGRATIONS[rawKey] || rawKey;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  function defaultSectionKeyList(canViewAdminPanel) {
    const keys = ALL_DASHBOARD_SECTIONS.map(d => d.key);
    if (canViewAdminPanel) keys.push('admin');
    return keys;
  }

  let editMode = false;
  let draggedSectionKey = null;
  let dragOverSectionKey = null;

  $: canViewAdmin = can('VIEW_ADMIN_PANEL');
  $: customSectionKeys = sanitizeSectionKeys(user?.dashboard_sections);
  $: rawVisibleKeys = (customSectionKeys && customSectionKeys.length ? customSectionKeys : defaultSectionKeyList(canViewAdmin))
    .filter(k => k !== 'admin' || canViewAdmin)
    .filter(k => k === 'admin' || ALL_DASHBOARD_SECTIONS.some(d => d.key === k));
  $: visibleSections = rawVisibleKeys.map(k => ({ key: k, label: sectionLabel(k) }));
  $: hiddenSections = [...ALL_DASHBOARD_SECTIONS.map(d => d.key), ...(canViewAdmin ? ['admin'] : [])]
    .filter(k => !rawVisibleKeys.includes(k))
    .map(k => ({ key: k, label: sectionLabel(k) }));

  async function persistDashboardSections(keys) {
    user = { ...user, dashboard_sections: keys };
    try {
      const { error } = await supabase.from('user_profiles').update({ dashboard_sections: keys }).eq('id', user.id);
      if (error) throw error;
    } catch (e) {
      console.error('Failed to save dashboard layout:', e);
    }
  }

  function handleSectionDragStart(event, key) {
    draggedSectionKey = key;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
  }

  function handleSectionDragOver(event, key) {
    if (!draggedSectionKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragOverSectionKey = key;
  }

  function handleSectionDragLeave() {
    dragOverSectionKey = null;
  }

  function handleSectionDragEnd() {
    draggedSectionKey = null;
    dragOverSectionKey = null;
  }

  async function handleSectionDrop(event, key) {
    event.preventDefault();
    dragOverSectionKey = null;
    const fromKey = draggedSectionKey;
    draggedSectionKey = null;
    if (!fromKey || fromKey === key) return;
    const keys = [...rawVisibleKeys];
    const fromIdx = keys.indexOf(fromKey);
    const toIdx = keys.indexOf(key);
    if (fromIdx === -1 || toIdx === -1) return;
    keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, fromKey);
    await persistDashboardSections(keys);
  }

  async function removeSection(key) {
    await persistDashboardSections(rawVisibleKeys.filter(k => k !== key));
  }

  async function restoreSection(key) {
    await persistDashboardSections([...rawVisibleKeys, key]);
  }
  let authMode = 'login'; // 'login', 'register', or 'forgot'
  let formData = {
    email: '',
    password: '',
    name: '',
    frc_team: '' // 971, 9584, or Mentor
  };
  let authLoading = false;
  let authError = '';
  let authSuccess = '';
  let forgotEmail = '';
  let forgotLoading = false;
  let forgotError = '';
  let forgotSuccess = '';

  // Scouting assignment alert state
  let myScoutAssignments = [];
  let nextScoutAssignment = null; // { scouting_type, match_key, team_key }
  let showScoutAlert = true;
  $: incompleteScoutAssignments = myScoutAssignments.filter(a => !a.completed_at);

  // Pre-scouting assignment state - teams assigned to this user to research
  // ahead of the event (see /scouting-admin's PitAssignmentPanel,
  // assignmentKind="prescout"). Unlike match scouting assignments, these are
  // team-based, not match-based, so they get their own list rather than
  // merging into myScoutAssignments/compareScoutAssignmentMatches.
  let myPrescoutAssignments = [];
  let prescoutEventKey = '';

  // Data assignments used to open /datascout, then briefly Quick Scout once
  // /datascout was removed. Match Scouting (api/matchscout) is the real,
  // current surface for "data scouting" now - see ScoutAssignmentPanel's own
  // "Data Scout"/"Match Scouting Assignments" labeling - so that's where
  // these need to land, not Quick Scout.
  function scoutAssignmentRoute(scoutingType) {
    if (scoutingType === 'note') return 'notescout';
    if (scoutingType === 'data') return 'matchscout';
    return 'quickscout';
  }

  // match_key -> team_key -> 'red' | 'blue', built once from the active
  // event's TBA schedule. scout_match_assignments itself has no alliance
  // column (and no event_key of its own - it's embedded in match_key, e.g.
  // "2026cc_qm14"), so this is the only way to know which side a "data"
  // assignment's robot is on without asking the scout to look it up by hand.
  let matchAllianceByKey = {};

  async function loadMatchAlliances() {
    try {
      const eventKey = await fetchActiveScoutingEventKey();
      if (!eventKey) return;
      const res = await fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`);
      const payload = await res.json();
      if (!payload?.success) return;
      const next = {};
      for (const match of payload.data || []) {
        next[match.key] = {};
        for (const teamKey of match.alliances?.red?.team_keys || []) next[match.key][teamKey] = 'red';
        for (const teamKey of match.alliances?.blue?.team_keys || []) next[match.key][teamKey] = 'blue';
      }
      matchAllianceByKey = next;
    } catch { /* alliance is a nice-to-have autofill, not worth surfacing an error for */ }
  }

  // Match Scouting's own match_key convention is the bare qualification
  // number ("14"), not TBA's "2026cc_qm14" - see how it saves match_key
  // directly from its "Match #" input. Strips the event prefix and comp-
  // level letters (qm/qf/sf/f) down to just that number.
  function bareMatchNumber(matchKey) {
    return String(matchKey || '').split('_').pop().replace(/^[a-z]+/i, '');
  }

  function scoutAssignmentHref(assignment) {
    if (assignment?.scouting_type !== 'data') return `/${scoutAssignmentRoute(assignment?.scouting_type)}`;
    const teamNumber = String(assignment?.team_key || '').replace(/^frc/i, '');
    const alliance = matchAllianceByKey[assignment?.match_key]?.[assignment?.team_key] || '';
    const params = new URLSearchParams({ match: bareMatchNumber(assignment?.match_key), team: teamNumber });
    if (alliance) params.set('alliance', alliance);
    return `/matchscout?${params.toString()}`;
  }

  function compareScoutAssignmentMatches(left, right) {
    // TBA match keys use qualification/playoff prefixes such as qm12,
    // qf1m2, sf2m1, and f1m1. Compare their numeric components rather than
    // their raw strings so qm10 correctly follows qm2.
    const parse = (matchKey) => {
      const suffix = String(matchKey || '').split('_').pop().toLowerCase();
      const match = suffix.match(/^(qm|qf|sf|f)(\d+)(?:m(\d+))?$/);
      const phase = { qm: 0, qf: 1, sf: 2, f: 3 }[match?.[1]] ?? 4;
      return {
        phase,
        set: Number(match?.[2]) || 0,
        round: Number(match?.[3]) || 0,
        raw: suffix
      };
    };
    const a = parse(left?.match_key);
    const b = parse(right?.match_key);
    return a.phase - b.phase
      || a.set - b.set
      || a.round - b.round
      || a.raw.localeCompare(b.raw)
      || String(left?.team_key || '').localeCompare(String(right?.team_key || ''));
  }

  async function loadScoutAssignments(){
    if(!user?.id) return;
    try {
      const authHeaders = await getAuthHeader();
      // Fetch all three scouting types
      const res1 = await fetch(`/api/scout-assignments?scouting_type=data&mine=1&user_id=${encodeURIComponent(user.id)}`, {
        headers: authHeaders
      });
      const js1 = await res1.json();
      const res2 = await fetch(`/api/scout-assignments?scouting_type=note&mine=1&user_id=${encodeURIComponent(user.id)}`, {
        headers: authHeaders
      });
      const js2 = await res2.json();
      const res3 = await fetch(`/api/scout-assignments?scouting_type=quick&mine=1&user_id=${encodeURIComponent(user.id)}`, {
        headers: authHeaders
      });
      const js3 = await res3.json();
      const rows = [].concat(js1?.data||[], js2?.data||[], js3?.data||[]);
      // Completed assignments stay in the list (shown as "Completed", and
      // still clickable to go back and edit the report) rather than
      // vanishing once done - only sink below the still-open ones so the
      // visible slice stays useful.
      const sorted = [...rows].sort((a, b) => {
        const doneA = a.completed_at ? 1 : 0;
        const doneB = b.completed_at ? 1 : 0;
        return doneA - doneB || compareScoutAssignmentMatches(a, b);
      });
      myScoutAssignments = sorted;
      nextScoutAssignment = sorted.find(r => !r.completed_at) || null;
    }catch(e){ /* ignore */ }
  }

  async function loadPrescoutAssignments(){
    if(!user?.id) return;
    try {
      const eventKey = await fetchActiveScoutingEventKey();
      if (!eventKey) { myPrescoutAssignments = []; return; }
      const authHeaders = await getAuthHeader();
      const res = await fetch(`/api/prescout-assignments?event_key=${encodeURIComponent(eventKey)}`, {
        headers: authHeaders
      });
      const js = await res.json();
      const rows = Array.isArray(js?.data) ? js.data : [];
      prescoutEventKey = eventKey;
      myPrescoutAssignments = rows
        .filter(r => r.assigned_user === user.id && !r.completed_at)
        .sort((a, b) => Number(String(a.team_key).replace(/^frc/i,'')) - Number(String(b.team_key).replace(/^frc/i,'')));
    }catch(e){ /* ignore */ }
  }

  onMount(() => {
    const unsub = userStore.subscribe((v) => { user = v; });
    const unsubAuthUser = authUserStore.subscribe((v) => { authUser = v; });
    const unsubReady = authReadyStore.subscribe((value) => {
      loading = !value;
    });
    const uninit = initAuth();
    const profileWaitTimer = setTimeout(() => {
      profileWaitExpired = true;
      if (authUser && !user) {
        user = {
          id: authUser.id,
          email: authUser.email || '',
          full_name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || '',
          permissions: []
        };
      }
    }, 5000);
    return () => { clearTimeout(profileWaitTimer); unsub?.(); unsubAuthUser?.(); unsubReady?.(); uninit?.(); };
  });

  $: if (user) profileWaitExpired = false;
  // The scouting landing page only needs the signed-in scout's own queue.
  $: if (user && !scoutingLoaded) {
    scoutingLoaded = true;
    loadScoutAssignments();
    loadPrescoutAssignments();
    loadMatchAlliances();
  }

  // Keep this browser's login-screen cache in sync with the account's saved
  // preference (set in the Profile page), so the next time this user signs
  // out on this device, the signed-out screen matches without needing to be
  // set again - the account preference is unreadable before auth, so this
  // cache is what actually drives the pre-auth render.
  $: if (user?.login_screen_style) setLoginScreenStyle(user.login_screen_style);
  // The account profile is authoritative, so a sign-in restores the theme
  // that this email selected even after the browser was signed out.
  $: if (user?.theme_preference) setTheme(user.theme_preference);

  async function handleAuth() {
    authLoading = true;
    authError = '';
    authSuccess = '';
    
    try {
      if (authMode === 'login') {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: formData.email,
          password: formData.password
        });
        
        if (error) throw error;
        // auth state change will update stores
      } else {        // Register new user
        const { data, error } = await supabase.auth.signUp({
          email: formData.email,
          password: formData.password,
          options: {
            data: {
              name: formData.name,
              frc_team: formData.frc_team || null
            }
          }
        });
        if (error) throw error;

        // Update user_profiles with frc_team selection
        const newUserId = data?.user?.id || data?.user?.user?.id || null;
        if (newUserId && formData.frc_team) {
          try {
            await supabase
              .from('user_profiles')
              .update({ frc_team: formData.frc_team })
              .eq('id', newUserId);
          } catch (e) {
            console.warn('Failed to update frc_team in profile:', e);
          }
        }

        // Notify approvers once when the user registers. This is triggered once per page session.
        try {
          if (!window.__notifiedUserRegistration) window.__notifiedUserRegistration = new Set();
          const newUserId = data?.user?.id || data?.user?.user?.id || null;
          const newUserName = formData.name || formData.email || newUserId;
          if (newUserId && !window.__notifiedUserRegistration.has(newUserId)) {
            window.__notifiedUserRegistration.add(newUserId);
            const BOT_BASE_URL = import.meta.env?.VITE_BOT_BASE_URL || '/api/971bot';
            fetch(`${BOT_BASE_URL}/notify/user_registration`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: newUserId, name: newUserName })
            }).then((r) => {
              if (!r.ok) console.warn('User registration notify failed', r.status);
            }).catch((e) => console.warn('User registration notify error', e));
          }

        } catch (e) {
          console.warn('Failed to notify user registration to bot:', e);
        }

        if (data.user && !data.session) {
          authSuccess = 'Registration successful! Please check your email to confirm your account.';
        }
        // If session exists, auth listener will populate stores
      }
    } catch (error) {
      authError = error.message;
    } finally {
      // Do not keep plaintext password in component state after submit.
      formData = { ...formData, password: '' };
      authLoading = false;
    }
  }

  function resetForm() {
    formData = {
      email: '',
      password: '',
      name: '',
      frc_team: ''
    };
    authError = '';
    authSuccess = '';
    forgotEmail = '';
    forgotError = '';
    forgotSuccess = '';
  }
  function switchMode() {
    authMode = authMode === 'login' ? 'register' : 'login';
    resetForm();
  }

  async function handleForgotPassword() {
    if (!forgotEmail) return;
    forgotLoading = true;
    forgotError = '';
    forgotSuccess = '';
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail);
      if (error) throw error;
      forgotSuccess = 'Check your email for a password reset link.';
    } catch (e) {
      forgotError = e.message;
    } finally {
      forgotLoading = false;
    }
  }

  async function handleLogout() {
    await signOut();
  }
</script>

<svelte:head>
  <title>Spartans Hub - Login</title>
</svelte:head>

{#if isLoading}
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <p>Loading...</p>
  </div>
{:else if user}
  <!-- User Dashboard -->
  <div class="dashboard-container">
    <div class="user-welcome">
      <div class="user-welcome-text">
        <h2>Welcome back, {user.full_name || user.email}!</h2>
        <!-- Simplified header: we no longer show individual info boxes here -->
        <p class="muted">Your workspace for manufacturing, purchasing, and competition scouting.</p>
      </div>
      <!-- Sits with the greeting rather than in a full-width bar of its own
           below it - it is a single occasional control, and a whole toolbar
           row for one button read as an empty strip across the page. Same
           permission guard it had there. -->
      {#if can('CAN_SEE_ROUTES')}
        <button type="button" class="btn btn-outline btn-sm layout-toggle" on:click={() => editMode = !editMode}>
          {#if editMode}
            <CheckCircle size={14} />
            Done
          {:else}
            <LayoutGrid size={14} />
            Customize Layout
          {/if}
        </button>
      {/if}
    </div>

    {#if showScoutAlert && incompleteScoutAssignments.length>0}
      <div class="pending-notice">
        <AlertCircle size={20} />
        <div>
          <h3>Scouting Assignments</h3>
          <p>You have {incompleteScoutAssignments.length} upcoming scouting assignment{incompleteScoutAssignments.length===1?'':'s'}.</p>
          {#if nextScoutAssignment}
            <div style="margin-top:0.25rem; display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center">
              <button class="btn btn-primary" on:click={() => goto(scoutAssignmentHref(nextScoutAssignment))}>Go to Next ({nextScoutAssignment.scouting_type} – {nextScoutAssignment.match_key.split('_').pop()} – {nextScoutAssignment.team_key.replace('frc','')})</button>
              <button class="btn btn-outline" on:click={() => showScoutAlert=false}>Dismiss</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if !can('CAN_SEE_ROUTES')}
      <div class="pending-notice">
        <AlertCircle size={20} />
        <div>
          <h3>Account Pending Approval</h3>
          <p>Your account has been created successfully. An administrator needs to assign your role and permissions before you can access the manufacturing features. You'll receive an email notification once your account is approved.</p>
        </div>
      </div>
    {:else}
      {#if editMode && hiddenSections.length > 0}
        <div class="hidden-sections-tray">
          <span class="tray-label">Hidden:</span>
          {#each hiddenSections as s (s.key)}
            <button type="button" class="chip-btn" on:click={() => restoreSection(s.key)}>
              <Plus size={12} />
              {s.label}
            </button>
          {/each}
        </div>
      {/if}

      <div class="dashboard-sections">
        {#each visibleSections as section (section.key)}
          <div
            id={section.key === 'assignment-queue' ? 'assignment-queue' : undefined}
            class="dashboard-section"
            class:editing={editMode}
            class:dragging={draggedSectionKey === section.key}
            class:drag-over={dragOverSectionKey === section.key}
            role="group"
            draggable={editMode}
            on:dragstart={(e) => handleSectionDragStart(e, section.key)}
            on:dragover={(e) => handleSectionDragOver(e, section.key)}
            on:dragleave={handleSectionDragLeave}
            on:drop={(e) => handleSectionDrop(e, section.key)}
            on:dragend={handleSectionDragEnd}
          >
            {#if editMode}
              <div class="section-editbar">
                <span class="drag-handle" aria-hidden="true"><GripVertical size={16} /></span>
                <span class="section-editbar-label">{section.label}</span>
                <button type="button" class="section-remove" on:click={() => removeSection(section.key)} aria-label={`Remove ${section.label}`}>
                  <X size={14} />
                </button>
              </div>
            {/if}

            {#if section.key === 'workspace'}
              <div class="dashboard-actions">
                <h3>Team Workspace</h3>
                <div class="workspace-grid">
                  <a href="/manufacture" class="workspace-card">
                    <Factory size={24} />
                    <h4>Manufacturing</h4>
                    <p>Manage active parts and production work</p>
                  </a>
                  <a href="/cad/purchasing" class="workspace-card">
                    <ShoppingCart size={24} />
                    <h4>Purchasing</h4>
                    <p>Review purchase requests, orders, and needed components</p>
                  </a>
                  <a href="/scouting" class="workspace-card">
                    <ClipboardCheck size={24} />
                    <h4>Scouting</h4>
                    <p>Open competition assignments, scouting forms, and event analysis</p>
                  </a>
                </div>
              </div>
            {:else if section.key === 'admin'}
              <div class="dashboard-actions">
                <h3>Admin</h3>
                <div class="action-grid">
                  <a href="/admin" class="action-card">
                    <Shield size={24} />
                    <h4>Admin Panel</h4>
                    <p>Manage users, roles, and system settings</p>
                  </a>
                </div>
              </div>
            {:else if section.key === 'assignment-queue'}
              <div class="user-lists">
                <div class="assignment-heading">
                  <div>
                    <h4>Your Scouting Assignments</h4>
                    <p class="muted">Only assignments assigned to you are shown here.</p>
                  </div>
                  <a href="/scouting" class="btn btn-outline btn-sm">
                    <ListChecks size={14} />
                    Open Scouting
                  </a>
                </div>
                {#if myScoutAssignments.length === 0}
                  <p class="muted">No open scouting assignments right now.</p>
                {:else}
                  <div class="card-grid">
                    {#each myScoutAssignments.slice(0, 8) as assignment}
                      <a class="assignment-card" class:completed={!!assignment.completed_at} href={scoutAssignmentHref(assignment)}>
                        <h5>{assignment.scouting_type} scouting - Match #{assignment.match_key.split('_').pop()}</h5>
                        <p class="muted">Team {String(assignment.team_key || '').replace(/^frc/i, '')}</p>
                        {#if assignment.completed_at}
                          <span class="completed-badge"><CheckCircle size={12} /> Completed{assignment.scouting_type === 'data' ? ' - tap to edit' : ''}</span>
                        {/if}
                      </a>
                    {/each}
                  </div>
                {/if}

                {#if myPrescoutAssignments.length > 0}
                  <div class="assignment-heading" style="margin-top:1rem;">
                    <div>
                      <h4>Your Pre-Scouting Assignments</h4>
                      <p class="muted">Teams assigned to you to research before they arrive at the event.</p>
                    </div>
                  </div>
                  <div class="card-grid">
                    {#each myPrescoutAssignments.slice(0, 8) as assignment}
                      <a class="assignment-card" href={`/teamview?team=${encodeURIComponent(String(assignment.team_key || '').replace(/^frc/i, ''))}&event_key=${encodeURIComponent(prescoutEventKey)}&from=/&fromLabel=Home`}>
                        <h5>Team {String(assignment.team_key || '').replace(/^frc/i, '')}</h5>
                        <p class="muted">Pre-scouting</p>
                      </a>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}

        {#if visibleSections.length === 0}
          <div class="dashboard-section-empty">
            <p class="muted">All dashboard sections are hidden. Use "Customize Layout" at the top to bring them back.</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else if $loginScreenStyle === 'modern'}
  <!-- Authentication Forms: Modern (split-hero) -->
  <div class="ml-hero-split">
    <div class="ml-brand-panel">
      <div class="ml-brand-inner">
        <span class="ml-eyebrow">FRC Team 971 &amp; 9584</span>
        <h1 class="ml-word">Spartans<br />Hub</h1>
      </div>
      <div class="ml-mesh" aria-hidden="true"></div>
    </div>

    <div class="ml-form-panel">
      <div class="ml-form-card">
        {#if authMode === 'forgot'}
          <div class="forgot-header">
            <h3>Reset your password</h3>
            <p class="muted">Enter your email and we'll send you a reset link.</p>
          </div>
          <form on:submit|preventDefault={handleForgotPassword}>
            <label class="ml-field">
              <span><Mail size={15} /> Email</span>
              <input type="email" bind:value={forgotEmail} placeholder="you@spartanrobotics.org" required />
            </label>
            {#if forgotError}
              <div class="alert alert-error"><AlertCircle size={18} />{forgotError}</div>
            {/if}
            {#if forgotSuccess}
              <div class="alert alert-success"><CheckCircle size={18} />{forgotSuccess}</div>
            {/if}
            <button type="submit" class="ml-btn" disabled={forgotLoading}>
              {#if forgotLoading}
                <div class="loading-spinner small"></div>
              {:else}
                <Mail size={18} />
              {/if}
              Send Reset Link
            </button>
          </form>
          <p class="ml-footnote">
            <button class="link-btn" on:click={() => { authMode = 'login'; resetForm(); }}>Back to Sign In</button>
          </p>
        {:else}
          <div class="ml-tabs">
            <button class:active={authMode === 'login'} on:click={() => { authMode = 'login'; resetForm(); }}>
              <LogIn size={16} /> Sign In
            </button>
            <button class:active={authMode === 'register'} on:click={() => { authMode = 'register'; resetForm(); }}>
              <UserPlus size={16} /> Register
            </button>
          </div>
          <form on:submit|preventDefault={handleAuth}>
            {#if authMode === 'register'}
              <label class="ml-field">
                <span><User size={15} /> Full Name</span>
                <input type="text" bind:value={formData.name} placeholder="Enter your full name" required />
              </label>
              <label class="ml-field">
                <span><Users size={15} /> Team Affiliation</span>
                <select bind:value={formData.frc_team} required>
                  <option value="" disabled>Select your team...</option>
                  <option value={FRC_TEAMS.TEAM_971}>Team 971</option>
                  <option value={FRC_TEAMS.TEAM_9584}>Team 9584</option>
                  <option value={FRC_TEAMS.MENTOR}>Mentor</option>
                </select>
              </label>
            {/if}
            <label class="ml-field">
              <span><Mail size={15} /> Email</span>
              <input
                type="email"
                bind:value={formData.email}
                autocomplete="username"
                placeholder="you@spartanrobotics.org"
                required
              />
            </label>
            <label class="ml-field">
              <span><Lock size={15} /> Password</span>
              <input
                type="password"
                bind:value={formData.password}
                autocomplete={authMode === 'login' ? 'current-password' : 'new-password'}
                placeholder="••••••••••"
                required
                minlength="6"
              />
              {#if authMode === 'register'}
                <small class="ml-help">Password must be at least 6 characters long</small>
              {:else}
                <button type="button" class="ml-forgot-link" on:click={() => { forgotEmail = formData.email; authMode = 'forgot'; }}>
                  Forgot password?
                </button>
              {/if}
            </label>

            {#if authError}
              <div class="alert alert-error"><AlertCircle size={18} />{authError}</div>
            {/if}
            {#if authSuccess}
              <div class="alert alert-success"><CheckCircle size={18} />{authSuccess}</div>
            {/if}

            <button type="submit" class="ml-btn" disabled={authLoading}>
              {#if authLoading}
                <div class="loading-spinner small"></div>
              {:else if authMode === 'login'}
                <LogIn size={18} />
              {:else}
                <UserPlus size={18} />
              {/if}
              {authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
          <p class="ml-footnote">
            {authMode === 'login' ? "Don't have an account?" : 'Already have an account?'}
            <button class="link-btn" on:click={switchMode}>
              {authMode === 'login' ? 'Register here' : 'Sign in here'}
            </button>
          </p>
        {/if}

        <div class="ml-bottom">
          <div class="theme-picker">
            <label for="login-theme-select-modern">Theme</label>
            <select id="login-theme-select-modern" value={$theme} on:change={(e) => setTheme(e.target.value)}>
              <option value="modern">Modern Light (default)</option>
              <option value="modern-dark">Modern Dark</option>
              <option value="light">Legacy</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
{:else}
  <!-- Authentication Forms: Legacy -->
  <div class="auth-container" style="min-height:60vh">
    <div class="auth-card">      <div class="auth-header">
        <div class="brand">
          <span class="brand-mark lg" aria-hidden="true"></span>
          <h1>Spartans Hub</h1>
        </div>
        <p class="subtitle">Spartan Robotics</p>
      </div>

      <div class="auth-form">
        {#if authMode !== 'forgot'}
        <div class="form-tabs">
          <button
            class="tab-btn {authMode === 'login' ? 'active' : ''}"
            on:click={() => { authMode = 'login'; resetForm(); }}
          >
            <LogIn size={16} />
            Sign In
          </button>
          <button
            class="tab-btn {authMode === 'register' ? 'active' : ''}"
            on:click={() => { authMode = 'register'; resetForm(); }}
          >
            <UserPlus size={16} />
            Register
          </button>
        </div>
        {/if}

        {#if authMode === 'forgot'}
          <div class="forgot-header">
            <h3>Reset your password</h3>
            <p class="muted">Enter your email and we'll send you a reset link.</p>
          </div>
          <form on:submit|preventDefault={handleForgotPassword}>
            <div class="form-group">
              <label class="form-label" for="forgot-email">
                <Mail size={18} />
                Email Address
              </label>
              <input
                id="forgot-email"
                type="email"
                class="form-input"
                bind:value={forgotEmail}
                placeholder="Enter your email"
                required
              />
            </div>
            {#if forgotError}
              <div class="alert alert-error">
                <AlertCircle size={18} />
                {forgotError}
              </div>
            {/if}
            {#if forgotSuccess}
              <div class="alert alert-success">
                <CheckCircle size={18} />
                {forgotSuccess}
              </div>
            {/if}
            <button type="submit" class="btn btn-primary auth-submit" disabled={forgotLoading}>
              {#if forgotLoading}
                <div class="loading-spinner small"></div>
              {:else}
                <Mail size={18} />
              {/if}
              Send Reset Link
            </button>
          </form>
          <div class="auth-footer">
            <p>
              <button class="link-btn" on:click={() => { authMode = 'login'; resetForm(); }}>
                Back to Sign In
              </button>
            </p>
          </div>
        {:else}
        <form on:submit|preventDefault={handleAuth}>
          {#if authMode === 'register'}
            <div class="form-group">
              <label class="form-label" for="name">
                <User size={18} />
                Full Name
              </label>
              <input
                id="name"
                type="text"
                class="form-input"
                bind:value={formData.name}
                placeholder="Enter your full name"
                required              />
            </div>
            <div class="form-group">
              <label class="form-label" for="frc_team">
                <Users size={18} />
                Team Affiliation
              </label>
              <select
                id="frc_team"
                class="form-input"
                bind:value={formData.frc_team}
                required
              >
                <option value="" disabled>Select your team...</option>
                <option value={FRC_TEAMS.TEAM_971}>Team 971</option>
                <option value={FRC_TEAMS.TEAM_9584}>Team 9584</option>
                <option value={FRC_TEAMS.MENTOR}>Mentor</option>
              </select>
              <small class="form-help">Select which FRC team you are affiliated with</small>
            </div>
          {/if}

          <div class="form-group">
            <label class="form-label" for="email">
              <Mail size={18} />
              Email Address
            </label>
            <input
              id="email"
              type="email"
              class="form-input"
              bind:value={formData.email}
              autocomplete="username"
              placeholder="Enter your email"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="password">
              <Lock size={18} />
              Password
            </label>
            <input
              id="password"
              type="password"
              class="form-input"
              bind:value={formData.password}
              autocomplete={authMode === 'login' ? 'current-password' : 'new-password'}
              placeholder="Enter your password"
              required
              minlength="6"
            />
            {#if authMode === 'register'}
              <small class="form-help">Password must be at least 6 characters long</small>
            {:else}
              <button type="button" class="forgot-link" on:click={() => { forgotEmail = formData.email; authMode = 'forgot'; }}>
                Forgot password?
              </button>
            {/if}
          </div>

          {#if authError}
            <div class="alert alert-error">
              <AlertCircle size={18} />
              {authError}
            </div>
          {/if}

          {#if authSuccess}
            <div class="alert alert-success">
              <CheckCircle size={18} />
              {authSuccess}
            </div>
          {/if}

          <button 
            type="submit" 
            class="btn btn-primary auth-submit"
            disabled={authLoading}
          >
            {#if authLoading}
              <div class="loading-spinner small"></div>
            {:else if authMode === 'login'}
              <LogIn size={18} />
            {:else}
              <UserPlus size={18} />
            {/if}
            {authMode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {/if}

        <div class="auth-bottom">
          {#if authMode !== 'forgot'}
            <p class="auth-switch">
              {authMode === 'login' ? "Don't have an account?" : 'Already have an account?'}
              <button class="link-btn" on:click={switchMode}>
                {authMode === 'login' ? 'Register here' : 'Sign in here'}
              </button>
            </p>
          {:else}
            <span></span>
          {/if}
          <div class="theme-picker">
            <label for="login-theme-select">Theme</label>
            <select id="login-theme-select" value={$theme} on:change={(e) => setTheme(e.target.value)}>
              <option value="modern">Modern Light (default)</option>
              <option value="modern-dark">Modern Dark</option>
              <option value="light">Legacy</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ===== Modern login screen (split-hero) — opt-in via profile's Login
     Screen setting, see loginScreenPref.js. Reuses .alert/.link-btn/
     .loading-spinner/.theme-picker/.forgot-header/.muted from the legacy
     styles below (same component, so no scoping issue), and defines its
     own ml-* classes for the layout so nothing collides. ===== */
  .ml-hero-split {
    max-width: 1040px;
    margin: var(--space-8) auto;
    display: grid;
    grid-template-columns: 1.15fr 1fr;
    min-height: 560px;
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  @media (max-width: 900px) {
    .ml-hero-split { grid-template-columns: 1fr; min-height: auto; margin: var(--space-4) auto; }
  }

  .ml-brand-panel {
    position: relative;
    background: var(--secondary);
    color: var(--primary);
    display: flex;
    align-items: center;
    padding: clamp(2.5rem, 6vw, 5rem);
    overflow: hidden;
  }
  .ml-mesh {
    position: absolute;
    inset: -30%;
    background:
      radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--accent) 55%, transparent) 0%, transparent 45%),
      radial-gradient(circle at 85% 75%, color-mix(in srgb, var(--accent) 35%, transparent) 0%, transparent 50%);
    filter: blur(60px);
    opacity: 0.55;
    animation: mlDrift 16s ease-in-out infinite alternate;
    pointer-events: none;
  }
  @keyframes mlDrift {
    from { transform: translate(0, 0) scale(1); }
    to { transform: translate(3%, -3%) scale(1.08); }
  }

  .ml-brand-inner { position: relative; z-index: 1; max-width: 480px; }
  .ml-eyebrow {
    font-family: var(--font-mono-stack, monospace);
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.6;
    display: block;
    margin-bottom: var(--space-4);
  }
  .ml-word {
    /* Explicit color: the global h1,h2,h3,h4 rule sets color:var(--secondary),
       which is also this panel's own background - without overriding it here
       the wordmark would be nearly invisible (same color as behind it). */
    color: var(--primary);
    font-family: var(--font-display, inherit);
    font-weight: 800;
    font-size: clamp(2.6rem, 5.5vw, 4.25rem);
    line-height: 0.96;
    letter-spacing: -0.02em;
    margin: 0;
  }

  .ml-form-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(2rem, 4vw, 3.5rem);
    background: var(--primary);
  }
  .ml-form-card { width: 100%; max-width: 360px; }

  .ml-tabs {
    display: flex;
    gap: var(--space-6);
    margin-bottom: var(--space-7);
    border-bottom: 1px solid var(--border);
  }
  .ml-tabs button {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: none;
    padding: 0 0 0.85rem;
    font-family: var(--font-display, inherit);
    font-weight: 600;
    font-size: 1rem;
    color: var(--neutral-500);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .ml-tabs button.active {
    color: var(--secondary);
    border-bottom-color: var(--accent);
  }

  .ml-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: var(--space-6);
  }
  .ml-field span {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--neutral-500);
    font-family: var(--font-mono-stack, monospace);
  }
  .ml-field input, .ml-field select {
    border: none;
    border-bottom: 1.5px solid var(--border);
    background: transparent;
    padding: 0.6rem 0.1rem;
    font-size: 1rem;
    font-family: inherit;
    color: var(--secondary);
    transition: border-color 0.15s ease;
  }
  .ml-field input:focus, .ml-field select:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }
  .ml-help {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--font-xs);
    color: var(--neutral-500);
  }
  .ml-forgot-link {
    background: none;
    border: none;
    color: var(--neutral-500);
    cursor: pointer;
    font-size: var(--font-xs);
    padding: var(--space-1) 0 0;
    display: block;
    text-decoration: underline;
  }
  .ml-forgot-link:hover { color: var(--accent); }

  .ml-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: var(--secondary);
    color: var(--primary);
    border: none;
    border-radius: 999px;
    padding: 0.95rem;
    font-family: var(--font-display, inherit);
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    margin-top: var(--space-4);
    margin-bottom: var(--space-4);
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  .ml-btn:hover { transform: translateY(-1px); opacity: 0.9; }
  .ml-btn:disabled { cursor: default; transform: none; opacity: 0.7; }

  .ml-footnote {
    text-align: center;
    font-size: 0.82rem;
    color: var(--neutral-500);
    margin: var(--space-6) 0 0;
  }

  .ml-bottom {
    display: flex;
    justify-content: center;
    margin-top: var(--space-6);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .auth-container {
    /* Slightly softer than the app-wide sharp-corner default (--radius-lg),
       without going soft-card-AI-generic. Scoped to this page's own cards. */
    --home-radius: 8px;
    max-width: 500px;
    margin: var(--space-8) auto;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 0 var(--space-4);
  }

  .auth-card {
    background: var(--primary);
    border: 1px solid var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-7);
    box-shadow: var(--shadow-sm);
    width: 100%;
  }

  .auth-header {
    text-align: center;
    margin-bottom: var(--space-7);
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--gap-3);
    color: var(--accent);
    margin-bottom: var(--space-2);
  }

  .brand h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--secondary);
  }

  .subtitle {
    color: var(--neutral-500);
    margin: 0;
    font-size: var(--font-xs);
  }

  .form-tabs {
    display: flex;
    margin-bottom: var(--space-6);
    border-bottom: 1px solid var(--border);
  }

  .tab-btn {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    border: none;
    background: none;
    color: var(--neutral-500);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--gap-2);
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-btn:hover {
    color: var(--secondary);
  }

  .form-group {
    margin-bottom: var(--space-6);
  }

  .form-label {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-bottom: var(--space-2);
    font-weight: 600;
    color: var(--secondary);
  }

  .form-help {
    display: block;
    margin-top: var(--space-1);
    font-size: var(--font-xs);
    color: var(--neutral-500);
  }

  .alert {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-4);
    font-size: var(--font-xs);
  }

  .alert-error {
    background: rgba(220, 53, 69, 0.1);
    color: var(--danger);
    border: 1px solid rgba(220, 53, 69, 0.2);
  }

  .alert-success {
    background: rgba(40, 167, 69, 0.1);
    color: var(--success);
    border: 1px solid rgba(40, 167, 69, 0.2);
  }

  .auth-submit {
    width: 100%;
    padding: var(--space-3);
    font-size: var(--font-base);
    font-weight: 600;
    margin-bottom: var(--space-4);
  }

  .auth-footer {
    text-align: center;
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .auth-footer p {
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-xs);
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    font-size: inherit;
    padding: 0;
    margin-left: var(--space-1);
  }

  .link-btn:hover {
    color: var(--brand-gold-base);
  }

  .forgot-link {
    background: none;
    border: none;
    color: var(--neutral-500);
    cursor: pointer;
    font-size: var(--font-xs);
    padding: var(--space-1) 0 0;
    display: block;
    text-decoration: underline;
  }

  .forgot-link:hover {
    color: var(--accent);
  }

  .forgot-header {
    margin-bottom: var(--space-6);
  }

  .forgot-header h3 {
    margin: 0 0 var(--space-2) 0;
    color: var(--secondary);
    font-size: var(--font-md);
  }

  .forgot-header p {
    margin: 0;
    font-size: var(--font-xs);
  }

  .dashboard-container {
    /* Slightly softer than the app-wide sharp-corner default (--radius-lg),
       without going soft-card-AI-generic. Scoped to this page's own cards. */
    --home-radius: 8px;
    max-width: 1200px;
    margin: var(--space-7) auto;
    padding: 0 var(--space-4);
  }

  /* Compact masthead with a gold spine — no dead vertical space */
  .user-welcome {
    background: var(--primary);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-5) var(--space-6);
    margin-bottom: var(--space-6);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .user-welcome-text {
    min-width: 0;
  }

  .user-welcome h2 {
    margin: 0 0 var(--space-1) 0;
    color: var(--secondary);
    font-size: var(--font-xl);
  }

  .user-welcome .muted {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .pending-notice {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-4);
    background: var(--brand-gold-soft);
    border: 1px solid var(--orange-soft);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-6);
    margin-bottom: var(--space-7);
    color: var(--brand-gold-strong);
  }

  .pending-notice h3 {
    margin: 0 0 var(--space-2) 0;
    color: var(--brand-gold-strong);
    font-size: var(--font-md);
  }

  .pending-notice p {
    margin: 0;
    line-height: 1.5;
  }

  .dashboard-actions h3 {
    margin: 0 0 var(--space-4) 0;
    color: var(--secondary);
    font-size: var(--font-xl);
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--gap-3);
  }

  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--gap-3);
  }

  .workspace-card,
  .action-card {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--space-4);
    align-items: center;
    background: var(--primary);
    border: 1px solid var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-5) var(--space-6);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .workspace-card:hover,
  .action-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .workspace-card :global(svg),
  .action-card :global(svg) {
    grid-row: 1 / span 2;
    width: 22px;
    height: 22px;
    padding: 9px;
    border-radius: var(--radius-sm);
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  .workspace-card h4,
  .action-card h4 {
    grid-column: 2;
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-md);
  }

  .workspace-card p,
  .action-card p {
    grid-column: 2;
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-xs);
    line-height: 1.4;
  }

  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--gap-3);
    margin-top: var(--space-2);
  }

  .assignment-card {
    display: block;
    text-decoration: none;
    color: inherit;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-4) var(--space-5);
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .assignment-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .assignment-card h5 { margin: 0 0 var(--space-1) 0; color: var(--secondary); }
  .assignment-card p { margin: 0; color: var(--neutral-500); font-size: var(--font-xs); }
  .assignment-card.completed { opacity: 0.72; }
  .assignment-card.completed:hover { opacity: 1; }
  .completed-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: var(--space-2);
    color: var(--success, #2e7d32);
    font-size: var(--font-xs);
    font-weight: 600;
  }

  /* Mobile Responsive Styles */
  @media (max-width: 768px) {
    .auth-container { 
      margin: var(--space-4) auto; 
      padding: 0 var(--space-3);
    }
    .auth-card { padding: var(--space-6); }
    .brand h1 { font-size: var(--font-xl); }
    .dashboard-container { margin: var(--space-4) 0; padding: 0 var(--space-3); }
    .user-welcome { padding: var(--space-6); }
    .user-welcome h2 { font-size: var(--font-md); margin-bottom: var(--space-3); }
    .workspace-grid, .action-grid { grid-template-columns: 1fr; gap: var(--gap-3); }
    .workspace-card, .action-card { padding: var(--space-4); }
    .pending-notice {
      flex-direction: column;
      gap: var(--gap-3);
      padding: var(--space-4);
    }
    .pending-notice h3 {
      font-size: var(--font-base);
    }
    .card-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 480px) {
    .auth-container { margin: var(--space-2) auto; }
    .auth-card { 
      padding: var(--space-4); 
      border-radius: var(--radius-sm);
    }
    .brand h1 { font-size: var(--font-md); }
    .form-tabs {
      flex-direction: column;
      border-bottom: none;
      gap: var(--space-2);
    }
    .tab-btn {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      border-bottom-width: 1px;
    }
    .tab-btn.active {
      border-color: var(--accent);
      background: var(--brand-gold-soft);
    }
    .user-welcome { 
      padding: var(--space-4); 
      margin-bottom: var(--space-4);
    }
    .dashboard-actions h3 {
      font-size: var(--font-md);
    }
    .user-lists h4 {
      font-size: var(--font-base);
    }
  }

  /* Bottom row of the auth card: mode-switch text left, theme picker right */
  .auth-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-3);
    flex-wrap: wrap;
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .auth-switch {
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-xs);
  }
  .theme-picker {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }
  .theme-picker label {
    font-size: var(--font-xs);
    color: var(--text-muted);
  }
  .theme-picker select {
    height: var(--control-height);
    padding: var(--control-padding-sm);
    font-size: var(--control-font-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text);
  }

  /* Ledger-style section labels: mono small caps over a strong rule */
  .user-lists h4 {
    font-family: var(--font-mono-stack);
    font-size: 0.68rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--neutral-800);
    padding-bottom: var(--space-2);
    margin: 0 0 var(--space-3);
  }

  .assignment-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap-4);
    margin-bottom: var(--space-3);
  }

  .assignment-heading h4 {
    margin-bottom: var(--space-1);
  }

  .assignment-heading .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-xs);
  }

  .assignment-heading .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    flex-shrink: 0;
  }

  /* ===== Home dashboard customization: toolbar, hidden tray, sections ===== */
  .layout-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .hidden-sections-tray {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-2);
    background: var(--surface-1);
    border: 1px dashed var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-5);
  }

  .tray-label {
    font-family: var(--font-mono-stack);
    font-size: 0.68rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .chip-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    background: var(--primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-3);
    font-size: var(--font-xs);
    font-weight: 500;
    color: var(--secondary);
    cursor: pointer;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .chip-btn:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
  }

  .dashboard-sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
  }

  .dashboard-section.editing {
    border: 1px dashed var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-3);
  }

  .dashboard-section.editing[draggable="true"] {
    cursor: grab;
  }

  .dashboard-section.dragging {
    opacity: 0.4;
  }

  .dashboard-section.drag-over {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .section-editbar {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin-bottom: var(--space-3);
  }

  .drag-handle {
    display: flex;
    align-items: center;
    color: var(--text-muted);
  }

  .section-editbar-label {
    flex: 1;
    font-family: var(--font-mono-stack);
    font-size: 0.68rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .section-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: var(--danger);
    cursor: pointer;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .section-remove:hover {
    background: rgba(220, 53, 69, 0.1);
    border-color: var(--danger);
  }

  .dashboard-section-empty {
    border: 1px dashed var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    background: var(--surface-1);
    padding: var(--space-5);
  }

  .dashboard-section-empty p {
    margin: 0;
  }

  /* Empty states read as intentional placeholders, not stray text */
  .user-lists > .muted {
    border: 1px dashed var(--border);
    border-radius: var(--home-radius, var(--radius-lg));
    background: var(--surface-1);
    padding: var(--space-4) var(--space-5);
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  @media (max-width: 480px) {
    .assignment-heading {
      align-items: stretch;
      flex-direction: column;
    }

    .assignment-heading .btn {
      justify-content: center;
    }
  }

</style>
