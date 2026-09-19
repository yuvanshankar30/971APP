<script>
  import { onMount } from 'svelte';
  import { supabase, getAuthHeader } from '$lib/supabase.js';
  import { initAuth, userStore, signOut, authReady as authReadyStore, user as authUserStore } from '$lib/stores/auth.js';
  import { LogIn, UserPlus, Mail, Lock, User, Shield, CheckCircle, AlertCircle, LogOut, Users, GripVertical, X, Plus, LayoutGrid, ClipboardCheck, Factory, ShoppingCart, ListChecks, ListOrdered, Target } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import { FRC_TEAMS, hasPermission } from '$lib/permissions.js';
  import { theme, setTheme } from '$lib/stores/theme.js';
  import { loginScreenStyle, setLoginScreenStyle } from '$lib/stores/loginScreenPref.js';
  import { fetchActiveScoutingEventKey } from '$lib/scoutingEvent.js';
  import { displayTeamNumber, matchDisplayName, selectCurrentEventMatch } from '$lib/currentEventMatch.js';
  
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

  // Quick-nav sidebar: clicking a tab surfaces a preview right here on the
  // home page instead of immediately navigating away from it - navigating
  // is still one click away (the panel's own "Open" button), just no
  // longer the click on the tab itself.
  const QUICK_TABS = [
    { key: 'strategy', label: 'Strategy', href: '/strategy', blurb: "What's happening on the field right now, for alliance-selection awareness." },
    { key: 'driveteam', label: 'Drive Team', href: '/driveteam', blurb: 'Your own next match - what Drive Team needs to know before it plays.' },
    { key: 'matchscout', label: 'Match Scouting', href: '/matchscout', blurb: 'File a match report for your assigned robot, or edit one you already submitted.' },
    { key: 'pitscout', label: 'Pit Scouting', href: '/pitscout', blurb: "Record a team's robot capabilities, drivebase, and technical details during pit walks." },
    { key: 'myscout', label: 'My Scout', href: '/myscout', blurb: 'Every match and pit report you have personally submitted for the active competition.' },
    { key: 'picklist', label: 'Picklist', href: '/picklist', blurb: 'Drag-reorder your human pick list, with AI move-flagging against the scouting data.' },
    { key: 'matchrankings', label: 'Match Rankings', href: '/matchrankings', blurb: 'Live qualification rankings and match results as they come in.' },
    { key: 'powerrankings', label: 'Power Rankings', href: '/powerrankings', blurb: "A computed power ranking blending this team's own scouting data with TBA." },
    { key: 'robotratings', label: 'Robot Ratings', href: '/robotratings', blurb: 'Scout-submitted ratings for every robot at the event, side by side.' },
    { key: 'predictions', label: 'Prediction Market', href: '/predictions', blurb: 'Predict match outcomes and see how the team is calling upcoming matches.' },
    { key: 'scouting-admin', label: 'Scouting Admin', href: '/scouting-admin', blurb: 'Publish scouting assignments, manage the active event, and review submissions.' }
  ];
  let activeQuickTab = null;
  $: activeQuickTabInfo = QUICK_TABS.find((tab) => tab.key === activeQuickTab) || null;
  // Each tab's preview shows something specific to it, not the same
  // "here's a match" card everywhere - built entirely from state this page
  // already loads, no new fetches.
  $: nextDataAssignment = incompleteScoutAssignments.find(a => a.scouting_type === 'data') || null;

  // The remaining tabs (picklist, rankings, power/robot ratings,
  // predictions, admin) don't have anything this page already loads, so
  // their preview data is fetched lazily the first time that tab is
  // clicked - never eagerly on page load, and only once per tab per visit.
  let quickPreviewData = {};
  let quickPreviewLoading = {};

  function selectQuickTab(key) {
    const next = activeQuickTab === key ? null : key;
    activeQuickTab = next;
    if (next) loadQuickPreviewData(next);
  }

  async function loadQuickPreviewData(key) {
    if (!homeEventKey || quickPreviewData[key] || quickPreviewLoading[key]) return;
    if (!['picklist', 'matchrankings', 'powerrankings', 'robotratings', 'predictions', 'scouting-admin'].includes(key)) return;
    quickPreviewLoading = { ...quickPreviewLoading, [key]: true };
    try {
      const headers = await getAuthHeader();
      const myTeamKey = `frc${user?.frc_team || FRC_TEAMS.TEAM_971}`;
      let result = null;
      if (key === 'picklist') {
        const res = await fetch(`/api/scouting-picklist?event_key=${encodeURIComponent(homeEventKey)}`, { headers });
        const payload = await res.json().catch(() => null);
        const picks = payload?.success ? payload.data || [] : [];
        result = { count: picks.length, top: picks.slice(0, 3).map(p => p.team_number) };
      } else if (key === 'matchrankings') {
        const res = await fetch(`/api/tba/event-rankings?event_key=${encodeURIComponent(homeEventKey)}`);
        const payload = await res.json().catch(() => null);
        const rankings = payload?.success ? payload.data?.rankings || [] : [];
        const mine = rankings.find(r => r.team_key === myTeamKey) || null;
        result = { totalTeams: rankings.length, mine };
      } else if (key === 'powerrankings' || key === 'robotratings') {
        const res = await fetch(`/datascout?all_teams=1&event_key=${encodeURIComponent(homeEventKey)}`, { headers });
        const payload = await res.json().catch(() => null);
        const rows = payload?.success ? payload.data || [] : [];
        result = { scoutedTeams: new Set(rows.map(r => r.team_key)).size };
      } else if (key === 'predictions') {
        const res = await fetch(`/api/prediction-market?event_key=${encodeURIComponent(homeEventKey)}`, { headers });
        const payload = await res.json().catch(() => null);
        result = { count: payload?.success ? (payload.data || []).length : 0 };
      } else if (key === 'scouting-admin') {
        const res = await fetch(`/api/scout-assignments?scouting_type=data&capabilities=1`, { headers });
        const payload = await res.json().catch(() => null);
        result = { canEdit: payload?.success ? !!payload.data?.can_edit : false };
      }
      quickPreviewData = { ...quickPreviewData, [key]: result };
    } catch {
      quickPreviewData = { ...quickPreviewData, [key]: null };
    } finally {
      quickPreviewLoading = { ...quickPreviewLoading, [key]: false };
    }
  }

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
  $: incompleteScoutAssignments = myScoutAssignments.filter(a => !a.completed_at);
  $: completedScoutAssignmentCount = myScoutAssignments.length - incompleteScoutAssignments.length;
  // A busy scout can rack up dozens of assignments - letting every card stay
  // a fixed minimum width just means an ever-taller stack of rows. Shrink
  // the grid's own minimum column width as the count climbs past a normal
  // event's worth, so more of them fit per row instead of only adding rows.
  // Never shrinks below 110px (still fits "Match #qm123 / Team 9999").
  $: assignmentGridMinWidth = Math.max(110, 200 - Math.max(0, myScoutAssignments.length - 8) * 6);

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
  let homeEventKey = '';
  let currentEventMatch = null;
  let currentMatchState = 'unavailable';
  let currentMatchLoading = false;
  let currentMatchError = '';
  // This signed-in scout's own team's next/current match specifically (not
  // just whatever match the field is on) - what the Drive Team preview
  // below is actually for.
  let myTeamNextMatch = null;
  let myTeamNextMatchState = 'unavailable';

  async function loadMatchAlliances() {
    currentMatchLoading = true;
    currentMatchError = '';
    try {
      const eventKey = await fetchActiveScoutingEventKey();
      homeEventKey = eventKey || '';
      if (!eventKey) {
        currentEventMatch = null;
        currentMatchState = 'unavailable';
        return;
      }
      const res = await fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(eventKey)}&comp_level=all`);
      const payload = await res.json();
      if (!res.ok || !payload?.success) throw new Error(payload?.error || 'TBA schedule unavailable');
      const next = {};
      for (const match of payload.data || []) {
        next[match.key] = {};
        for (const teamKey of match.alliances?.red?.team_keys || []) next[match.key][teamKey] = 'red';
        for (const teamKey of match.alliances?.blue?.team_keys || []) next[match.key][teamKey] = 'blue';
      }
      matchAllianceByKey = next;
      const current = selectCurrentEventMatch(payload.data || []);
      currentEventMatch = current.match;
      currentMatchState = current.state;

      const myTeamKey = `frc${user?.frc_team || FRC_TEAMS.TEAM_971}`;
      const myTeamMatches = (payload.data || []).filter((m) =>
        (m.alliances?.red?.team_keys || []).includes(myTeamKey) || (m.alliances?.blue?.team_keys || []).includes(myTeamKey));
      const myCurrent = selectCurrentEventMatch(myTeamMatches);
      myTeamNextMatch = myCurrent.match;
      myTeamNextMatchState = myCurrent.state;
    } catch (error) {
      currentMatchError = error?.message || 'TBA schedule unavailable';
    } finally {
      currentMatchLoading = false;
    }
  }

  // Match Scouting's own match_key convention is the bare qualification
  // number ("14"), not TBA's "2026cc_qm14" - see how it saves match_key
  // directly from its "Match #" input. Strips the event prefix and comp-
  // level letters (qm/qf/sf/f) down to just that number.
  function bareMatchNumber(matchKey) {
    const suffix = String(matchKey || '').split('_').pop();
    return /^qm\d+$/i.test(suffix) ? suffix.replace(/^qm/i, '') : suffix;
  }

  function assignmentEventKey(matchKey) {
    return String(matchKey || '').split('_')[0];
  }

  function scoutAssignmentHref(assignment) {
    if (assignment?.scouting_type !== 'data') return `/${scoutAssignmentRoute(assignment?.scouting_type)}`;
    const teamNumber = String(assignment?.team_key || '').replace(/^frc/i, '');
    const alliance = matchAllianceByKey[assignment?.match_key]?.[assignment?.team_key] || '';
    const params = new URLSearchParams({
      event_key: assignmentEventKey(assignment?.match_key),
      match: bareMatchNumber(assignment?.match_key),
      team: teamNumber
    });
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
    const currentMatchTimer = setInterval(() => { if (user) loadMatchAlliances(); }, 60_000);
    return () => { clearTimeout(profileWaitTimer); clearInterval(currentMatchTimer); unsub?.(); unsubAuthUser?.(); unsubReady?.(); uninit?.(); };
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

    <div class="stat-strip">
      {#if homeEventKey}
        <div class="stat-tile">
          <span class="stat-label">Competition</span>
          <strong class="stat-value stat-value-text">{homeEventKey}</strong>
        </div>
      {/if}
      <div class="stat-tile">
        <span class="stat-label">Assignments Open</span>
        <strong class="stat-value">{incompleteScoutAssignments.length}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Assignments Done</span>
        <strong class="stat-value">{completedScoutAssignmentCount}</strong>
      </div>
      <div class="stat-tile">
        <span class="stat-label">Pre-Scout Queue</span>
        <strong class="stat-value">{myPrescoutAssignments.length}</strong>
      </div>
    </div>

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
                  {#if homeEventKey}
                    <a href="/matchscout" class="workspace-card">
                      <ClipboardCheck size={24} />
                      <h4>Scouting</h4>
                      <p>Open competition assignments, scouting forms, and event analysis</p>
                    </a>
                    <a href="/matchrankings" class="workspace-card">
                      <ListOrdered size={24} />
                      <h4>Match Rankings</h4>
                      <p>Live qualification rankings and match results</p>
                    </a>
                    <a href="/strategy" class="workspace-card">
                      <Target size={24} />
                      <h4>Strategy</h4>
                      <p>Alliance selection notes and match strategy</p>
                    </a>
                  {/if}
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
                  <a href="/matchscout" class="btn btn-outline btn-sm">
                    <ListChecks size={14} />
                    Open Scouting
                  </a>
                </div>
                {#if myScoutAssignments.length === 0}
                  <p class="muted">No open scouting assignments right now.</p>
                {:else}
                  <div class="card-grid" style="grid-template-columns: repeat(auto-fit, minmax({assignmentGridMinWidth}px, 1fr));">
                    {#each myScoutAssignments as assignment}
                      <a class="assignment-card" class:completed={!!assignment.completed_at} href={scoutAssignmentHref(assignment)}>
                        <h5>{assignment.scouting_type} scouting - Match #{assignment.match_key.split('_').pop()}</h5>
                        <p class="muted">Team {String(assignment.team_key || '').replace(/^frc/i, '')}</p>
                        {#if assignment.completed_at}
                          <span class="completed-badge"><CheckCircle size={12} /> Done{assignment.scouting_type === 'data' ? ' — tap to edit' : ''}</span>
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

      <!-- Sidebar sits below Your Scouting Assignments now, not competing
           with it for the left column - a tab click pops its preview up in
           the pane to its right instead of navigating away. Deliberately
           not position:sticky - the global .nav-header in +layout.svelte is
           already sticky at top:0 with a much higher z-index, and a second
           sticky element at the same top:0 gets silently covered by it once
           the page scrolls (see ScoutAssignmentPanel's own .panel-header for
           the exact same bug, fixed the same way: don't stick two things to
           the same line). -->
      {#if homeEventKey}
      <div class="quick-nav-row">
        <aside class="quick-nav" aria-label="Competition quick navigation">
          <span class="quick-nav-label">Competition</span>
          {#each QUICK_TABS as tab (tab.key)}
            <button
              type="button"
              class="quick-nav-tab"
              class:active={activeQuickTab === tab.key}
              on:click={() => selectQuickTab(tab.key)}
            >{tab.label}</button>
          {/each}
        </aside>
        <div class="quick-preview">
          {#if activeQuickTabInfo}
            <div>
              <span class="quick-preview-label">{activeQuickTabInfo.label}</span>
              {#if activeQuickTabInfo.key === 'driveteam' && myTeamNextMatch}
                <p class="quick-preview-match-heading">
                  Your team - {myTeamNextMatchState === 'current' ? 'current match' : myTeamNextMatchState === 'upcoming' ? 'up next' : 'latest match'}: {matchDisplayName(myTeamNextMatch)}
                </p>
                <div class="quick-preview-alliances">
                  <div class="current-alliance red"><span>Red</span>{#each myTeamNextMatch.alliances?.red?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
                  <div class="current-alliance blue"><span>Blue</span>{#each myTeamNextMatch.alliances?.blue?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
                </div>
              {:else if activeQuickTabInfo.key === 'driveteam' && !myTeamNextMatch}
                <p>No match found for your team at {homeEventKey || 'the active event'} yet.</p>
              {:else if activeQuickTabInfo.key === 'strategy' && currentEventMatch}
                <p class="quick-preview-match-heading">
                  On the field - {currentMatchState === 'current' ? 'current match' : currentMatchState === 'upcoming' ? 'up next' : 'latest match'}: {matchDisplayName(currentEventMatch)}
                </p>
                <div class="quick-preview-alliances">
                  <div class="current-alliance red"><span>Red</span>{#each currentEventMatch.alliances?.red?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
                  <div class="current-alliance blue"><span>Blue</span>{#each currentEventMatch.alliances?.blue?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
                </div>
              {:else if activeQuickTabInfo.key === 'strategy' && !currentEventMatch}
                <p>No match currently on the field at {homeEventKey || 'the active event'} yet.</p>
              {:else if activeQuickTabInfo.key === 'matchscout'}
                {#if nextDataAssignment}
                  <p class="quick-preview-match-heading">Next assignment: {nextDataAssignment.match_key.split('_').pop()} - Team {String(nextDataAssignment.team_key || '').replace(/^frc/i, '')}</p>
                  <p>{incompleteScoutAssignments.filter(a => a.scouting_type === 'data').length} open match scouting assignment{incompleteScoutAssignments.filter(a => a.scouting_type === 'data').length === 1 ? '' : 's'}.</p>
                {:else}
                  <p>No open match scouting assignments right now.</p>
                {/if}
              {:else if activeQuickTabInfo.key === 'pitscout'}
                <p class="quick-preview-match-heading">{myPrescoutAssignments.length} pre-scouting team{myPrescoutAssignments.length === 1 ? '' : 's'} to research</p>
                <p>{activeQuickTabInfo.blurb}</p>
              {:else if activeQuickTabInfo.key === 'myscout'}
                <p class="quick-preview-match-heading">{completedScoutAssignmentCount} of {myScoutAssignments.length} assignments completed this event</p>
                <p>{activeQuickTabInfo.blurb}</p>
              {:else if quickPreviewLoading[activeQuickTabInfo.key]}
                <p class="muted">Loading...</p>
              {:else if activeQuickTabInfo.key === 'picklist'}
                {#if quickPreviewData.picklist}
                  <p class="quick-preview-match-heading">{quickPreviewData.picklist.count} team{quickPreviewData.picklist.count === 1 ? '' : 's'} on the pick list</p>
                  <p>{quickPreviewData.picklist.count ? `Top picks: ${quickPreviewData.picklist.top.join(', ')}` : activeQuickTabInfo.blurb}</p>
                {:else}
                  <p>{activeQuickTabInfo.blurb}</p>
                {/if}
              {:else if activeQuickTabInfo.key === 'matchrankings'}
                {#if quickPreviewData.matchrankings?.mine}
                  <p class="quick-preview-match-heading">Your team - Rank {quickPreviewData.matchrankings.mine.rank} of {quickPreviewData.matchrankings.totalTeams}</p>
                  <p>{quickPreviewData.matchrankings.mine.record?.wins ?? 0}-{quickPreviewData.matchrankings.mine.record?.losses ?? 0}-{quickPreviewData.matchrankings.mine.record?.ties ?? 0}</p>
                {:else if quickPreviewData.matchrankings}
                  <p>No ranking found for your team yet - {quickPreviewData.matchrankings.totalTeams} teams ranked so far.</p>
                {:else}
                  <p>{activeQuickTabInfo.blurb}</p>
                {/if}
              {:else if activeQuickTabInfo.key === 'powerrankings' || activeQuickTabInfo.key === 'robotratings'}
                {#if quickPreviewData[activeQuickTabInfo.key]}
                  <p class="quick-preview-match-heading">{quickPreviewData[activeQuickTabInfo.key].scoutedTeams} teams have local scouting data</p>
                  <p>{activeQuickTabInfo.blurb}</p>
                {:else}
                  <p>{activeQuickTabInfo.blurb}</p>
                {/if}
              {:else if activeQuickTabInfo.key === 'predictions'}
                {#if quickPreviewData.predictions}
                  <p class="quick-preview-match-heading">{quickPreviewData.predictions.count} prediction{quickPreviewData.predictions.count === 1 ? '' : 's'} placed this event</p>
                  <p>{activeQuickTabInfo.blurb}</p>
                {:else}
                  <p>{activeQuickTabInfo.blurb}</p>
                {/if}
              {:else if activeQuickTabInfo.key === 'scouting-admin'}
                {#if quickPreviewData['scouting-admin']}
                  <p class="quick-preview-match-heading">{quickPreviewData['scouting-admin'].canEdit ? 'You have edit access' : 'You have view-only access'}</p>
                  <p>{activeQuickTabInfo.blurb}</p>
                {:else}
                  <p>{activeQuickTabInfo.blurb}</p>
                {/if}
              {:else}
                <p>{activeQuickTabInfo.blurb}</p>
              {/if}
            </div>
            <div class="quick-preview-actions">
              <a class="btn btn-primary btn-sm" href={activeQuickTabInfo.href}>Open</a>
              <button class="btn btn-outline btn-sm" on:click={() => activeQuickTab = null}>Close</button>
            </div>
          {:else}
            <p class="muted">Select a tab on the left to preview it here.</p>
          {/if}
        </div>
      </div>
      {/if}

      {#if currentMatchLoading && !currentEventMatch}
        <div class="current-match-card current-match-loading">Loading the {homeEventKey || 'active event'} field...</div>
      {:else if currentEventMatch}
        <div class="current-match-card" class:live={currentMatchState === 'current'}>
          <div class="current-match-heading">
            <div>
              <span class="current-match-eyebrow">{homeEventKey}</span>
              <h4>{currentMatchState === 'current' ? 'Current match' : currentMatchState === 'upcoming' ? 'Up next' : 'Latest match'}</h4>
            </div>
            <strong>{matchDisplayName(currentEventMatch)}</strong>
          </div>
          <div class="current-match-alliances">
            <div class="current-alliance red"><span>Red</span>{#each currentEventMatch.alliances?.red?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
            <div class="current-alliance blue"><span>Blue</span>{#each currentEventMatch.alliances?.blue?.team_keys || [] as teamKey}<b>{displayTeamNumber(teamKey)}</b>{/each}</div>
          </div>
          {#if currentMatchState === 'complete'}<small>TBA reports this event’s published matches complete.</small>{/if}
        </div>
      {:else if currentMatchError}
        <div class="current-match-card current-match-loading">Current match unavailable: {currentMatchError}</div>
      {/if}
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

  /* No more capped-width centered column - the quick-nav sidebar takes the
     left gutter and the content column stretches to fill whatever's left,
     so wide monitors don't just get more black margin on both sides. */
  .dashboard-container {
    /* Sharp corners throughout this page, by direct instruction - no
       filleted rectangles. */
    --home-radius: 0;
    min-width: 0;
    /* Full-bleed breakout: the global <main> this sits in (see +layout.svelte's
       main.container.page-container) is itself centered and capped at
       --page-max-width, so content could only ever reach the left edge of
       THAT column, not the actual viewport edge. width:100vw + this margin
       math is the standard way to escape a centered ancestor without
       touching the shared layout (which every other route also depends on). */
    width: 100vw;
    margin-left: calc(50% - 50vw);
    margin-right: calc(50% - 50vw);
    padding: var(--space-4) var(--space-5);
  }

  /* Sidebar + its preview pane, side by side, below the rest of the
     dashboard rather than competing with it for the left column. */
  .quick-nav-row {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    align-items: stretch;
    gap: var(--space-5);
    margin-top: var(--space-7);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }

  /* All 11 tabs stay visible with no internal scrollbar of their own -
     hiding nav items behind a scroll a visitor might never notice is worse
     than the list just being what it is. Kept short per-item instead
     (compact padding/font below) so the whole thing still stays modest. */
  .quick-nav {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    background: var(--surface-1);
  }

  .quick-nav-label {
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: var(--space-2) var(--space-4) 6px;
    border-bottom: 1px solid var(--border);
  }

  .quick-nav-tab {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px var(--space-4);
    border: none;
    border-left: 3px solid transparent;
    border-bottom: 1px solid var(--border);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.8rem;
    line-height: 1.3;
    cursor: pointer;
    transition: border-color 0.1s ease, background-color 0.1s ease, color 0.1s ease;
  }

  .quick-nav-tab:last-child {
    border-bottom: none;
  }

  .quick-nav-tab:hover {
    border-left-color: var(--brand-gold-strong);
    background: var(--surface-2);
    color: var(--secondary);
  }

  .quick-nav-tab.active {
    border-left-color: var(--accent-strong);
    background: var(--accent-subtle);
    color: var(--secondary);
    font-weight: 600;
  }

  .quick-preview {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-4);
    min-height: 100%;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent-strong);
    padding: var(--space-4) var(--space-5);
  }

  .quick-preview > .muted {
    align-self: center;
    margin: auto;
  }

  .quick-preview-label {
    display: block;
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-1);
  }

  .quick-preview p {
    margin: 0;
    color: var(--text-secondary);
    max-width: 48em;
  }

  .quick-preview-match-heading {
    margin: 0 0 var(--space-2) !important;
    font-weight: 600;
    color: var(--secondary);
  }

  .quick-preview-alliances {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-3);
    max-width: 32em;
  }

  .quick-preview-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }


  /* Compact masthead with a gold spine — no dead vertical space */
  .user-welcome {
    background: var(--primary);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--home-radius, var(--radius-lg));
    padding: var(--space-3) var(--space-6);
    margin-bottom: var(--space-3);
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

  /* A telemetry-strip, not another row of rounded cards: tiles share
     hairlines instead of each carrying their own border, which reads as one
     continuous instrument rather than four separate boxes. */
  .stat-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    margin-bottom: var(--space-3);
  }

  .stat-tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: var(--surface-1);
    padding: var(--space-2) var(--space-5);
  }

  .stat-label {
    font-family: var(--font-mono-stack);
    font-size: var(--font-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: var(--font-xxl, 1.75rem);
    font-weight: 700;
    color: var(--secondary);
    line-height: 1.1;
  }

  .stat-value-text {
    font-size: var(--font-lg);
    font-family: var(--font-mono-stack);
    text-transform: uppercase;
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
    margin: 0 0 var(--space-2) 0;
    color: var(--secondary);
    font-size: var(--font-xl);
  }

  .current-match-card {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-7);
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--border);
    border-left: 4px solid var(--brand-gold-strong);
    border-radius: var(--home-radius, var(--radius-lg));
    background: var(--surface-1);
  }
  .current-match-card.live { border-left-color: var(--success, #2e7d32); }
  .current-match-loading { color: var(--text-muted); }
  .current-match-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
  .current-match-heading h4 { margin:.15rem 0 0; color:var(--secondary); }
  .current-match-heading strong { font-size:var(--font-lg); }
  .current-match-eyebrow { color:var(--text-muted); font-size:var(--font-xs); font-family:var(--font-mono-stack); text-transform:uppercase; }
  .current-match-alliances { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--gap-3); }
  .current-alliance { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-3); }
  .current-alliance span { margin-right:auto; font-weight:700; text-transform:uppercase; font-size:var(--font-xs); }
  .current-alliance b { min-width:2.7rem; text-align:center; }
  .current-alliance.red { background:var(--red-soft); color:var(--red-strong); }
  .current-alliance.blue { background:var(--blue-soft, #e8f1ff); color:var(--blue-strong, #174ea6); }
  .current-match-card small { color:var(--text-muted); }

  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
    border-left: 3px solid var(--border);
    padding: var(--space-5) var(--space-6);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .workspace-card:hover,
  .action-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
    border-left-color: var(--brand-gold-strong);
  }

  .workspace-card :global(svg),
  .action-card :global(svg) {
    grid-row: 1 / span 2;
    width: 28px;
    height: 28px;
    padding: 11px;
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  .workspace-card h4,
  .action-card h4 {
    grid-column: 2;
    margin: 0;
    color: var(--secondary);
    font-size: var(--font-lg);
  }

  .workspace-card p,
  .action-card p {
    grid-column: 2;
    margin: 0;
    color: var(--neutral-500);
    font-size: var(--font-sm);
    line-height: 1.4;
  }

  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--gap-3);
    margin-top: var(--space-2);
    /* Caps how tall a long assignment list can push the page - scrolls
       internally past that instead (part of the page-wide no-scroll
       constraint on .dashboard-container below). */
    max-height: 190px;
    overflow-y: auto;
  }

  .assignment-card {
    display: block;
    text-decoration: none;
    color: inherit;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand-gold-strong);
    padding: var(--space-4) var(--space-5);
    transition: border-color 0.1s ease, background-color 0.1s ease;
  }

  .assignment-card:hover {
    background: var(--surface-2);
    border-color: var(--accent-strong);
    border-left-color: var(--accent-strong);
  }

  .assignment-card h5 { margin: 0 0 var(--space-1) 0; color: var(--secondary); }
  .assignment-card p { margin: 0; color: var(--neutral-500); font-size: var(--font-xs); }
  .assignment-card.completed { opacity: 0.72; border-left-color: var(--success, #2e7d32); }
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

  /* Sidebar becomes a horizontal scrollable tab strip above the content
     instead of a column competing for width - a 200px rail has no business
     existing below tablet width. */
  @media (max-width: 900px) {
    .quick-nav-row { grid-template-columns: 1fr; }
    .quick-nav { flex-direction: row; overflow-x: auto; }
    .quick-nav-label { flex-shrink: 0; border-bottom: none; border-right: 1px solid var(--border); }
    .quick-nav-tab { flex-shrink: 0; width: auto; border-bottom: none; border-right: 1px solid var(--border); border-left: none; border-top: 3px solid transparent; }
    .quick-nav-tab:last-child { border-right: none; }
    .quick-nav-tab:hover { border-left-color: transparent; border-top-color: var(--brand-gold-strong); }
    .quick-nav-tab.active { border-left-color: transparent; border-top-color: var(--accent-strong); }
    .quick-preview { flex-direction: column; }
  }

  /* Mobile Responsive Styles */
  @media (max-width: 768px) {
    .auth-container {
      margin: var(--space-4) auto;
      padding: 0 var(--space-3);
    }
    .auth-card { padding: var(--space-6); }
    .brand h1 { font-size: var(--font-xl); }
    .dashboard-container { width: auto; margin: 0; padding: var(--space-4) var(--space-3); }
    .user-welcome { padding: var(--space-6); }
    .user-welcome h2 { font-size: var(--font-md); margin-bottom: var(--space-3); }
    .workspace-grid, .action-grid { grid-template-columns: 1fr; gap: var(--gap-3); }
    .current-match-alliances { grid-template-columns: 1fr; }
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

  /* Putting Workspace/Admin next to the assignment queue squeezed both into
     a narrow outer column - Workspace's own 3-card row had nowhere near
     enough width and its card text was clipping. Each section spans the
     full (now much wider) container instead, and branches out
     horizontally inside itself: workspace-grid/card-grid below both use
     auto-fit, so they pick up as many columns as the full width allows. */
  .dashboard-sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
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
