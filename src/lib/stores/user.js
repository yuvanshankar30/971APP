/**
 * DEPRECATED: Compatibility shim for old user store APIs.
 * New code should import from `$lib/stores/auth.js`:
 *   import { user, userProfile as userStore, initAuth, signOut } from '$lib/stores/auth.js';
 *
 * This shim keeps existing routes working while drastically simplifying auth:
 * - No localStorage UUID
 * - Uses Supabase auth session directly
 * - Fetches user_profiles for app-level profile (role/permissions)
 *
 * IMPORTANT: Do not await Supabase calls inside auth callbacks.
 * This file is only used from components (onMount etc.), so awaits are safe here.
 */

import { userProfile as userStore } from '$lib/stores/auth.js';

// Back-compat named export used across the app
export { userStore };

// Legacy no-op localStorage helpers (UUID persisted logic removed)
const LS_KEY = 'user_uuid';
export function getUserUUID() {
  // legacy always returns null (UUID persistence removed)
  return null;
}
export function setUserUUID(_uuid) {
  // no-op: we no longer persist UUID
}
export function clearUserUUID() {
  // no-op: we no longer persist UUID
}

/**
 * Normalize/guard permissions to a string array
 * @param {unknown} arr
 * @returns {string[]}
 */
function normalizePermissions(arr) {
  if (!arr) return [];
  if (Array.isArray(arr)) return arr.map(String);
  return [String(arr)];
}

/**
 * Map DB row to the UI profile shape
 */
function normalizeProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    full_name: row.full_name || '',
    role: row.role || 'member',
    is_dev: !!row.is_dev,
    permissions: normalizePermissions(row.permissions),
    general_role: row.general_role || 'member',
    purchasing_role: row.purchasing_role || 'basic',
    team_role: row.team_role || 'other',
    // New customization fields - ensure header_tabs is an array or null
    header_tabs: (function() {
      let h = row.header_tabs ?? null;
      if (typeof h === 'string') {
        try { h = JSON.parse(h); } catch (e) { console.warn('Failed to parse header_tabs in user.js', e); h = null; }
      }
      if (h && !Array.isArray(h)) return null;
      return h;
    })(),
    dashboard_layout: row.dashboard_layout || 'grid',
    show_purchasing_line_totals: row.show_purchasing_line_totals !== false,
    created_at: row.created_at || '',
      updated_at: row.updated_at || '',
      banned: !!row.banned,
      notification_settings: row.notification_settings || null,
      slack_user_id: row.slack_user_id || null,
      slack_dm_channel: row.slack_dm_channel || null,
      frc_team: row.frc_team || null,
      manufacturing_lead_workflows: Array.isArray(row.manufacturing_lead_workflows) ? row.manufacturing_lead_workflows : []
  };
}

/**
 * Fetch a user_profiles row by UUID.
 * Safe to use from components; do NOT call from inside Supabase auth callbacks with await.
 */
export async function fetchUserProfileByUUID(supabase, uuid) {
  if (!supabase || !uuid) {
    userStore.set(null);
    return null;
  }
  try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, email, full_name, role, is_dev, permissions, header_tabs, dashboard_layout, show_purchasing_line_totals, created_at, updated_at, banned, general_role, purchasing_role, team_role, frc_team, notification_settings, slack_user_id, slack_dm_channel, manufacturing_lead_workflows')
      .eq('id', uuid)
      .single();

    if (error) {
      console.warn('fetchUserProfileByUUID error:', error.message || error);
      userStore.set(null);
      return null;
    }
    const prof = normalizeProfile(data);
    userStore.set(prof);
    return prof;
  } catch (e) {
    console.warn('fetchUserProfileByUUID exception:', e?.message || e);
    userStore.set(null);
    return null;
  }
}

/**
 * Hydrate userStore from the current Supabase session (ignores legacy UUID).
 * If a session exists, fetches user_profiles row; otherwise sets null.
 */
export async function loadUserFromUUID(supabase) {
  if (!supabase) {
    userStore.set(null);
    return null;
  }
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) console.warn('getSession error:', error.message || error);
    const authUser = data?.session?.user ?? null;
    if (!authUser?.id) {
      userStore.set(null);
      return null;
    }
    return await fetchUserProfileByUUID(supabase, authUser.id);
  } catch (e) {
    console.warn('loadUserFromUUID exception:', e?.message || e);
    userStore.set(null);
    return null;
  }
}

// Deprecated helper retained for backward compatibility. No longer mutates DB.
// Simply fetches existing profile (if any) by UUID; does not create or update.
export async function upsertProfileIfMissing(supabase, { id } = {}) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const userId = id || data?.session?.user?.id;
    if (!userId) return null;
    return await fetchUserProfileByUUID(supabase, userId);
  } catch (e) {
    console.warn('upsertProfileIfMissing (no-op) exception:', e?.message || e);
    return null;
  }
}
