<script>
  import { onMount } from 'svelte';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { userStore, getUserUUID } from '$lib/stores/user.js';
  import { fetchUserProfile } from '$lib/stores/auth.js';
  import { PERMISSIONS, hasPermission, GENERAL_ROLES, PURCHASING_ROLES, TEAM_ROLES, FRC_TEAMS } from '$lib/permissions.js';
  import { supabase } from '$lib/supabase.js';
  import { get } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { ShoppingCart, DollarSign, TrendingUp, Package, Plus, Edit, Trash2, User } from 'lucide-svelte';
  import { toastActions } from '$lib/toast.js';
  import {
    fetchAttendanceLocations,
    fetchAttendanceSchedules,
    fetchAttendanceLeaderboard,
    createAttendanceLocation,
    updateAttendanceLocation,
    deleteAttendanceLocation,
    createAttendanceSchedule,
    updateAttendanceSchedule,
    deleteAttendanceSchedule,
    getCurrentNetworkFingerprint
  } from '$lib/attendance.js';
  import BudgetsTab from './BudgetsTab.svelte';
  import PlannerCalendarTab from './PlannerCalendarTab.svelte';
  import ActivityLogTab from './ActivityLogTab.svelte';
  const BOT_BASE_URL = import.meta.env?.VITE_BOT_BASE_URL || '/api/971bot';

  // Tab management
  let activeTab = 'access'; // 'access', 'purchasing', 'rosters', 'planner-calendar'

  // Hidden tabs: kept fully in place (nav button + content + all logic) but
  // not shown in the tab bar. Flip back to true to re-enable, no code to
  // restore.
  const SHOW_GANTT_TAB = false;
  const SHOW_ATTENDANCE_TAB = false;
  async function notifyUserNeedsApproval(u) {
    try {
      await fetch(`${BOT_BASE_URL}/notify/user_registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: u.id, name: u.full_name || u.email || u.id })
      });
    } catch (e) {
      console.warn('Failed to notify bot about user', u.id, e);
    }
  }

  // User management state
  let users = [];
  let loading = false;
  let error = null;
  let userSearchQuery = '';
  let generalRoleFilter = 'all';
  let purchasingRoleFilter = 'all';
  let teamRoleFilter = 'all';
  let frcTeamFilter = 'all';
  let approvalFilter = 'all';
  let savingRoleIds = new Set();

  // Roster Management State
  let rosters = [];
  let rosterKeys = [];
  let rosterEntries = [];
  let selectedRoster = null;
  let loadingRosters = false;
  let showCreateRosterModal = false;
  let newRosterName = '';
  let newRosterType = 'multi';
  let newRosterPublic = false;
  let newRosterAdmin = false;
  let newRosterTargetFrcTeam = 'all'; // all, students, 971, 9584
  let newKeyName = '';
  let newKeyCategory = 'General';
  let rosterSearchQuery = '';
  let rosterMemberSearchQuery = '';

  // Purchasing admin state
  let vendors = [];
  let purchaseHistory = [];
  let orders = [];
  let loadingVendors = false;
  let loadingPurchases = false;
  let loadingOrders = false;
  let showAddVendorModal = false;
  let showEditVendorModal = false;
  let editingVendor = null;
  let vendorName = '';
  let vendorUrlBase = '';
  let vendorFreeShipping = false;
  
  // Attendance admin state
  const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let attendanceLocations = [];
  let attendanceSchedules = [];
  let attendanceLeaderboard = [];
  let attendanceSearch = '';
  let attendanceLocationsLoading = false;
  let attendanceSchedulesLoading = false;
  let attendanceLeaderboardLoading = false;
  let savingLocation = false;
  let savingSchedule = false;
  let capturingNetwork = false;
  let showLocationForm = false;
  let showScheduleForm = false;
  let editingLocation = null;
  let editingSchedule = null;
  const defaultLocationForm = { name: '', network_cidr: '', description: '', active: true };
  const defaultScheduleForm = { label: '', day_of_week: 1, start_time: '19:00', end_time: '21:00', location_ids: [], active: true };
  let locationForm = { ...defaultLocationForm };
  let scheduleForm = { ...defaultScheduleForm };
  let attendanceSearchTimeout;
  
  // Analytics filters
  let timePeriodDays = 30;
  let customStartDate = '';
  let customEndDate = '';

  const defaultGeneralRole = GENERAL_ROLES.NONE;
  const defaultPurchasingRole = PURCHASING_ROLES.BASIC;
  const defaultTeamRole = TEAM_ROLES.OTHER;
  const defaultFrcTeam = null; // No default FRC team

  const frcTeamThemes = {
    '971': { bg: 'var(--blue-soft)', border: '#bfdbfe', text: '#1e3a8a' },
    '9584': { bg: '#dcfce7', border: '#bbf7d0', text: 'var(--green-strong)' },
    'Mentor': { bg: '#fef3c7', border: '#fde68a', text: '#92400e' },
    null: { bg: 'var(--muted-bg)', border: '#e5e7eb', text: '#6b7280' }
  };

  const generalRoleThemes = {
    [GENERAL_ROLES.NONE]: { bg: 'var(--muted-bg)', border: '#e5e7eb', text: '#6b7280' },
    [GENERAL_ROLES.MEMBER]: { bg: 'var(--blue-soft)', border: '#bfdbfe', text: '#1e3a8a' },
    [GENERAL_ROLES.SUBSYSTEM_LEAD]: { bg: '#fef3c7', border: '#fde68a', text: '#92400e' },
    [GENERAL_ROLES.LEAD]: { bg: '#dcfce7', border: '#bbf7d0', text: 'var(--green-strong)' }
  };

  const purchasingRoleThemes = {
    [PURCHASING_ROLES.BASIC]: { bg: '#f3f4f6', border: '#e5e7eb', text: '#374151' },
    [PURCHASING_ROLES.APPROVER]: { bg: '#e0f2f1', border: '#bae4de', text: '#0f766e' },
    [PURCHASING_ROLES.LEAD]: { bg: '#fee2e2', border: '#fecaca', text: '#991b1b' },
    [PURCHASING_ROLES.BUDGETING]: { bg: '#ede9fe', border: '#ddd6fe', text: '#5b21b6' }
  };

  const teamRoleThemes = {
    [TEAM_ROLES.COMPETITION_LEAD]: { bg: '#e0e7ff', border: '#c7d2fe', text: '#3730a3' },
    [TEAM_ROLES.MECHANICAL_LEAD]: { bg: '#fef3c7', border: '#fde68a', text: '#92400e' },
    [TEAM_ROLES.SOFTWARE_LEAD]: { bg: '#ddd6fe', border: '#c4b5fd', text: '#5b21b6' },
    [TEAM_ROLES.MANUFACTURING_LEAD]: { bg: '#dcfce7', border: '#bbf7d0', text: 'var(--green-strong)' },
    [TEAM_ROLES.MANUFACTURING_MEMBER]: { bg: '#fff7ed', border: '#fed7aa', text: 'var(--orange-strong)' },
    [TEAM_ROLES.PURCHASING_LEAD]: { bg: '#ccfbf1', border: '#99f6e4', text: '#115e59' },
    [TEAM_ROLES.CAD_MEMBER]: { bg: '#fef2f2', border: '#fee2e2', text: '#991b1b' },
    [TEAM_ROLES.SOFTWARE_MEMBER]: { bg: '#e0f2fe', border: '#bae6fd', text: '#075985' },
    [TEAM_ROLES.OTHER]: { bg: '#f3f4f6', border: '#e5e7eb', text: '#374151' }
  };

  const approvalFilterOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'pending', label: 'Pending Approval' },
    { value: 'approved', label: 'Approved' }
  ];

  const generalRoleOptions = Object.values(GENERAL_ROLES);
  const purchasingRoleOptions = Object.values(PURCHASING_ROLES);
  const teamRoleOptions = Array.from(new Set(Object.values(TEAM_ROLES)));
  const frcTeamOptions = Object.values(FRC_TEAMS);

  // Manufacturing lead notification categories. Matches parts.workflow
  // values / WORKFLOW_LABELS in src/lib/server/slack_notifications.js -
  // keep in sync if a new workflow's notifications get wired up.
  const manufacturingNotifyOptions = [
    { value: '3d-print', label: '3D Print' },
    { value: 'router', label: 'Router' },
    { value: 'lathe', label: 'Lathe' }
  ];

  function toggleManufacturingNotify(user, workflow, checked) {
    const current = Array.isArray(user.manufacturing_lead_workflows) ? user.manufacturing_lead_workflows : [];
    const next = checked
      ? Array.from(new Set([...current, workflow]))
      : current.filter((w) => w !== workflow);
    updateUserNotifications(user, { manufacturing_lead_workflows: next });
  }

  // Vision alerts: a single opt-in flag (user_profiles.vision_notify),
  // separate from the manufacturing per-workflow array above since there's
  // only one vision alert category (run failures + new critical
  // discrepancies - see notifyVisionRunFailed/notifyVisionCriticalDiscrepancy
  // in slack_notifications.js) rather than a set of workflows to pick from.
  function toggleVisionNotify(user, checked) {
    updateUserNotifications(user, { vision_notify: checked });
  }

  // Vision Scouting itself is open to every approved user (see
  // scoutingvision.md) - VISION_RELEASE is the only gated action, for
  // pushing results into real scout_data_events/power rankings. Granted as
  // a real PERMISSIONS entry (see src/lib/permissions.js), not role-derived,
  // so this writes user.permissions directly via the generic permission-
  // update path api/admin/+server.js already exposes (POST with no
  // `action`, just permissions[]) rather than going through update-roles,
  // which only ever recomputes permissions from roles + whatever manual
  // extras already existed - it has no way to accept a newly-added manual
  // permission from the request body.
  const visionPermissionOptions = [
    { value: 'VISION_RELEASE', label: 'Vision Release' }
  ];

  async function toggleVisionPermission(user, perm, checked) {
    if (!canEditRolesOf(user)) {
      toastActions.show(
        user?.id === $currentUser?.id
          ? 'You cannot change your own permissions here'
          : user?.is_dev
            ? "Only a dev can change another dev's permissions"
            : "Only an admin can change another admin's permissions"
      );
      users = [...users];
      return;
    }
    const current = Array.isArray(user.permissions) ? user.permissions : [];
    const next = checked
      ? Array.from(new Set([...current, perm]))
      : current.filter((p) => p !== perm);
    setSaving(user.id, true);
    const optimisticUsers = users.map((u) => (u.id === user.id ? { ...u, permissions: next } : u));
    users = optimisticUsers;
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({ actor_id: await resolveActorId(), target_id: user.id, permissions: next })
      });
      const resBody = await res.json();
      if (!res.ok) throw new Error(resBody.error || 'Failed to update permission');
      toastActions.show('Vision permission updated');
    } catch (err) {
      console.error('Failed to update vision permission', err);
      toastActions.show(err.message || 'Failed to update permission');
      users = users.map((u) => (u.id === user.id ? { ...u, permissions: current } : u));
    } finally {
      setSaving(user.id, false);
    }
  }

  function formatRoleLabel(value) {
    if (!value) return 'Unassigned';
    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  }

  function formatFrcTeamLabel(value) {
    if (!value) return 'Not Set';
    if (value === 'Mentor') return 'Mentor';
    return `Team ${value}`;
  }

  function roleThemeStyle(theme) {
    const safeTheme = theme || { bg: 'var(--surface-1)', border: 'var(--border)', text: 'var(--text)' };
    return `--role-bg:${safeTheme.bg}; --role-border:${safeTheme.border}; --role-text:${safeTheme.text};`;
  }

  const isUserApproved = (user) => hasPermission(user, 'CAN_SEE_ROUTES');

  function resetUserFilters() {
    userSearchQuery = '';
    generalRoleFilter = 'all';
    purchasingRoleFilter = 'all';
    teamRoleFilter = 'all';
    frcTeamFilter = 'all';
    approvalFilter = 'all';
  }

  function setSaving(userId, isSaving) {
    const next = new Set(savingRoleIds);
    if (isSaving) {
      next.add(userId);
    } else {
      next.delete(userId);
    }
    savingRoleIds = next;
  }

  // Computed analytics
  $: approverStats = computeApproverStats(purchaseHistory, timePeriodDays, customStartDate, customEndDate);
  $: projectStats = computeProjectStats(purchaseHistory, timePeriodDays, customStartDate, customEndDate);
  $: vendorStats = computeVendorStats(purchaseHistory, vendors, timePeriodDays, customStartDate, customEndDate);
  $: ordererStats = computeOrdererStats(purchaseHistory, timePeriodDays, customStartDate, customEndDate);
  $: totalSpending = computeTotalSpending(purchaseHistory, timePeriodDays, customStartDate, customEndDate);
  $: orderStats = computeOrderStats(orders, purchaseHistory, timePeriodDays, customStartDate, customEndDate);
  const countedPurchaseStatuses = new Set(['approved', 'ordered', 'delivered', 'kitted', 'pickup', 'picked_up']);

  function computeApproverStats(purchases, days, startDate, endDate) {
    const filtered = filterByTimePeriod(purchases, days, startDate, endDate);
    const stats = {};
    const BUDGET_EXEMPT = 'Budget Exempt';

    filtered.forEach(p => {
      // Completely ignore Budget Exempt items in analytics
      if ((p.project_id || '').trim() === BUDGET_EXEMPT) return;

      if (p.approver && countedPurchaseStatuses.has(p.status)) {
        if (!stats[p.approver]) {
          stats[p.approver] = { count: 0, total: 0 };
        }
        stats[p.approver].count++;
        stats[p.approver].total += (p.final_price || p.price || 0) * (p.quantity || 1);
      }
    });
    return Object.entries(stats).map(([name, data]) => ({
      approver: name,
      count: data.count,
      total: data.total
    })).sort((a, b) => b.total - a.total);
  }

  function computeOrdererStats(purchases, days, startDate, endDate) {
    const filtered = filterByTimePeriod(purchases, days, startDate, endDate);
    const stats = {};
    const BUDGET_EXEMPT = 'Budget Exempt';

    filtered.forEach(p => {
      // Ignore budget-exempt items
      if ((p.project_id || '').trim() === BUDGET_EXEMPT) return;

      const ordererName = p.requester || 'Unknown';
      if (countedPurchaseStatuses.has(p.status)) {
        if (!stats[ordererName]) {
          stats[ordererName] = { count: 0, total: 0 };
        }
        stats[ordererName].count++;
        stats[ordererName].total += (p.final_price || p.price || 0) * (p.quantity || 1);
      }
    });
    return Object.entries(stats).map(([name, data]) => ({
      orderer: name,
      count: data.count,
      total: data.total
    })).sort((a, b) => b.total - a.total);
  }

  function computeProjectStats(purchases, days, startDate, endDate) {
    const filtered = filterByTimePeriod(purchases, days, startDate, endDate);
    const stats = {};
    const BUDGET_EXEMPT = 'Budget Exempt';

    filtered.forEach(p => {
      // Skip budget-exempt projects entirely
      if ((p.project_id || '').trim() === BUDGET_EXEMPT) return;

      if (p.project_id && countedPurchaseStatuses.has(p.status)) {
        if (!stats[p.project_id]) {
          stats[p.project_id] = { count: 0, total: 0 };
        }
        stats[p.project_id].count++;
        stats[p.project_id].total += (p.final_price || p.price || 0) * (p.quantity || 1);
      }
    });
    return Object.entries(stats).map(([project, data]) => ({
      project_id: project,
      count: data.count,
      total: data.total
    })).sort((a, b) => b.total - a.total);
  }

  function computeVendorStats(purchases, vendorList, days, startDate, endDate) {
    const filtered = filterByTimePeriod(purchases, days, startDate, endDate);
    const vendorNames = new Set(vendorList.map(v => v.name.toLowerCase()));
    const stats = {};
    const BUDGET_EXEMPT = 'Budget Exempt';

    filtered.forEach(p => {
      // Ignore budget-exempt items
      if ((p.project_id || '').trim() === BUDGET_EXEMPT) return;

      if (countedPurchaseStatuses.has(p.status)) {
        // Normalize vendor name for matching
        const rawVendor = p.vendor || '';
        const normalizedVendor = rawVendor.trim().toLowerCase();
        
        // Check if this vendor is in our vendor table
        let vendorKey = 'Other';
        if (normalizedVendor && vendorNames.has(normalizedVendor)) {
          // Find the proper case version
          const match = vendorList.find(v => v.name.toLowerCase() === normalizedVendor);
          vendorKey = match ? match.name : rawVendor;
        }
        
        if (!stats[vendorKey]) {
          stats[vendorKey] = { count: 0, total: 0 };
        }
        stats[vendorKey].count++;
        stats[vendorKey].total += (p.final_price || p.price || 0) * (p.quantity || 1);
      }
    });
    
    return Object.entries(stats).map(([vendor, data]) => ({
      vendor: vendor,
      count: data.count,
      total: data.total
    })).sort((a, b) => b.total - a.total);
  }

  function computeTotalSpending(purchases, days, startDate, endDate) {
    const filtered = filterByTimePeriod(purchases, days, startDate, endDate);
    let total = 0;
    let items = 0;
    const BUDGET_EXEMPT = 'Budget Exempt';

    filtered.forEach(p => {
      // Ignore budget-exempt items
      if ((p.project_id || '').trim() === BUDGET_EXEMPT) return;

      if (countedPurchaseStatuses.has(p.status)) {
        const qty = p.quantity || 1;
        const itemCost = (p.final_price || p.price || 0) * qty;
        const shippingAlloc = Number(p.shipping_cost_allocated || 0);
        total += itemCost + shippingAlloc;
        items += qty;
      }
    });

    return { total, count: items };
  }

  function computeOrderStats(ordersList, purchases, days, startDate, endDate) {
    const filteredOrders = ordersList.filter(o => {
      const date = new Date(o.placed_at);
      if (customStartDate && customEndDate) {
        return date >= new Date(customStartDate) && date <= new Date(customEndDate);
      } else {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return date >= cutoff;
      }
    });

    const eligibleStatuses = countedPurchaseStatuses;
    const BUDGET_EXEMPT = 'Budget Exempt';

    // Compute order totals by summing their purchases (excluding Budget Exempt items)
    const totalOrderSpending = filteredOrders.reduce((sum, o) => {
      const orderPurchases = purchases.filter(p => p.order_id === o.id && eligibleStatuses.has(p.status) && (p.project_id || '').trim() !== BUDGET_EXEMPT);
      const itemsSum = orderPurchases.reduce((s, p) => s + (p.final_price || p.price || 0) * (p.quantity || 1), 0);
      const shippingSum = orderPurchases.reduce((s, p) => s + Number(p.shipping_cost_allocated || 0), 0);
      return sum + itemsSum + shippingSum;
    }, 0);

    // Count only orders that have non-exempt purchases
    const orderCount = filteredOrders.filter(o => purchases.some(p => p.order_id === o.id && eligibleStatuses.has(p.status) && (p.project_id || '').trim() !== BUDGET_EXEMPT)).length;

    // Calculate spending on non-order items (approved but not in an order), excluding Budget Exempt
    const filteredPurchases = filterByTimePeriod(purchases, days, customStartDate, customEndDate);
    const scopedPurchases = filteredPurchases.filter(p => eligibleStatuses.has(p.status) && (p.project_id || '').trim() !== BUDGET_EXEMPT);

    const nonOrderSpending = scopedPurchases
      .filter(p => !p.order_id)
      .reduce((sum, p) => sum + (p.final_price || p.price || 0) * (p.quantity || 1), 0);

    const totalShippingCost = scopedPurchases
      .reduce((sum, p) => sum + Number(p.shipping_cost_allocated || 0), 0);

    return {
      totalOrderSpending,
      totalShippingCost,
      orderCount,
      nonOrderSpending,
      averageOrderCost: orderCount > 0 ? totalOrderSpending / orderCount : 0
    };
  }

  function computeOrderPlacerStats(ordersList, days, startDate, endDate) {
    const filteredOrders = ordersList.filter(o => {
      const date = new Date(o.placed_at);
      if (customStartDate && customEndDate) {
        return date >= new Date(customStartDate) && date <= new Date(customEndDate);
      } else {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return date >= cutoff;
      }

    });

    const stats = {};
    filteredOrders.forEach(o => {
      const placer = o.placed_by_email || 'Unknown';
      if (!stats[placer]) {
        stats[placer] = { count: 0, totalCost: 0, totalShipping: 0 };
      }
      stats[placer].count++;
      stats[placer].totalCost += (o.total_cost || 0);
      stats[placer].totalShipping += (o.shipping_cost || 0);
    });

    return Object.entries(stats).map(([placer, data]) => ({
      placer,
      count: data.count,
      totalCost: data.totalCost,
      totalShipping: data.totalShipping,
      totalSpent: data.totalCost + data.totalShipping
    })).sort((a, b) => b.totalSpent - a.totalSpent);
  }

  function filterByTimePeriod(purchases, days, startDate, endDate) {
    const now = new Date();
    let cutoff;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      return purchases.filter(p => {
        const date = new Date(p.created_at);
        return date >= start && date <= end;
      });
    } else {
      cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      return purchases.filter(p => {
        const date = new Date(p.created_at);
        return date >= cutoff;
      });
    }
  }

  async function getAuthHeader() {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  async function resolveActorId() {
    let actorId = get(currentUser)?.id || getUserUUID();
    if (!actorId) {
      try {
        const { data } = await supabase.auth.getSession();
        actorId = data?.session?.user?.id || actorId;
      } catch (err) {
        console.warn('Failed to resolve actor id from session', err);
      }
    }
    return actorId;
  }

  async function performUserAction(targetId, action) {
    const actorId = await resolveActorId();
    if (!actorId) throw new Error('Unable to determine current user id; refresh and try again.');
    const auth = await getAuthHeader();

    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ actor_id: actorId, target_id: targetId, action })
    });

    if (!res.ok) {
      let body = {};
      try {
        body = await res.json();
      } catch {
        // ignore json parse errors
      }
      throw new Error(body.error || `Failed to ${action} user`);
    }
  }

  const currentUser = userStore;
  let adminAccessChecked = false;
  // Check if user has admin access (only leads can access this page)
  $: canAccessAdmin = !!($currentUser && hasPermission($currentUser, 'VIEW_ADMIN_PANEL'));
  // Per-action permission flags (admins can do everything).
  $: isAdminUser = $currentUser?.role === 'admin';
  // Devs are a tier above regular admins — see $lib/permissions.js isDev().
  // Nothing below grants extra day-to-day permissions from this; it only
  // gates who may touch a dev's own account.
  $: isDevUser = !!$currentUser?.is_dev;
  $: canApproveUsers = !!($currentUser && (isAdminUser || hasPermission($currentUser, 'APPROVE_USERS')));
  $: canBanUsers = !!($currentUser && (isAdminUser || hasPermission($currentUser, 'BAN_USERS')));
  // Granting the 'admin' role itself is admin-only — leads with PROMOTE_USERS
  // can still approve/manage users elsewhere, just not mint new admins.
  $: canPromoteUsers = isAdminUser;
  $: canRemoveUsers = canBanUsers;
  // Show an Actions column when the current user can do at least one action.
  $: showUserActions = canApproveUsers || canBanUsers || canPromoteUsers || canRemoveUsers;

  // Who may edit a given target's roles: nobody may edit their own row here
  // (avoids accidental self-lockout/self-escalation); dev targets require a
  // dev actor; admin targets (dev or not) require an admin actor; everyone
  // else is editable by anyone who can reach this page's role editor at all.
  function canEditRolesOf(target) {
    // Devs are unrestricted: they can edit each other's roles and their own.
    if (isDevUser) return true;
    if (target?.id && target.id === $currentUser?.id) return false;
    if (target?.is_dev) return false;
    if (target?.role === 'admin') return isAdminUser;
    return true;
  }

  // Notification subscriptions do not grant access, so unlike roles and
  // permissions they are safe for an authorized admin to edit on their own
  // row. Target hierarchy still applies when editing somebody else.
  function canEditNotificationsOf(target) {
    const canManage = isAdminUser || isDevUser || hasPermission($currentUser, 'EDIT_PERMISSIONS');
    if (!canManage) return false;
    if (target?.id && target.id === $currentUser?.id) return true;
    if (target?.is_dev) return isDevUser;
    if (target?.role === 'admin') return isAdminUser;
    return true;
  }

  // Tooltip explaining why a disabled role <select> can't be used, so the
  // restriction isn't silent. Returns null when editing is allowed or the
  // control is merely mid-save (not a permission issue).
  function roleEditDisabledReason(target) {
    if (savingRoleIds.has(target?.id)) return null;
    if (canEditRolesOf(target)) return null;
    return 'You are not permitted to perform this action.';
  }

  // Dev-only audit: every user holding the Lead general role, for the
  // Dev tab's permission breakdown.
  $: leadsList = users.filter((u) => u.general_role === GENERAL_ROLES.LEAD);

  // In-app confirmation modal (replaces window.confirm for destructive actions).
  let pendingConfirm = null; // { title, message, confirmLabel, danger, run }
  function askConfirm(cfg) { pendingConfirm = cfg; }
  function cancelConfirm() { pendingConfirm = null; }
  async function runConfirm() {
    const cfg = pendingConfirm;
    pendingConfirm = null;
    if (cfg?.run) await cfg.run();
  }

  const userLabel = (user) => user.full_name || user.email || 'this user';

  // --- Action executors -------------------------------------------------------
  async function doUserAction(user, action, { successMsg, removeFromList = false } = {}) {
    setSaving(user.id, true);
    try {
      await performUserAction(user.id, action);
      if (removeFromList) {
        users = users.filter((u) => u.id !== user.id);
      } else {
        await loadUsers();
      }
      toastActions.show(successMsg || 'Done');
    } catch (err) {
      console.error(`Failed to ${action} user`, err);
      toastActions.show(err.message || `Failed to ${action} user`);
    } finally {
      setSaving(user.id, false);
    }
  }

  function approveUser(user) {
    doUserAction(user, 'approve', { successMsg: `${userLabel(user)} approved` });
  }

  function promoteUser(user) {
    askConfirm({
      title: 'Make admin',
      message: `Grant ${userLabel(user)} full admin access? They will be able to manage all users, permissions, and settings.`,
      confirmLabel: 'Make admin',
      danger: false,
      run: () => doUserAction(user, 'promote', { successMsg: `${userLabel(user)} is now an admin` })
    });
  }

  // Permanently delete a user's account profile — always behind confirmation.
  function removeUser(user) {
    if (get(currentUser)?.id === user.id) { toastActions.show('You cannot remove your own account'); return; }
    askConfirm({
      title: 'Remove user',
      message: `Permanently delete ${userLabel(user)}? This deletes their account and cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true,
      run: () => doUserAction(user, 'remove', { successMsg: `${userLabel(user)} removed`, removeFromList: true })
    });
  }

  onMount(async () => {
    adminAccessChecked = false;
    // Prefer the hydrated profile store; fall back to session/profile fetch if needed.
    let user = get(currentUser);
    if (!user) {
      const { data: sessionData } = await supabase.auth.getSession();
      const authUser = sessionData?.session?.user || null;
      if (authUser?.id) {
        user = await fetchUserProfile(authUser.id);
      }
    }

    // Refresh once before denying in case store data is stale.
    if (user?.id && !hasPermission(user, 'VIEW_ADMIN_PANEL')) {
      const refreshed = await fetchUserProfile(user.id);
      if (refreshed) user = refreshed;
    }

    // Check admin access only after profile is hydrated.
    if (!user || !hasPermission(user, 'VIEW_ADMIN_PANEL')) {
      adminAccessChecked = true;
      toastActions.show('Access denied: Only leads can access the admin panel');
      goto('/');
      return;
    }

    adminAccessChecked = true;
    
    await loadUsers();
    await loadRosters();
    if (activeTab === 'purchasing') {
      await loadVendors();
      await loadPurchaseHistory();
    }
    if (activeTab === 'attendance') {
      await loadAttendanceTab(true);
    }
  });

  async function selectRoster(roster) {
    selectedRoster = roster;
    await Promise.all([loadRosterKeys(roster.id), loadRosterEntries(roster.id)]);
  }

  async function loadRosterKeys(rosterId) {
    try {
      const { data, error } = await supabase.from('roster_keys').select('*').eq('roster_id', rosterId).order('category').order('key_name');
      if (error) throw error;
      rosterKeys = data || [];
    } catch (err) {
      console.error('Failed to load roster keys', err);
    }
  }

  async function loadRosterEntries(rosterId) {
    try {
      const { data, error } = await supabase.from('roster_entries').select('*, user:user_id(id, full_name, email), key:key_id(key_name)').eq('roster_id', rosterId);
      if (error) throw error;
      rosterEntries = data || [];
    } catch (err) {
      console.error('Failed to load roster entries', err);
    }
  }

  async function createRoster() {
    if (!newRosterName) return;
    try {
      const { data, error } = await supabase.from('rosters').insert([{
        name: newRosterName,
        type: newRosterType,
        is_public: newRosterPublic,
        is_admin_editable: newRosterAdmin,
        target_frc_team: newRosterTargetFrcTeam,
        created_by: await resolveActorId()
      }]).select().single();
      
      if (error) throw error;
      rosters = [...rosters, data];
      showCreateRosterModal = false;
      newRosterName = '';
      newRosterTargetFrcTeam = 'all';
      toastActions.show('Roster created');
    } catch (err) {
      console.error('Failed to create roster', err);
      toastActions.show('Failed to create roster');
    }
  }

  async function addKeyToRoster() {
    if (!selectedRoster || !newKeyName) return;
    try {
      const { data, error } = await supabase.from('roster_keys').insert([{
        roster_id: selectedRoster.id,
        key_name: newKeyName,
        category: newKeyCategory
      }]).select().single();
      
      if (error) throw error;
      rosterKeys = [...rosterKeys, data];
      newKeyName = '';
      toastActions.show('Key added');
    } catch (err) {
      console.error('Failed to add key', err);
      toastActions.show('Failed to add key');
    }
  }

  async function deleteRosterKey(key) {
    if (!selectedRoster) return;
    try {
      const { error } = await supabase.from('roster_keys').delete().eq('id', key.id);
      if (error) throw error;
      rosterKeys = rosterKeys.filter((k) => k.id !== key.id);
      rosterEntries = rosterEntries.filter((entry) => entry.key_id !== key.id);
      toastActions.show('Key removed');
    } catch (err) {
      console.error('Failed to remove key', err);
      toastActions.show('Failed to remove key');
    }
  }

  async function assignUserToRoster(user, key) {
    if (!selectedRoster) return;
    try {
      // If single select, remove existing entry for this user in this roster
      if (selectedRoster.type === 'single') {
        const existing = rosterEntries.find(e => e.user_id === user.id);
        if (existing) {
          await supabase.from('roster_entries').delete().eq('id', existing.id);
        }
      }

      const { data, error } = await supabase.from('roster_entries').insert([{
        roster_id: selectedRoster.id,
        user_id: user.id,
        key_id: key.id
      }]).select('*, user:user_id(id, full_name, email), key:key_id(key_name)').single();

      if (error) throw error;
      
      // Update local state
      if (selectedRoster.type === 'single') {
        rosterEntries = rosterEntries.filter(e => e.user_id !== user.id);
      }
      rosterEntries = [...rosterEntries, data];
      toastActions.show('User assigned');
    } catch (err) {
      console.error('Failed to assign user', err);
      toastActions.show('Failed to assign user');
    }
  }

  async function removeUserFromRoster(entryId) {
    try {
      const { error } = await supabase.from('roster_entries').delete().eq('id', entryId);
      if (error) throw error;
      rosterEntries = rosterEntries.filter(e => e.id !== entryId);
      toastActions.show('User removed');
    } catch (err) {
      console.error('Failed to remove user', err);
      toastActions.show('Failed to remove user');
    }
  }

  async function updateUserRoles(user, roles) {
    if (!canEditRolesOf(user)) {
      toastActions.show(
        user?.id === $currentUser?.id
          ? "You cannot change your own roles here"
          : user?.is_dev
            ? "Only a dev can change another dev's roles"
            : "Only an admin can change another admin's roles"
      );
      // Force the role <select> elements to resync to the stored values —
      // the browser already visually applied the user's click before this
      // guard ran (in case a disabled select is somehow bypassed), so
      // without this the dropdown would look changed even though nothing
      // was saved.
      users = [...users];
      return;
    }
    setSaving(user.id, true);
    const optimisticUsers = users.map((u) => (u.id === user.id ? { ...u, ...roles } : u));
    users = optimisticUsers;

    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({
          action: 'update-roles',
          actor_id: await resolveActorId(),
          target_id: user.id,
          ...roles
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to update roles');

      let updatedUser = body?.data ? { ...user, ...body.data } : (optimisticUsers.find((u) => u.id === user.id) || user);
      if (!isUserApproved(updatedUser)) {
        try {
          await performUserAction(updatedUser.id, 'approve');
          const withPermission = new Set(updatedUser.permissions || []);
          withPermission.add('CAN_SEE_ROUTES');
          updatedUser = { ...updatedUser, permissions: Array.from(withPermission) };
        } catch (approveErr) {
          console.warn('Auto approval failed', approveErr);
        }
      }

      users = optimisticUsers.map((u) => (u.id === updatedUser.id ? { ...u, ...updatedUser } : u));

      if (get(currentUser)?.id === updatedUser.id) {
        await fetchUserProfile(updatedUser.id);
      }
      toastActions.show('Roles updated');
    } catch (err) {
      console.error('Failed to update roles', err);
      toastActions.show('Failed to update roles');
      await loadUsers();
    } finally {
      setSaving(user.id, false);
    }
  }

  async function updateUserNotifications(user, settings) {
    if (!canEditNotificationsOf(user)) {
      toastActions.show('You are not permitted to change these notification subscriptions');
      users = [...users];
      return;
    }

    setSaving(user.id, true);
    const previous = user;
    const optimisticUsers = users.map((u) => (u.id === user.id ? { ...u, ...settings } : u));
    users = optimisticUsers;

    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getAuthHeader()) },
        body: JSON.stringify({
          action: 'update-notifications',
          actor_id: await resolveActorId(),
          target_id: user.id,
          ...settings
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to update notification subscriptions');
      users = optimisticUsers.map((u) => (u.id === user.id ? { ...u, ...(body.data || {}) } : u));
      if (get(currentUser)?.id === user.id) await fetchUserProfile(user.id);
      toastActions.show('Notifications updated');
    } catch (err) {
      console.error('Failed to update notifications', err);
      toastActions.show(err.message || 'Failed to update notifications');
      users = users.map((u) => (u.id === user.id ? previous : u));
    } finally {
      setSaving(user.id, false);
    }
  }

  async function loadVendors() {
    loadingVendors = true;
    try {
      const { data, error: err } = await supabase
        .from('vendors')
        .select('*')
        .order('name');
      if (err) throw err;
      vendors = data || [];
    } catch (err) {
      console.error('Failed to load vendors', err);
      toastActions.show('Failed to load vendors');
    } finally {
      loadingVendors = false;
    }
  }

  async function loadPurchaseHistory() {
    loadingPurchases = true;
    loadingOrders = true;
    try {
      const { data, error: err } = await supabase
        .from('purchasing')
        .select('*')
        .order('created_at', { ascending: false });
      if (err) throw err;
      purchaseHistory = data || [];

      const { data: ordersData, error: ordersErr } = await supabase
        .from('orders')
        .select('*')
        .order('placed_at', { ascending: false });
      if (ordersErr) throw ordersErr;

      const userIds = Array.from(new Set((ordersData || [])
        .map(o => o.placed_by)
        .filter(Boolean)));

      let userLookup = new Map();
      if (userIds.length) {
        const { data: profiles, error: profilesErr } = await supabase
          .from('user_profiles')
          .select('id, email, full_name')
          .in('id', userIds);
        if (profilesErr) throw profilesErr;
        userLookup = new Map((profiles || []).map(profile => [profile.id, profile]));
      }

      orders = (ordersData || []).map((order) => {
        const profile = order.placed_by ? userLookup.get(order.placed_by) : null;
        return {
          ...order,
          placed_by_email: profile?.email || 'Unknown',
          placed_by_name: profile?.full_name || null
        };
      });
    } catch (err) {
      console.error('Failed to load purchase history', err);
      toastActions.show('Failed to load purchase history');
    } finally {
      loadingPurchases = false;
      loadingOrders = false;
    }
  }

  async function openAddVendorModal() {
    vendorName = '';
    vendorUrlBase = '';
    vendorFreeShipping = false;
    showAddVendorModal = true;
  }

  async function openEditVendorModal(vendor) {
    editingVendor = vendor;
    vendorName = vendor.name;
    vendorUrlBase = vendor.url_base;
    vendorFreeShipping = vendor.free_shipping;
    showEditVendorModal = true;
  }

  async function saveVendor() {
    if (!vendorName || !vendorUrlBase) {
      toastActions.show('Vendor name and URL base are required');
      return;
    }

    try {
      const payload = {
        name: vendorName.trim(),
        url_base: vendorUrlBase.trim(),
        free_shipping: vendorFreeShipping
      };

      if (editingVendor) {
        const { error: err } = await supabase
          .from('vendors')
          .update(payload)
          .eq('id', editingVendor.id);
        if (err) throw err;
        toastActions.show('Vendor updated');
      } else {
        const { error: err } = await supabase
          .from('vendors')
          .insert([payload]);
        if (err) throw err;
        toastActions.show('Vendor added');
      }

      showAddVendorModal = false;
      showEditVendorModal = false;
      editingVendor = null;
      await loadVendors();
    } catch (err) {
      console.error('Failed to save vendor', err);
      toastActions.show('Failed to save vendor: ' + (err.message || String(err)));
    }
  }

  async function deleteVendor(vendor) {
    if (!await requestConfirmation({ message: `Delete vendor "${vendor.name}"? This cannot be undone.`, confirmLabel: 'Delete vendor', danger: true })) return;

    try {
      const { error: err } = await supabase
        .from('vendors')
        .delete()
        .eq('id', vendor.id);
      if (err) throw err;
      toastActions.show('Vendor deleted');
      await loadVendors();
    } catch (err) {
      console.error('Failed to delete vendor', err);
      toastActions.show('Failed to delete vendor: ' + (err.message || String(err)));
    }
  }

  async function loadUsers() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/admin?action=list-users', {
        headers: { ...(await getAuthHeader()) }
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to load users');
      users = body.data.map((u) => ({ ...u, permissions: Array.isArray(u.permissions) ? u.permissions : u.permissions ? [String(u.permissions)] : [] }));
      // Notify for users lacking CAN_SEE_ROUTES (needing approval). Avoid spamming: only first load.
      if (!window.__notifiedUsersForApproval) {
        window.__notifiedUsersForApproval = new Set();
      }
      users.filter((u) => !isUserApproved(u)).forEach((u) => {
        if (!window.__notifiedUsersForApproval.has(u.id)) {
          window.__notifiedUsersForApproval.add(u.id);
          notifyUserNeedsApproval(u);
        }
      });
    } catch (err) {
      error = err.message || String(err);
    } finally {
      loading = false;
    }
  }

  $: filteredRosters = rosters.filter((r) => r.name.toLowerCase().includes(rosterSearchQuery.toLowerCase()));
  $: filteredRosterMembers = users.filter((u) => {
    // First filter by search query
    const matchesSearch = (u.full_name || '').toLowerCase().includes(rosterMemberSearchQuery.toLowerCase());
    if (!matchesSearch) return false;
    
    // Then filter by roster's target_frc_team
    if (!selectedRoster || !selectedRoster.target_frc_team || selectedRoster.target_frc_team === 'all') {
      return true;
    }
    
    const userFrcTeam = u.frc_team || null;
    if (selectedRoster.target_frc_team === 'students') {
      // Students = 971 or 9584 (not mentors, not null)
      return userFrcTeam === '971' || userFrcTeam === '9584';
    }
    
    // Specific team filter (971 or 9584)
    return userFrcTeam === selectedRoster.target_frc_team;
  });
  $: pendingApprovals = users.filter((u) => !isUserApproved(u));
  $: hasActiveUserFilters = Boolean(
    userSearchQuery.trim() ||
    generalRoleFilter !== 'all' ||
    purchasingRoleFilter !== 'all' ||
    teamRoleFilter !== 'all' ||
    frcTeamFilter !== 'all' ||
    approvalFilter !== 'all'
  );

  $: accessFilteredUsers = users
    .filter((user) => {
      const searchTerm = userSearchQuery.trim().toLowerCase();
      const matchesSearch = !searchTerm ||
        (user.full_name || '').toLowerCase().includes(searchTerm) ||
        (user.email || '').toLowerCase().includes(searchTerm);
      if (!matchesSearch) return false;

      const userGeneralRole = user.general_role || defaultGeneralRole;
      const userPurchasingRole = user.purchasing_role || defaultPurchasingRole;
      const userTeamRole = user.team_role || defaultTeamRole;
      const userFrcTeam = user.frc_team || null;
      const approved = isUserApproved(user);

      if (generalRoleFilter !== 'all' && userGeneralRole !== generalRoleFilter) return false;
      if (purchasingRoleFilter !== 'all' && userPurchasingRole !== purchasingRoleFilter) return false;
      if (teamRoleFilter !== 'all' && userTeamRole !== teamRoleFilter) return false;
      if (frcTeamFilter !== 'all' && userFrcTeam !== frcTeamFilter) return false;
      if (approvalFilter === 'pending' && approved) return false;
      if (approvalFilter === 'approved' && !approved) return false;
      return true;
    })
    .sort((a, b) => {
      const approvedDiff = Number(isUserApproved(a)) - Number(isUserApproved(b));
      if (approvedDiff !== 0) return approvedDiff;
      const nameA = (a.full_name || a.email || '').toLowerCase();
      const nameB = (b.full_name || b.email || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

  function togglePermission(user, perm) {
    if (!user.permissions) user.permissions = [];
    if (user.permissions.includes(perm)) {
      user.permissions = user.permissions.filter((p) => p !== perm);
    } else {
      user.permissions = [...user.permissions, perm];
    }

    // If admin panel access is removed, strip elevated admin perms
    if (!user.permissions.includes('VIEW_ADMIN_PANEL')) {
      user.permissions = user.permissions.filter((p) => p !== 'BAN_USERS' && p !== 'APPROVE_USERS');
    }

    // force update
    users = users.slice();
  }
  async function saveUser(u) {
    // Persist user changes (permissions/role) to the server.
    error = null;
    const actor_id = await resolveActorId();
    if (!actor_id) {
      error = 'Unable to determine current user id; refresh and try again.';
      return;
    }

    try {
      const auth = await getAuthHeader();
      // Call server endpoint to save user details. Backend should accept this payload.
      const res = await fetch('/api/admin?action=save-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ actor_id, target_id: u.id, user: { role: u.role, permissions: u.permissions, full_name: u.full_name } })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || JSON.stringify(body));
      import('$lib/toast.js').then((m) => m.toastActions.show('User saved'));
      await loadUsers();
    } catch (err) {
      error = err.message || String(err);
      import('$lib/toast.js').then((m) => m.toastActions.show(error));
    }
  }

  // Actions for approve/ban/promote triggered by buttons in the table
  // Roster Management functions
  async function loadRosters() {
    loadingRosters = true;
    try {
      const { data, error } = await supabase.from('rosters').select('*').order('name');
      if (error) throw error;
      rosters = data || [];
    } catch (err) {
      console.error('Failed to load rosters', err);
      toastActions.show('Failed to load rosters');
    } finally {
      loadingRosters = false;
    }
  }

  async function loadAttendanceLocations() {
    attendanceLocationsLoading = true;
    try {
      attendanceLocations = await fetchAttendanceLocations();
    } catch (err) {
      console.error('Failed to load attendance locations', err);
      toastActions.show('Unable to load locations');
    } finally {
      attendanceLocationsLoading = false;
    }
  }

  async function loadAttendanceSchedules() {
    attendanceSchedulesLoading = true;
    try {
      attendanceSchedules = await fetchAttendanceSchedules();
    } catch (err) {
      console.error('Failed to load attendance schedules', err);
      toastActions.show('Unable to load schedules');
    } finally {
      attendanceSchedulesLoading = false;
    }
  }

  async function loadAttendanceLeaderboard() {
    attendanceLeaderboardLoading = true;
    try {
      attendanceLeaderboard = await fetchAttendanceLeaderboard({ search: attendanceSearch.trim() });
    } catch (err) {
      console.error('Failed to load attendance leaderboard', err);
      toastActions.show('Unable to load leaderboard');
    } finally {
      attendanceLeaderboardLoading = false;
    }
  }

  async function loadAttendanceTab(force = false) {
    if (!hasPermission(get(currentUser), 'MANAGE_ATTENDANCE')) return;
    if (!force && attendanceLocations.length && attendanceSchedules.length && attendanceLeaderboard.length) return;
    await Promise.all([
      loadAttendanceLocations(),
      loadAttendanceSchedules(),
      loadAttendanceLeaderboard()
    ]);
  }

  function resetLocationForm() {
    editingLocation = null;
    locationForm = { ...defaultLocationForm };
    showLocationForm = false;
  }

  function openLocationForm(location = null) {
    if (location) {
      editingLocation = location;
      locationForm = {
        name: location.name || '',
        network_cidr: location.network_cidr || '',
        description: location.description || '',
        active: location.active ?? true
      };
    } else {
      editingLocation = null;
      locationForm = { ...defaultLocationForm };
    }
    showLocationForm = true;
  }

  async function captureNetwork() {
    capturingNetwork = true;
    try {
      // getCurrentNetworkFingerprint now returns the normalized network prefix
      // (first 3 octets for IPv4, e.g., "205.167.46")
      // This is the format used for matching in the attendance system
      const networkPrefix = await getCurrentNetworkFingerprint();
      if (networkPrefix) {
        // Store the normalized prefix directly - no CIDR suffix needed
        // The attendance system does simple string matching on these prefixes
        locationForm = { ...locationForm, network_cidr: networkPrefix };
        toastActions.show('Captured current network');
      } else {
        toastActions.show('Unable to capture network');
      }
    } catch (err) {
      console.error('Failed to capture network', err);
      toastActions.show('Unable to capture network');
    } finally {
      capturingNetwork = false;
    }
  }

  async function saveLocation() {
    if (!locationForm.name?.trim()) {
      toastActions.show('Location name required');
      return;
    }
    if (!locationForm.network_cidr?.trim()) {
      toastActions.show('Network CIDR required');
      return;
    }
    savingLocation = true;
    try {
      if (editingLocation) {
        await updateAttendanceLocation(editingLocation.id, locationForm);
        toastActions.show('Location updated');
      } else {
        await createAttendanceLocation({ ...locationForm, created_by: get(currentUser)?.id });
        toastActions.show('Location created');
      }
      await loadAttendanceLocations();
      resetLocationForm();
    } catch (err) {
      console.error('Failed to save location', err);
      toastActions.show(err?.message || 'Unable to save location');
    } finally {
      savingLocation = false;
    }
  }

  async function toggleLocationActive(loc) {
    try {
      await updateAttendanceLocation(loc.id, {
        name: loc.name,
        network_cidr: loc.network_cidr,
        description: loc.description,
        active: !loc.active
      });
      attendanceLocations = attendanceLocations.map((entry) => entry.id === loc.id ? { ...entry, active: !entry.active } : entry);
    } catch (err) {
      console.error('Failed to toggle location', err);
      toastActions.show('Unable to update location');
    }
  }

  async function removeLocation(loc) {
    if (!loc?.id) return;
    if (!await requestConfirmation({ message: `Remove ${loc.name}? Existing schedules will need to be updated.`, confirmLabel: 'Remove location', danger: true })) return;
    try {
      const success = await deleteAttendanceLocation(loc.id);
      if (success) {
        attendanceLocations = attendanceLocations.filter((entry) => entry.id !== loc.id);
        toastActions.show('Location removed');
        await loadAttendanceSchedules();
      } else {
        toastActions.show('Unable to remove location');
      }
    } catch (err) {
      console.error('Failed to delete location', err);
      toastActions.show(err?.message || 'Unable to remove location');
    }
  }

  function resetScheduleForm() {
    editingSchedule = null;
    scheduleForm = { ...defaultScheduleForm };
    showScheduleForm = false;
  }

  function openScheduleForm(schedule = null) {
    if (schedule) {
      editingSchedule = schedule;
      scheduleForm = {
        label: schedule.label || '',
        day_of_week: schedule.day_of_week ?? 0,
        start_time: schedule.start_time?.slice(0, 5) || '19:00',
        end_time: schedule.end_time?.slice(0, 5) || '21:00',
        location_ids: schedule.location_ids || [],
        active: schedule.active ?? true
      };
    } else {
      editingSchedule = null;
      scheduleForm = { ...defaultScheduleForm };
    }
    showScheduleForm = true;
  }

  function toggleScheduleLocation(id) {
    const next = new Set(scheduleForm.location_ids || []);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    scheduleForm = { ...scheduleForm, location_ids: Array.from(next) };
  }

  async function saveSchedule() {
    if (!scheduleForm.label?.trim()) {
      toastActions.show('Schedule label required');
      return;
    }
    if (!scheduleForm.start_time || !scheduleForm.end_time) {
      toastActions.show('Start and end times required');
      return;
    }
    if (scheduleForm.start_time >= scheduleForm.end_time) {
      toastActions.show('End time must be after start time');
      return;
    }
    if (!scheduleForm.location_ids?.length) {
      toastActions.show('Select at least one location');
      return;
    }
    savingSchedule = true;
    try {
      const payload = {
        ...scheduleForm,
        day_of_week: Number(scheduleForm.day_of_week),
        location_ids: [...(scheduleForm.location_ids || [])]
      };
      if (editingSchedule) {
        await updateAttendanceSchedule(editingSchedule.id, payload);
        toastActions.show('Schedule updated');
      } else {
        await createAttendanceSchedule({ ...payload, created_by: get(currentUser)?.id });
        toastActions.show('Schedule created');
      }
      await loadAttendanceSchedules();
      resetScheduleForm();
    } catch (err) {
      console.error('Failed to save schedule', err);
      toastActions.show(err?.message || 'Unable to save schedule');
    } finally {
      savingSchedule = false;
    }
  }

  async function removeSchedule(schedule) {
    if (!schedule?.id) return;
    if (!await requestConfirmation({ message: `Delete "${schedule.label}"?`, confirmLabel: 'Delete schedule', danger: true })) return;
    try {
      const success = await deleteAttendanceSchedule(schedule.id);
      if (success) {
        attendanceSchedules = attendanceSchedules.filter((entry) => entry.id !== schedule.id);
        toastActions.show('Schedule removed');
      }
    } catch (err) {
      console.error('Failed to delete schedule', err);
      toastActions.show(err?.message || 'Unable to remove schedule');
    }
  }

  function formatAttendanceTimestamp(ts) {
    if (!ts) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(ts));
    } catch {
      return ts;
    }
  }

  function handleAttendanceSearch(event) {
    attendanceSearch = event.currentTarget?.value || '';
    if (attendanceSearchTimeout) clearTimeout(attendanceSearchTimeout);
    attendanceSearchTimeout = setTimeout(() => {
      loadAttendanceLeaderboard();
    }, 300);
  }

  async function setActiveTab(tab) {
    activeTab = tab;
    if (tab === 'purchasing') {
      if (vendors.length === 0) await loadVendors();
      if (purchaseHistory.length === 0) await loadPurchaseHistory();
    }
    if (tab === 'rosters' && rosters.length === 0) {
      await loadRosters();
    }
    if (tab === 'attendance') {
      await loadAttendanceTab();
    }
  }

  // Note: User approval is checked via hasPermission() which considers
  // both explicit permissions array AND role-derived permissions.
  // Users with general_role 'none' are not approved until an admin
  // assigns them a role or explicitly grants CAN_SEE_ROUTES.
</script>

<svelte:head>
  <title>Admin Control Center</title>
</svelte:head>

{#if !adminAccessChecked}
  <div class="container">
    <div class="access-denied">
      <p>Checking admin access…</p>
    </div>
  </div>
{:else if !canAccessAdmin}
  <div class="container">
    <div class="access-denied">
      <h2>Access Denied</h2>
      <p>Only leads can access the admin panel.</p>
    </div>
  </div>
{:else}
<div class="container admin-page">
  <div class="page-header">
    <div>
      <h1>Admin Control Center</h1>
      <p class="text-muted">Manage permissions, curated rosters, and purchasing workflows from one cohesive surface.</p>
    </div>
    <div class="page-actions">
      {#if activeTab === 'access'}
        <button class="btn btn-secondary" on:click={loadUsers} disabled={loading}>Refresh Users</button>
      {:else if activeTab === 'rosters'}
        <button class="btn btn-secondary" on:click={loadRosters} disabled={loadingRosters}>Refresh Rosters</button>
      {:else if activeTab === 'purchasing'}
        <button class="btn btn-secondary" on:click={loadPurchaseHistory} disabled={loadingPurchases || loadingOrders}>Refresh Analytics</button>
      {:else if activeTab === 'attendance'}
        <button class="btn btn-secondary" on:click={() => loadAttendanceTab(true)} disabled={attendanceLocationsLoading || attendanceSchedulesLoading || attendanceLeaderboardLoading}>
          Refresh Attendance
        </button>
      {/if}
    </div>
  </div>

  <nav class="tab-nav" role="tablist" aria-label="Admin sections">
    <button type="button" class:active={activeTab === 'access'} on:click={() => setActiveTab('access')}>
      Roles & Access
    </button>
    {#if $currentUser?.role === 'admin'}
      <button type="button" class:active={activeTab === 'activity'} on:click={() => setActiveTab('activity')}>
        Activity Log
      </button>
    {/if}
    <button type="button" class:active={activeTab === 'rosters'} on:click={() => setActiveTab('rosters')}>
      Roster Studio
    </button>
    <button type="button" class:active={activeTab === 'purchasing'} on:click={() => setActiveTab('purchasing')}>
      Purchasing
    </button>
    {#if SHOW_GANTT_TAB}
      <button type="button" class:active={activeTab === 'planner-calendar'} on:click={() => setActiveTab('planner-calendar')}>
        Gantt Calendar
      </button>
    {/if}
    {#if SHOW_ATTENDANCE_TAB && hasPermission($currentUser, 'MANAGE_ATTENDANCE')}
      <button type="button" class:active={activeTab === 'attendance'} on:click={() => setActiveTab('attendance')}>
        Attendance
      </button>
    {/if}
    {#if isAdminUser || ($currentUser?.purchasing_role === PURCHASING_ROLES.BUDGETING) || ($currentUser?.permissions?.includes('MANAGE_BUDGETS'))}
      <button type="button" class:active={activeTab === 'budgets'} on:click={() => setActiveTab('budgets')}>
        Budgets
      </button>
    {/if}
    {#if isDevUser}
      <button type="button" class:active={activeTab === 'dev'} on:click={() => setActiveTab('dev')}>
        Dev
      </button>
    {/if}
  </nav>

  {#if activeTab === 'access'}
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Role Assignment</h3>
          <p>Pending approvals: {pendingApprovals.length}</p>
        </div>
        <div class="section-actions">
          <button class="btn btn-secondary" on:click={loadUsers} disabled={loading}>Reload</button>
        </div>
      </div>

      {#if loading}
        <div class="empty-state">Loading users…</div>
      {:else if error}
        <div class="empty-state">{error}</div>
      {:else if accessFilteredUsers.length === 0}
        <div class="empty-state">No users match your filters.</div>
      {:else}
        <div class="role-filters">
          <input
            class="form-input filter-input"
            type="text"
            placeholder="Search by name or email..."
            bind:value={userSearchQuery}
          />
          <select class="form-select filter-input" bind:value={generalRoleFilter} aria-label="Filter by general role">
            <option value="all">All General Roles</option>
            {#each generalRoleOptions as roleValue}
              <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
            {/each}
          </select>
          <select class="form-select filter-input" bind:value={purchasingRoleFilter} aria-label="Filter by purchasing role">
            <option value="all">All Purchasing Roles</option>
            {#each purchasingRoleOptions as roleValue}
              <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
            {/each}
          </select>
          <select class="form-select filter-input" bind:value={teamRoleFilter} aria-label="Filter by team role">
            <option value="all">All Team Roles</option>
            {#each teamRoleOptions as roleValue}
              <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
            {/each}
          </select>
          <select class="form-select filter-input" bind:value={frcTeamFilter} aria-label="Filter by FRC team">
            <option value="all">All FRC Teams</option>
            {#each frcTeamOptions as teamValue}
              <option value={teamValue}>{formatFrcTeamLabel(teamValue)}</option>
            {/each}
          </select>
          <select class="form-select filter-input" bind:value={approvalFilter} aria-label="Filter by approval status">
            {#each approvalFilterOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          {#if hasActiveUserFilters}
            <button type="button" class="btn btn-secondary btn-sm" on:click={resetUserFilters}>Clear Filters</button>
          {/if}
        </div>

        <!-- Mobile User Cards -->
        <div class="mobile-user-cards">
          {#each accessFilteredUsers as user (user.id)}
            <div class="user-card" class:pending-card={!isUserApproved(user)}>
              <div class="user-card-header">
                <div class="user-card-name">
                  <strong>{user.full_name || 'No Name'}</strong>
                  {#if user.is_dev}
                    <span class="chip chip-pill status-chip status-chip--dev">Dev</span>
                  {:else if user.role === 'admin'}
                    <span class="chip chip-pill status-chip status-chip--admin">Admin</span>
                  {/if}
                  {#if !isUserApproved(user)}
                    <span class="chip chip-pill chip-soft status-chip status-chip--pending">Pending</span>
                  {/if}
                </div>
                <span class="user-card-email">{user.email || '—'}</span>
                {#if savingRoleIds.has(user.id)}
                  <span class="saving-indicator">Saving…</span>
                {/if}
              </div>

              <div class="user-card-roles">
                <div class="user-card-role">
                  <span class="role-label">FRC Team</span>
                  <select
                    class="form-select role-select"
                    style={roleThemeStyle(frcTeamThemes[user.frc_team || null])}
                    value={user.frc_team || ''}
                    disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                    title={roleEditDisabledReason(user)}
                    aria-label={`FRC Team for ${user.full_name || user.email}`}
                    on:change={(e) => updateUserRoles(user, { frc_team: e.target.value || null })}
                  >
                    <option value="">Not Set</option>
                    {#each frcTeamOptions as teamValue}
                      <option value={teamValue}>{formatFrcTeamLabel(teamValue)}</option>
                    {/each}
                  </select>
                </div>

                <div class="user-card-role">
                  <span class="role-label">General</span>
                  <select
                    class="form-select role-select"
                    style={roleThemeStyle(generalRoleThemes[user.general_role || defaultGeneralRole])}
                    value={user.general_role || defaultGeneralRole}
                    disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                    title={roleEditDisabledReason(user)}
                    aria-label={`General role for ${user.full_name || user.email}`}
                    on:change={(e) => updateUserRoles(user, { general_role: e.target.value })}
                  >
                    {#each generalRoleOptions as roleValue}
                      <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                    {/each}
                  </select>
                </div>

                <div class="user-card-role">
                  <span class="role-label">Purchasing</span>
                  <select
                    class="form-select role-select"
                    style={roleThemeStyle(purchasingRoleThemes[user.purchasing_role || defaultPurchasingRole])}
                    value={user.purchasing_role || defaultPurchasingRole}
                    disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                    title={roleEditDisabledReason(user)}
                    aria-label={`Purchasing role for ${user.full_name || user.email}`}
                    on:change={(e) => updateUserRoles(user, { purchasing_role: e.target.value })}
                  >
                    {#each purchasingRoleOptions as roleValue}
                      <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                    {/each}
                  </select>
                </div>

                <div class="user-card-role">
                  <span class="role-label">Team Role</span>
                  <select
                    class="form-select role-select"
                    style={roleThemeStyle(teamRoleThemes[user.team_role || defaultTeamRole])}
                    value={user.team_role || defaultTeamRole}
                    disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                    title={roleEditDisabledReason(user)}
                    aria-label={`Team role for ${user.full_name || user.email}`}
                    on:change={(e) => updateUserRoles(user, { team_role: e.target.value })}
                  >
                    {#each teamRoleOptions as roleValue}
                      <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                    {/each}
                  </select>
                </div>

                <div class="user-card-role">
                  <span class="role-label">Notifications</span>
                  <div class="notify-checkboxes">
                    {#each manufacturingNotifyOptions as opt}
                      <label class="notify-checkbox-label">
                        <input
                          type="checkbox"
                          checked={(user.manufacturing_lead_workflows || []).includes(opt.value)}
                          disabled={savingRoleIds.has(user.id) || !canEditNotificationsOf(user)}
                          on:change={(e) => toggleManufacturingNotify(user, opt.value, e.target.checked)}
                        />
                        {opt.label}
                      </label>
                    {/each}
                    <label class="notify-checkbox-label">
                      <input
                        type="checkbox"
                        checked={!!user.vision_notify}
                        disabled={savingRoleIds.has(user.id) || !canEditNotificationsOf(user)}
                        on:change={(e) => toggleVisionNotify(user, e.target.checked)}
                      />
                      Vision Alerts
                    </label>
                  </div>
                </div>

                {#if user.is_dev}
                  <div class="user-card-role">
                    <span class="role-label">Permissions</span>
                    <span class="chip chip-pill status-chip status-chip--admin-full">Dev Perms</span>
                  </div>
                {:else if user.role === 'admin'}
                  <div class="user-card-role">
                    <span class="role-label">Permissions</span>
                    <span class="chip chip-pill status-chip status-chip--admin-full">All Permissions</span>
                  </div>
                {:else}
                  <div class="user-card-role">
                    <span class="role-label">Vision Access</span>
                    <div class="notify-checkboxes">
                      {#each visionPermissionOptions as opt}
                        <label class="notify-checkbox-label">
                          <input
                            type="checkbox"
                            checked={(user.permissions || []).includes(opt.value)}
                            disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                            on:change={(e) => toggleVisionPermission(user, opt.value, e.target.checked)}
                          />
                          {opt.label}
                        </label>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
              {#if showUserActions}
                <div class="user-card-actions">
                  {#if canApproveUsers && !isUserApproved(user)}
                    <button class="btn btn-sm btn-primary" disabled={savingRoleIds.has(user.id)} on:click={() => approveUser(user)}>Approve</button>
                  {/if}
                  {#if canPromoteUsers && user.role !== 'admin'}
                    <button class="btn btn-sm btn-secondary" disabled={savingRoleIds.has(user.id)} on:click={() => promoteUser(user)}>Make Admin</button>
                  {/if}
                  {#if canRemoveUsers && user.id !== $currentUser?.id && (!user.is_dev || isDevUser)}
                    <button class="btn btn-sm btn-danger" disabled={savingRoleIds.has(user.id)} on:click={() => removeUser(user)}>Remove</button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Desktop Table -->
        <div class="table-container desktop-admin-table">
          <table class="table admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>FRC Team</th>
                <th>General Role</th>
                <th>Purchasing Role</th>
                <th>Team Role</th>
                <th>Notifications</th>
                <th>Permissions</th>
                {#if showUserActions}<th>Actions</th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each accessFilteredUsers as user (user.id)}
                <tr class:pending-row={!isUserApproved(user)}>
                  <td>
                    <div class="name-cell">
                      <strong>{user.full_name || 'No Name'}</strong>
                      {#if user.is_dev}
                        <span class="chip chip-pill status-chip status-chip--dev">Dev</span>
                      {:else if user.role === 'admin'}
                        <span class="chip chip-pill status-chip status-chip--admin">Admin</span>
                      {/if}
                      {#if !isUserApproved(user)}
                        <span class="chip chip-pill chip-soft status-chip status-chip--pending">Pending approval</span>
                      {/if}
                    </div>
                  </td>
                  <td>
                    <div class="email-cell">
                      <span>{user.email || '—'}</span>
                      {#if savingRoleIds.has(user.id)}
                        <span class="saving-indicator">Saving…</span>
                      {/if}
                    </div>
                  </td>
                  <td>
                    <select
                      class="form-select role-select"
                      style={roleThemeStyle(frcTeamThemes[user.frc_team || null])}
                      value={user.frc_team || ''}
                      disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                      title={roleEditDisabledReason(user)}
                      aria-label={`FRC Team for ${user.full_name || user.email}`}
                      on:change={(e) => updateUserRoles(user, { frc_team: e.target.value || null })}
                    >
                      <option value="">Not Set</option>
                      {#each frcTeamOptions as teamValue}
                        <option value={teamValue}>{formatFrcTeamLabel(teamValue)}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <select
                      class="form-select role-select"
                      style={roleThemeStyle(generalRoleThemes[user.general_role || defaultGeneralRole])}
                      value={user.general_role || defaultGeneralRole}
                      disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                      title={roleEditDisabledReason(user)}
                      aria-label={`General role for ${user.full_name || user.email}`}
                      on:change={(e) => updateUserRoles(user, { general_role: e.target.value })}
                    >
                      {#each generalRoleOptions as roleValue}
                        <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <select
                      class="form-select role-select"
                      style={roleThemeStyle(purchasingRoleThemes[user.purchasing_role || defaultPurchasingRole])}
                      value={user.purchasing_role || defaultPurchasingRole}
                      disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                      title={roleEditDisabledReason(user)}
                      aria-label={`Purchasing role for ${user.full_name || user.email}`}
                      on:change={(e) => updateUserRoles(user, { purchasing_role: e.target.value })}
                    >
                      {#each purchasingRoleOptions as roleValue}
                        <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <select
                      class="form-select role-select"
                      style={roleThemeStyle(teamRoleThemes[user.team_role || defaultTeamRole])}
                      value={user.team_role || defaultTeamRole}
                      disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                      title={roleEditDisabledReason(user)}
                      aria-label={`Team role for ${user.full_name || user.email}`}
                      on:change={(e) => updateUserRoles(user, { team_role: e.target.value })}
                    >
                      {#each teamRoleOptions as roleValue}
                        <option value={roleValue}>{formatRoleLabel(roleValue)}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <div class="notify-checkboxes">
                      {#each manufacturingNotifyOptions as opt}
                        <label class="notify-checkbox-label">
                          <input
                            type="checkbox"
                            checked={(user.manufacturing_lead_workflows || []).includes(opt.value)}
                            disabled={savingRoleIds.has(user.id) || !canEditNotificationsOf(user)}
                            on:change={(e) => toggleManufacturingNotify(user, opt.value, e.target.checked)}
                          />
                          {opt.label}
                        </label>
                      {/each}
                      <label class="notify-checkbox-label">
                        <input
                          type="checkbox"
                          checked={!!user.vision_notify}
                          disabled={savingRoleIds.has(user.id) || !canEditNotificationsOf(user)}
                          on:change={(e) => toggleVisionNotify(user, e.target.checked)}
                        />
                        Vision Alerts
                      </label>
                    </div>
                  </td>
                  <td class="all-permissions-cell">
                    {#if user.is_dev}
                      <span class="chip chip-pill status-chip status-chip--admin-full">Dev Perms</span>
                    {:else if user.role === 'admin'}
                      <span class="chip chip-pill status-chip status-chip--admin-full">All Permissions</span>
                    {:else}
                      <div class="notify-checkboxes">
                        {#each visionPermissionOptions as opt}
                          <label class="notify-checkbox-label">
                            <input
                              type="checkbox"
                              checked={(user.permissions || []).includes(opt.value)}
                              disabled={savingRoleIds.has(user.id) || !canEditRolesOf(user)}
                              on:change={(e) => toggleVisionPermission(user, opt.value, e.target.checked)}
                            />
                            {opt.label}
                          </label>
                        {/each}
                      </div>
                    {/if}
                  </td>
                  {#if showUserActions}
                    <td>
                      <div class="user-action-buttons">
                        {#if canApproveUsers && !isUserApproved(user)}
                          <button class="btn btn-sm btn-primary" disabled={savingRoleIds.has(user.id)} on:click={() => approveUser(user)}>Approve</button>
                        {/if}
                        {#if canPromoteUsers && user.role !== 'admin'}
                          <button class="btn btn-sm btn-secondary" disabled={savingRoleIds.has(user.id)} on:click={() => promoteUser(user)}>Make Admin</button>
                        {/if}
                        {#if canRemoveUsers && user.id !== $currentUser?.id}
                          <button class="btn btn-sm btn-danger" disabled={savingRoleIds.has(user.id)} on:click={() => removeUser(user)}>Remove</button>
                        {/if}
                      </div>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Manufacturing Portal</h3>
          <p>The manufacturing portal lives in its own tab so approvals stay cleanly separated.</p>
        </div>
        <div class="section-actions">
          <a class="btn btn-secondary" href="/manufacture/portal" target="_blank" rel="noreferrer">
            Open Portal
          </a>
        </div>
      </div>
      <div class="grid-3">
        <div class="stat-card">
          <Package size={20} />
          <div>
            <div class="text-muted">Key Roles</div>
            <strong>Subsystem & Manufacturing Leads</strong>
          </div>
        </div>
        <div class="stat-card">
          <TrendingUp size={20} />
          <div>
            <div class="text-muted">Leaderboard</div>
            <strong>Highlights recent completions</strong>
          </div>
        </div>
        <div class="stat-card">
          <User size={20} />
          <div>
            <div class="text-muted">Roster Source</div>
            <strong>Manufacturing Roles roster</strong>
          </div>
        </div>
      </div>
      <p class="text-muted">Use the Roster Studio tab to curate Manufacturing Roles, then assign parts directly inside the portal.</p>
    </section>
  {:else if activeTab === 'rosters'}
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Roster Studio</h3>
          <p>Drag roster keys onto members to organize scouting, manufacturing, or leadership duties.</p>
        </div>
        <div class="section-actions">
          <button class="btn btn-primary" on:click={() => showCreateRosterModal = true}>
            <Plus size={16} /> New Roster
          </button>
        </div>
      </div>

      <div class="roster-selector-block">
        <div class="selector-heading">
          <div>
            <strong>Rosters</strong>
            <p class="text-muted">Pick a roster to edit.</p>
          </div>
        </div>
        <input class="form-input" type="text" placeholder="Search rosters..." bind:value={rosterSearchQuery} />
        {#if loadingRosters}
          <div class="empty-state">Loading rosters…</div>
        {:else if filteredRosters.length === 0}
          <div class="empty-state">No rosters match.</div>
        {:else}
          <div class="roster-pill-row">
            {#each filteredRosters as roster}
              <button
                type="button"
                class="roster-pill {selectedRoster?.id === roster.id ? 'active' : ''}"
                on:click={() => selectRoster(roster)}
              >
                <span>{roster.name}</span>
                <small>{roster.type === 'single' ? 'Single' : 'Multi'}</small>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if selectedRoster}
        <div class="roster-main">
          <div class="panel roster-meta">
            <div class="panel-header">
              <div>
                <strong>{selectedRoster.name}</strong>
                <div class="badge-row">
                  <span class="badge-soft">{selectedRoster.is_public ? 'Public' : 'Private'}</span>
                  <span class="badge-soft">{selectedRoster.is_admin_editable ? 'Admin only' : 'Open edit'}</span>
                  <span class="badge-soft">{selectedRoster.type === 'single' ? 'Single select' : 'Multi select'}</span>
                  <span class="badge-soft">
                    {#if selectedRoster.target_frc_team === 'all'}
                      All members
                    {:else if selectedRoster.target_frc_team === 'students'}
                      Students only
                    {:else if selectedRoster.target_frc_team === '971'}
                      Team 971 only
                    {:else if selectedRoster.target_frc_team === '9584'}
                      Team 9584 only
                    {:else}
                      All members
                    {/if}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="roster-workspace">
            <div class="keys-column">
              <div class="list-card sticky-card">
                <div class="section-header">
                  <div>
                    <h4>Keys</h4>
                    <p>Drag a key onto a member.</p>
                  </div>
                </div>
                <div class="add-key-form">
                  <input class="form-input" type="text" placeholder="Key name" bind:value={newKeyName} />
                  <input class="form-input" type="text" placeholder="Category" bind:value={newKeyCategory} />
                  <button class="btn btn-secondary" on:click={addKeyToRoster}>Add</button>
                </div>
                <div class="list-card__items">
                  {#if rosterKeys.length === 0}
                    <div class="empty-state">No keys defined yet.</div>
                  {:else}
                    {#each rosterKeys as key}
                      <div
                        class="list-row key-row"
                        draggable="true"
                        on:dragstart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify(key))}
                      >
                        <div>
                          <strong>{key.key_name}</strong>
                          <div class="text-muted">{key.category || 'Uncategorized'}</div>
                        </div>
                        <button class="btn btn-sm btn-danger" on:click={() => deleteRosterKey(key)}>Remove</button>
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
            </div>

            <div class="members-column">
              <div class="list-card">
                <div class="section-header">
                  <div>
                    <h4>Members</h4>
                    <p>Drop a key to assign responsibilities.</p>
                  </div>
                </div>
                <input class="form-input" type="text" placeholder="Search members..." bind:value={rosterMemberSearchQuery} />
                <div class="list-card__items member-list">
                  {#if filteredRosterMembers.length === 0}
                    <div class="empty-state">No members found.</div>
                  {:else}
                    {#each filteredRosterMembers as user}
                      <div
                        class="list-row member-row member-row--compact"
                        on:dragover={(e) => e.preventDefault()}
                        on:drop={async (e) => {
                          e.preventDefault();
                          const key = JSON.parse(e.dataTransfer.getData('text/plain'));
                          await assignUserToRoster(user, key);
                        }}
                      >
                        <div>
                          <strong>{user.full_name}</strong>
                          <div class="member-keys">
                            {#each rosterEntries.filter((entry) => entry.user_id === user.id) as entry}
                              <span class="chip chip-compact">
                                {entry.key.key_name}
                                <button class="chip-remove" on:click={() => removeUserFromRoster(entry.id)} aria-label={`Remove ${entry.key.key_name}`}>
                                  ×
                                </button>
                              </span>
                            {/each}
                          </div>
                        </div>
                        {#if selectedRoster.type === 'single'}
                          <select
                            class="form-select"
                            on:change={(e) => {
                              const key = rosterKeys.find((k) => k.id === e.target.value);
                              if (key) assignUserToRoster(user, key);
                            }}
                          >
                            <option value="">Select key</option>
                            {#each rosterKeys as key}
                              <option value={key.id} selected={!!rosterEntries.find((entry) => entry.user_id === user.id && entry.key_id === key.id)}>
                                {key.key_name}
                              </option>
                            {/each}
                          </select>
                        {/if}
                      </div>
                    {/each}
                  {/if}
                </div>
              </div>
            </div>
          </div>
        </div>
      {:else}
        <div class="panel roster-empty">
          <div class="panel-body">
            <div class="empty-state">Select a roster to begin editing.</div>
          </div>
        </div>
      {/if}
    </section>
  {:else if activeTab === 'planner-calendar'}
    <PlannerCalendarTab currentUser={$currentUser} />
  {:else if activeTab === 'attendance' && hasPermission($currentUser, 'MANAGE_ATTENDANCE')}
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Attendance Leaderboard</h3>
          <p class="text-muted">Rolling 30-day window based on verified on-site check-ins.</p>
        </div>
        <div class="section-actions attendance-search">
          <label class="sr-only" for="attendance-search">Search attendance</label>
          <input
            id="attendance-search"
            class="form-input"
            type="search"
            placeholder="Search by name or email"
            value={attendanceSearch}
            on:input={handleAttendanceSearch}
          />
        </div>
      </div>
      {#if attendanceLeaderboardLoading}
        <div class="empty-state">Loading leaderboard…</div>
      {:else if attendanceLeaderboard.length === 0}
        <div class="empty-state">No attendance activity yet.</div>
      {:else}
        <div class="table-container">
          <table class="table admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Days Present (30d)</th>
                <th>Total Check-Ins</th>
                <th>Last Check-In</th>
              </tr>
            </thead>
            <tbody>
              {#each attendanceLeaderboard as entry (entry.user_id)}
                <tr>
                  <td>
                    <div class="leader-name">{entry.full_name || 'Unknown'}</div>
                    <div class="leader-email">{entry.email || '—'}</div>
                  </td>
                  <td>{entry.days_attended || 0}</td>
                  <td>{entry.total_check_ins || 0}</td>
                  <td>{formatAttendanceTimestamp(entry.last_attended_at)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Locations</h3>
          <p class="text-muted">Capture trusted networks that count as in-person attendance.</p>
        </div>
        <div class="section-actions">
          {#if showLocationForm}
            <button type="button" class="btn btn-outline" on:click={resetLocationForm} disabled={savingLocation}>Cancel</button>
          {/if}
          <button type="button" class="btn btn-primary" on:click={() => openLocationForm()}>
            <Plus size={16} /> New Location
          </button>
        </div>
      </div>

      {#if showLocationForm}
        <div class="attendance-form">
          <label>
            <span class="form-label">Location Name</span>
            <input class="form-input" type="text" placeholder="Shop" bind:value={locationForm.name} />
          </label>
          <label>
            <span class="form-label">Network Prefix</span>
            <div class="input-row">
              <input class="form-input" type="text" placeholder="203.0.113" bind:value={locationForm.network_cidr} />
              <button type="button" class="btn btn-secondary btn-sm" on:click={captureNetwork} disabled={capturingNetwork}>
                {capturingNetwork ? 'Detecting…' : 'Use My Network'}
              </button>
            </div>
            <small class="text-muted">First 3 octets of IPv4 (e.g., 203.0.113) or first 4 hextets of IPv6</small>
          </label>
          <label>
            <span class="form-label">Description</span>
            <textarea class="form-input" rows="2" placeholder="Optional notes" bind:value={locationForm.description}></textarea>
          </label>
          <label class="toggle-input">
            <input type="checkbox" bind:checked={locationForm.active} />
            <span>Active</span>
          </label>
          <div class="form-actions">
            <button type="button" class="btn" on:click={saveLocation} disabled={savingLocation}>
              {savingLocation ? 'Saving…' : editingLocation ? 'Update Location' : 'Create Location'}
            </button>
            <button type="button" class="btn btn-outline" on:click={resetLocationForm} disabled={savingLocation}>Close</button>
          </div>
        </div>
      {/if}

      {#if attendanceLocationsLoading}
        <div class="empty-state">Loading locations…</div>
      {:else if attendanceLocations.length === 0}
        <div class="empty-state">No locations configured.</div>
      {:else}
        <div class="list-table">
          {#each attendanceLocations as loc (loc.id)}
            <div class="list-row">
              <div>
                <div class="list-title">{loc.name}</div>
                <div class="list-subtitle">{loc.network_cidr}</div>
                {#if loc.description}
                  <div class="list-description">{loc.description}</div>
                {/if}
              </div>
              <div class="row-actions">
                <label class="toggle-input">
                  <input type="checkbox" checked={loc.active} on:change={() => toggleLocationActive(loc)} />
                  <span>{loc.active ? 'Active' : 'Paused'}</span>
                </label>
                <button type="button" class="icon-button" on:click={() => openLocationForm(loc)} aria-label={`Edit ${loc.name}`}>
                  <Edit size={16} />
                </button>
                <button type="button" class="icon-button danger" on:click={() => removeLocation(loc)} aria-label={`Delete ${loc.name}`}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Schedules</h3>
          <p class="text-muted">Define recurring windows and tie them to one or more locations.</p>
        </div>
        <div class="section-actions">
          {#if showScheduleForm}
            <button type="button" class="btn btn-outline" on:click={resetScheduleForm} disabled={savingSchedule}>Cancel</button>
          {/if}
          <button type="button" class="btn btn-primary" on:click={() => openScheduleForm()}>
            <Plus size={16} /> New Schedule
          </button>
        </div>
      </div>

      {#if showScheduleForm}
        <div class="attendance-form">
          <label>
            <span class="form-label">Schedule Name</span>
            <input class="form-input" type="text" placeholder="Wednesday Build" bind:value={scheduleForm.label} />
          </label>
          <label>
            <span class="form-label">Day of Week</span>
            <select class="form-select" bind:value={scheduleForm.day_of_week}>
              {#each DAY_LABELS as day, index}
                <option value={index}>{day}</option>
              {/each}
            </select>
          </label>
          <label>
            <span class="form-label">Start Time</span>
            <input class="form-input" type="time" bind:value={scheduleForm.start_time} />
          </label>
          <label>
            <span class="form-label">End Time</span>
            <input class="form-input" type="time" bind:value={scheduleForm.end_time} />
          </label>
          <div>
            <span class="form-label">Locations</span>
            <div class="pill-grid">
              {#if attendanceLocations.length === 0}
                <div class="text-muted">Add a location first.</div>
              {:else}
                {#each attendanceLocations as loc}
                  <label class="pill-option">
                    <input
                      type="checkbox"
                      checked={scheduleForm.location_ids?.includes(loc.id)}
                      on:change={() => toggleScheduleLocation(loc.id)}
                    />
                    <span>{loc.name}</span>
                  </label>
                {/each}
              {/if}
            </div>
            <small class="text-muted">Attendance only records when users are on one of these networks.</small>
          </div>
          <label class="toggle-input">
            <input type="checkbox" bind:checked={scheduleForm.active} />
            <span>Active</span>
          </label>
          <div class="form-actions">
            <button type="button" class="btn" on:click={saveSchedule} disabled={savingSchedule}>
              {savingSchedule ? 'Saving…' : editingSchedule ? 'Update Schedule' : 'Create Schedule'}
            </button>
            <button type="button" class="btn btn-outline" on:click={resetScheduleForm} disabled={savingSchedule}>Close</button>
          </div>
        </div>
      {/if}

      {#if attendanceSchedulesLoading}
        <div class="empty-state">Loading schedules…</div>
      {:else if attendanceSchedules.length === 0}
        <div class="empty-state">No schedules configured.</div>
      {:else}
        <div class="list-table">
          {#each attendanceSchedules as schedule (schedule.id)}
            <div class="list-row">
              <div>
                <div class="list-title">{schedule.label}</div>
                <div class="list-subtitle">
                  {DAY_LABELS[schedule.day_of_week] || '—'} · {schedule.start_time?.slice(0, 5)} – {schedule.end_time?.slice(0, 5)} PT
                </div>
                <div class="badge-row">
                  {#if schedule.locations.length === 0}
                    <span class="text-muted">No linked locations</span>
                  {:else}
                    {#each schedule.locations as loc}
                      <span class="badge-soft">{loc.name}</span>
                    {/each}
                  {/if}
                </div>
              </div>
              <div class="row-actions">
                <span class={`status-dot ${schedule.active ? 'success' : 'muted'}`}>{schedule.active ? 'Active' : 'Paused'}</span>
                <button type="button" class="icon-button" on:click={() => openScheduleForm(schedule)} aria-label={`Edit ${schedule.label}`}>
                  <Edit size={16} />
                </button>
                <button type="button" class="icon-button danger" on:click={() => removeSchedule(schedule)} aria-label={`Delete ${schedule.label}`}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {:else if activeTab === 'purchasing'}
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Vendor Directory</h3>
          <p>Keep the approved vendor list tidy and consistent.</p>
        </div>
        <div class="section-actions">
          <button class="btn btn-primary" on:click={openAddVendorModal}>
            <Plus size={16} /> Add Vendor
          </button>
        </div>
      </div>

      {#if loadingVendors}
        <div class="empty-state">Loading vendors…</div>
      {:else}
        <div class="table-container">
          <table class="table admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>URL Base</th>
                <th>Free Shipping</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each vendors as vendor}
                <tr>
                  <td>{vendor.name}</td>
                  <td>{vendor.url_base}</td>
                  <td>{vendor.free_shipping ? 'Yes' : 'No'}</td>
                  <td>
                    <div class="section-actions">
                      <button class="btn btn-sm btn-secondary" on:click={() => openEditVendorModal(vendor)}>
                        <Edit size={14} /> Edit
                      </button>
                      <button class="btn btn-sm btn-danger" on:click={() => deleteVendor(vendor)}>
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
              {#if vendors.length === 0}
                <tr>
                  <td colspan="4" style="text-align: center;" class="text-muted">No vendors added yet.</td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Purchasing Analytics</h3>
          <p>Filter trends by rolling window or custom dates.</p>
        </div>
      </div>

      <div class="grid-3">
        <div class="form-group">
          <label class="form-label">Time Period</label>
          <select class="form-select" bind:value={timePeriodDays} on:change={() => { customStartDate = ''; customEndDate = ''; }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
            <option value={730}>Last 2 years</option>
            <option value={36500}>All time</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Custom Start Date</label>
          <input type="date" class="form-input" bind:value={customStartDate} />
        </div>
        <div class="form-group">
          <label class="form-label">Custom End Date</label>
          <input type="date" class="form-input" bind:value={customEndDate} />
        </div>
      </div>

      {#if loadingPurchases}
        <div class="empty-state">Loading purchase data…</div>
      {:else}
        <div class="total-spending-card">
          <div class="total-spending-content">
            <div class="total-spending-icon">
              <TrendingUp size={32} />
            </div>
            <div class="total-spending-details">
              <div class="total-spending-label">Total Spending</div>
              <div class="total-spending-amount">${totalSpending.total.toFixed(2)}</div>
              <div class="total-spending-items">{totalSpending.count} items</div>
            </div>
          </div>
        </div>

        <div class="analytics-grid">
          <div class="analytics-card">
            <h4><DollarSign size={20} /> Spending by Approver</h4>
            <div class="analytics-table">
              <table class="table">
                <thead>
                  <tr>
                    <th>Approver</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {#each approverStats as stat}
                    <tr>
                      <td>{stat.approver}</td>
                      <td>{stat.count}</td>
                      <td>${stat.total.toFixed(2)}</td>
                    </tr>
                  {/each}
                  {#if approverStats.length === 0}
                    <tr>
                      <td colspan="3" class="text-muted" style="text-align: center;">No data</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>

          <div class="analytics-card">
            <h4><Package size={20} /> Spending by Orderer</h4>
            <div class="analytics-table">
              <table class="table">
                <thead>
                  <tr>
                    <th>Orderer</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {#each ordererStats as stat}
                    <tr>
                      <td>{stat.orderer}</td>
                      <td>{stat.count}</td>
                      <td>${stat.total.toFixed(2)}</td>
                    </tr>
                  {/each}
                  {#if ordererStats.length === 0}
                    <tr>
                      <td colspan="3" class="text-muted" style="text-align: center;">No data</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>

          <div class="analytics-card">
            <h4><Package size={20} /> Spending by Project</h4>
            <div class="analytics-table">
              <table class="table">
                <thead>
                  <tr>
                    <th>Project ID</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {#each projectStats as stat}
                    <tr>
                      <td>{stat.project_id}</td>
                      <td>{stat.count}</td>
                      <td>${stat.total.toFixed(2)}</td>
                    </tr>
                  {/each}
                  {#if projectStats.length === 0}
                    <tr>
                      <td colspan="3" class="text-muted" style="text-align: center;">No data</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>

          <div class="analytics-card">
            <h4><ShoppingCart size={20} /> Spending by Vendor</h4>
            <div class="analytics-table">
              <table class="table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {#each vendorStats as stat}
                    <tr>
                      <td>{stat.vendor}</td>
                      <td>{stat.count}</td>
                      <td>${stat.total.toFixed(2)}</td>
                    </tr>
                  {/each}
                  {#if vendorStats.length === 0}
                    <tr>
                      <td colspan="3" class="text-muted" style="text-align: center;">No data</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </div>

          <div class="analytics-card">
            <h4><Package size={20} /> Order Summary</h4>
            <div class="analytics-table">
              <table class="table">
                <tbody>
                  <tr>
                    <td><strong>Total Orders</strong></td>
                    <td>{orderStats.orderCount}</td>
                  </tr>
                  <tr>
                    <td><strong>Order Spending</strong></td>
                    <td>${orderStats.totalOrderSpending.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td><strong>Shipping Costs</strong></td>
                    <td>${orderStats.totalShippingCost.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td><strong>Non-Order Spending</strong></td>
                    <td>${orderStats.nonOrderSpending.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td><strong>Avg Order Cost</strong></td>
                    <td>${orderStats.averageOrderCost.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      {/if}
    </section>
  {:else if activeTab === 'budgets'}
    <BudgetsTab />
  {:else if activeTab === 'activity'}
    <ActivityLogTab />
  {:else if activeTab === 'dev' && isDevUser}
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Lead Permissions</h3>
          <p>Every permission each Lead currently holds or lacks, computed the same way the app checks access (role-derived + manual grants).</p>
        </div>
      </div>
      {#if leadsList.length === 0}
        <div class="empty-state">No users currently hold the Lead general role.</div>
      {:else}
        <div class="dev-lead-grid">
          {#each leadsList as lead (lead.id)}
            <div class="dev-lead-card">
              <div class="dev-lead-card-header">
                <strong>{lead.full_name || 'No Name'}</strong>
                <span class="text-muted">{lead.email || '—'}</span>
              </div>
              <div class="dev-perm-group">
                <span class="dev-perm-label dev-perm-label--has">Has</span>
                <div class="dev-perm-chips">
                  {#each PERMISSIONS.filter((p) => hasPermission(lead, p)) as perm}
                    <span class="chip chip-pill dev-perm-chip dev-perm-chip--yes">{formatRoleLabel(perm)}</span>
                  {:else}
                    <span class="text-muted">None</span>
                  {/each}
                </div>
              </div>
              <div class="dev-perm-group">
                <span class="dev-perm-label dev-perm-label--missing">Does not have</span>
                <div class="dev-perm-chips">
                  {#each PERMISSIONS.filter((p) => !hasPermission(lead, p)) as perm}
                    <span class="chip chip-pill dev-perm-chip dev-perm-chip--no">{formatRoleLabel(perm)}</span>
                  {:else}
                    <span class="text-muted">None — has every permission</span>
                  {/each}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<!-- Add Vendor Modal -->
{#if showAddVendorModal}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close add vendor dialog"
    on:click|self={() => showAddVendorModal = false}
    on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAddVendorModal = false; } }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showAddVendorModal = false; } }}
    >
      <div class="modal-header">
        <h3>Add Vendor</h3>
        <button type="button" class="modal-close-button" aria-label="Close add vendor dialog" on:click={() => showAddVendorModal = false}>×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Vendor Name</label>
          <input type="text" class="form-input" bind:value={vendorName} placeholder="e.g., McMaster-Carr" />
        </div>
        <div class="form-group">
          <label class="form-label">URL Base</label>
          <input type="text" class="form-input" bind:value={vendorUrlBase} placeholder="e.g., mcmaster.com" />
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={vendorFreeShipping} />
            <span>Free Shipping</span>
          </label>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={() => showAddVendorModal = false}>Cancel</button>
        <button class="btn btn-primary" on:click={saveVendor}>Add Vendor</button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Vendor Modal -->
{#if showEditVendorModal}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close edit vendor dialog"
    on:click|self={() => { showEditVendorModal = false; editingVendor = null; }}
    on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showEditVendorModal = false; editingVendor = null; } }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showEditVendorModal = false; editingVendor = null; } }}
    >
      <div class="modal-header">
        <h3>Edit Vendor</h3>
        <button type="button" class="modal-close-button" aria-label="Close edit vendor dialog" on:click={() => { showEditVendorModal = false; editingVendor = null; }}>×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Vendor Name</label>
          <input type="text" class="form-input" bind:value={vendorName} />
        </div>
        <div class="form-group">
          <label class="form-label">URL Base</label>
          <input type="text" class="form-input" bind:value={vendorUrlBase} />
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={vendorFreeShipping} />
            <span>Free Shipping</span>
          </label>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={() => { showEditVendorModal = false; editingVendor = null; }}>Cancel</button>
        <button class="btn btn-primary" on:click={saveVendor}>Save Changes</button>
      </div>
    </div>
  </div>
{/if}

<!-- Create Roster Modal -->
{#if showCreateRosterModal}
  <div
    class="modal-backdrop"
    role="button"
    tabindex="0"
    aria-label="Close roster dialog"
    on:click|self={() => showCreateRosterModal = false}
    on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showCreateRosterModal = false; } }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showCreateRosterModal = false; } }}
    >
      <div class="modal-header">
        <h3>Create Roster</h3>
        <button type="button" class="modal-close-button" aria-label="Close roster dialog" on:click={() => showCreateRosterModal = false}>×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Roster Name</label>
          <input type="text" class="form-input" bind:value={newRosterName} placeholder="e.g., Engineering Team" />
        </div>
        <div class="form-group">
          <label class="form-label">Roster Type</label>
          <select class="form-select" bind:value={newRosterType}>
            <option value="multi">Multi-Select</option>
            <option value="single">Single-Select</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={newRosterPublic} />
            <span>Public Roster</span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={newRosterAdmin} />
            <span>Admin Only</span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-label">Target FRC Team</label>
          <select class="form-select" bind:value={newRosterTargetFrcTeam}>
            <option value="all">All Members</option>
            <option value="students">Students Only (971 + 9584)</option>
            <option value="971">Team 971 Only</option>
            <option value="9584">Team 9584 Only</option>
          </select>
          <small class="form-help">Filter which members can be assigned to this roster</small>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={() => showCreateRosterModal = false}>Cancel</button>
        <button class="btn btn-primary" on:click={createRoster}>Create Roster</button>
      </div>
    </div>
  </div>
{/if}
{/if}

<!-- Confirmation modal for destructive / privileged user actions -->
{#if pendingConfirm}
  <div
    class="modal-backdrop"
    on:click|self={cancelConfirm}
    role="button"
    tabindex="0"
    on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelConfirm(); } }}
  >
    <div class="modal confirm-modal" role="dialog" aria-modal="true">
      <h3>{pendingConfirm.title}</h3>
      <p class="confirm-message">{pendingConfirm.message}</p>
      <div class="confirm-actions">
        <button class="btn" on:click={cancelConfirm}>Cancel</button>
        <button class="btn {pendingConfirm.danger ? 'btn-danger' : 'btn-primary'}" on:click={runConfirm}>
          {pendingConfirm.confirmLabel || 'Confirm'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .access-denied {
    text-align: center;
    padding: var(--space-6);
    color: var(--text-muted);
  }
  .access-denied h2 {
    color: var(--danger);
    margin-bottom: var(--space-2);
  }
  .error { color: var(--danger); font-weight: 600; }
  .admin-table td:nth-child(2) { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .role-filters { display: flex; flex-wrap: wrap; gap: var(--gap-3); margin-bottom: var(--space-3); align-items: center; }
  .filter-input { flex: 1 1 160px; min-width: 160px; }
  .role-select { border-color: var(--role-border, var(--border)); background: var(--role-bg, var(--primary)); color: var(--role-text, var(--text)); font-weight: 600; transition: border-color 0.2s ease, background 0.2s ease; }
  /* Dark theme: the inline role themes are light pastels (unreadable and
     glaring on dark). Derive a translucent chip from each role's hue so the
     color coding survives; light themes keep the original pastel look. */
  :global([data-theme="modern-dark"]) .role-select {
    background: color-mix(in srgb, var(--role-border, var(--border)) 14%, transparent);
    border-color: color-mix(in srgb, var(--role-border, var(--border)) 45%, transparent);
    color: color-mix(in srgb, var(--role-border, var(--border)) 60%, #ffffff);
  }
  .role-select:disabled { opacity: 0.7; cursor: progress; }
  .role-select option { color: var(--text); background: var(--primary); font-weight: 500; }
  /* Native <select> width:100% (global .form-select) will happily shrink
     below its selected option's text width as the table's columns get
     squeezed at in-between viewport sizes (wider than the mobile-card
     breakpoint, narrower than the selects' natural width) — that reads as
     clipped/truncated labels ("Purchasin", "Mento"). A floor in px (not %)
     stops the shrink, so the table's total width instead exceeds the
     container and .table-container's horizontal scrollbar takes over. */
  .desktop-admin-table .role-select { min-width: 138px; }
  .pending-row { background: var(--neutral-100); }
  .name-cell { display: flex; flex-direction: column; gap: var(--gap-1); }
  .email-cell { display: flex; flex-direction: column; gap: var(--gap-1); font-size: var(--font-xs); }
  .status-chip { text-transform: uppercase; letter-spacing: 0.04em; font-size: var(--font-xs); }
  .status-chip--admin { background: var(--blue-soft); color: var(--blue-strong); border-color: var(--blue-soft); }
  /* Devs sit above regular admins (see isDev() in $lib/permissions.js) — a
     distinct hue so the tier reads at a glance instead of blending into the
     Admin badge. */
  .status-chip--dev { background: var(--purple-soft); color: var(--purple-strong); border-color: var(--purple-soft); }
  /* Admin/dev accounts bypass every role check (see hasPermission's
     role === 'admin' short-circuit), so their general/purchasing/team-role
     fields are often sparse or stale — the dropdowns still show the real
     stored values (and stay editable for admins/devs), but this extra chip
     makes clear those values aren't the whole story. */
  .status-chip--admin-full { background: var(--green-soft); color: var(--green-strong); border-color: var(--green-soft); font-weight: 700; }
  .all-permissions-cell { text-align: left; }

  /* ===== Dev tab: Lead permissions audit ===== */
  .dev-lead-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--gap-4);
  }
  .dev-lead-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .dev-lead-card-header {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--border);
  }
  .dev-lead-card-header span {
    font-size: var(--font-xs);
  }
  .dev-perm-group {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }
  .dev-perm-label {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .dev-perm-label--has { color: var(--green-strong); }
  .dev-perm-label--missing { color: var(--text-muted); }
  .dev-perm-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-1);
  }
  .dev-perm-chip { font-size: 0.68rem; }
  .dev-perm-chip--yes { background: var(--green-soft); color: var(--green-strong); border-color: var(--green-soft); }
  .dev-perm-chip--no { background: var(--muted-bg); color: var(--text-muted); border-color: var(--border); }
  .status-chip--pending { background: var(--brand-gold-soft); color: var(--brand-gold-strong); border-color: var(--brand-gold-soft); }
  .roster-selector-block { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4) var(--space-6); background: var(--surface-1); display: flex; flex-direction: column; gap: var(--gap-3); box-shadow: var(--shadow-sm); }
  .roster-pill-row { display: flex; flex-wrap: wrap; gap: var(--gap-2); max-height: 240px; overflow-y: auto; }
  .roster-main { display: flex; flex-direction: column; gap: var(--gap-6); margin-top: var(--space-4); }
  .roster-workspace { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: var(--gap-6); align-items: flex-start; }
  .keys-column .sticky-card { position: sticky; top: var(--space-4); max-height: calc(100vh - 140px); overflow: hidden; }
  .keys-column .sticky-card .list-card__items { max-height: calc(100vh - 320px); }
  .members-column .list-card__items { max-height: calc(100vh - 320px); overscroll-behavior: contain; overflow-y: auto; }
  .member-list { max-height: calc(100vh - 220px); overflow-y: auto; padding-right: 0.35rem; overscroll-behavior: contain; }
  .member-row--compact { padding: var(--space-1) var(--space-2); gap: var(--gap-2); align-items: flex-start; }
  .member-row--compact strong { font-size: var(--font-xs); }
  .chip-compact { padding: var(--space-1) var(--space-2); font-size: 0.7rem; }
  .saving-indicator { font-size: var(--font-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .attendance-search { min-width: 240px; }
  .attendance-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--gap-4); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); background: var(--surface-1); margin-bottom: var(--space-6); }
  .attendance-form .form-label { font-weight: 600; display: block; margin-bottom: var(--space-1); }
  .attendance-form textarea { resize: vertical; }
  .input-row { display: flex; gap: var(--gap-2); align-items: center; }
  .pill-grid { display: flex; flex-wrap: wrap; gap: var(--gap-2); margin: var(--space-2) 0; }
  .pill-option { display: inline-flex; align-items: center; gap: var(--gap-1); border: 1px solid var(--border); border-radius: var(--radius-full); padding: var(--space-1) var(--space-3); font-size: var(--font-xs); background: var(--surface-2); }
  .pill-option input { margin: 0; }
  .toggle-input { display: inline-flex; align-items: center; gap: var(--gap-1); font-weight: 600; }
  .attendance-form .form-actions { display: flex; gap: var(--gap-2); flex-wrap: wrap; }
  .leader-name { font-weight: 600; }
  .leader-email { font-size: var(--font-xs); color: var(--muted-text, var(--neutral-500)); }
  .list-description { font-size: var(--font-xs); color: var(--muted-text, var(--neutral-500)); margin-top: var(--space-1); }
  .row-actions { display: flex; align-items: center; gap: var(--gap-2); }
  .status-dot { font-size: var(--font-xs); font-weight: 600; padding: var(--space-1) var(--space-2); border-radius: var(--radius-full); background: var(--surface-2); }
  .status-dot.success { color: var(--green-strong); background: var(--green-soft); }
  .status-dot.muted { color: var(--neutral-500); background: var(--neutral-300); }

  /* Mobile User Cards - Hidden on desktop */
  .mobile-user-cards {
    display: none;
  }
  
  .user-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-bottom: var(--space-3);
  }
  
  .user-card.pending-card {
    background: var(--neutral-100);
    border-color: var(--brand-gold-soft);
  }
  
  .user-card-header {
    margin-bottom: var(--space-3);
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  
  .user-card-name {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-1);
  }
  
  .user-card-name strong {
    font-size: 1rem;
    color: var(--secondary);
  }
  
  .user-card-email {
    font-size: var(--font-xs);
    color: var(--text-muted);
  }
  
  .user-card-roles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--gap-3);
  }
  
  .user-card-role {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  
  .user-card-role .role-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    font-weight: 600;
  }
  
  .user-card-role .form-select {
    font-size: 0.8rem;
    padding: var(--space-2);
  }

  .notify-checkboxes {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .notify-checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text);
    cursor: pointer;
  }

  .notify-checkbox-label input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }

  /* Mobile Responsive - Tablet */
  @media (max-width: 900px) {
    .admin-table td:nth-child(2) { max-width: unset; white-space: normal; }
    .roster-workspace { grid-template-columns: 1fr; }
    .keys-column .sticky-card { position: static; max-height: none; }
  }

  /* Mobile Responsive - Phone */
  @media (max-width: 768px) {
    .role-filters {
      flex-direction: column;
      align-items: stretch;
    }
    
    .filter-input {
      flex: 1 1 100%;
      min-width: unset;
    }
    
    .roster-selector-block {
      padding: var(--space-3);
    }
    
    .roster-pill-row {
      max-height: 180px;
    }
    
    .attendance-search {
      min-width: unset;
      width: 100%;
    }
    
    .attendance-form {
      grid-template-columns: 1fr;
      padding: var(--space-3);
    }
    
    .input-row {
      flex-direction: column;
      align-items: stretch;
    }
    
    .row-actions {
      flex-wrap: wrap;
    }
    
    .member-list {
      max-height: calc(100vh - 280px);
    }
    
    /* Hide desktop table, show mobile cards */
    .desktop-admin-table {
      display: none;
    }
    
    .mobile-user-cards {
      display: block;
    }
  }

  @media (max-width: 480px) {
    .roster-main {
      gap: var(--gap-4);
    }
    
    .roster-pill-row {
      max-height: 140px;
    }
    
    .pill-option {
      padding: var(--space-1) var(--space-2);
      font-size: 0.65rem;
    }
    
    .chip-compact {
      font-size: 0.6rem;
      padding: 2px var(--space-1);
    }
    
    .member-row--compact {
      flex-direction: column;
    }
    
    .attendance-form .form-actions {
      flex-direction: column;
    }
    
    .attendance-form .form-actions .btn {
      width: 100%;
    }
    
    /* Single column role cards on small phones */
    .user-card-roles {
      grid-template-columns: 1fr;
    }
    
    .user-card {
      padding: var(--space-3);
    }
  }

  .user-action-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-1, 0.25rem);
  }

  .confirm-modal {
    width: min(420px, 92vw);
    padding: var(--space-6, 1.5rem);
  }

  .confirm-modal h3 { margin: 0 0 var(--space-3, 0.75rem); }

  .confirm-message {
    margin: 0 0 var(--space-4, 1rem);
    color: var(--text, var(--neutral-800));
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-2, 0.5rem);
  }
</style>
