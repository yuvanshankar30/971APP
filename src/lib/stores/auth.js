import { writable } from 'svelte/store';
import { supabase } from '$lib/supabase.js';

/**
 * Minimal auth stores:
 * - user: Supabase auth user (null when signed out)
 * - userProfile: row from user_profiles (null when signed out or missing)
 *
 * IMPORTANT: We never await inside the Supabase auth callback to avoid deadlocks.
 */
export const user = writable(null);
export const userProfile = writable(null);
export const authReady = writable(false);

let subscription = null;
let initialized = false;
let initCount = 0;

export async function fetchUserProfile(userId) {
  if (!userId) {
    userProfile.set(null);
    return null;
  }
  try {
    const [profileResult, rosterResult] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, email, full_name, role, is_dev, permissions, header_tabs, dashboard_layout, login_screen_style, created_at, updated_at, banned, general_role, purchasing_role, team_role, frc_team, notification_settings, slack_user_id, slack_dm_channel, manufacturing_lead_workflows')
        .eq('id', userId)
        .single(),
      supabase
        .from('roster_entries')
        .select('key:key_id(key_name)')
        .eq('user_id', userId)
    ]);
    const { data, error } = profileResult;

    if (error) {
      console.warn('user_profiles fetch error:', error.message || error);
      userProfile.set(null);
      return null;
    }
    // Normalize header_tabs: it may come back as JSON text or as an array
    let headerTabs = data.header_tabs ?? null;
    if (typeof headerTabs === 'string') {
      try {
        headerTabs = JSON.parse(headerTabs);
      } catch (e) {
        console.warn('Failed to parse header_tabs JSON', e);
        headerTabs = null;
      }
    }
    if (headerTabs && !Array.isArray(headerTabs)) {
      // unexpected shape, ignore
      headerTabs = null;
    }

    const profile = {
      id: data.id,
      email: data.email || '',
      full_name: data.full_name || '',
      role: data.role || 'member',
      permissions: Array.isArray(data.permissions)
        ? data.permissions.map(String)
        : data.permissions
        ? [String(data.permissions)]
        : [],
      general_role: data.general_role || 'member',
      purchasing_role: data.purchasing_role || 'basic',
      team_role: data.team_role || 'other',
      frc_team: data.frc_team || null,
      roster_keys: (rosterResult.data || []).map((entry) => entry?.key?.key_name).filter(Boolean),
      is_dev: !!data.is_dev,
      // new customization fields
      header_tabs: headerTabs,
      dashboard_layout: data.dashboard_layout || 'grid',
      created_at: data.created_at || '',
  updated_at: data.updated_at || '',
  banned: !!data.banned,
  notification_settings: data.notification_settings || null,
  slack_user_id: data.slack_user_id || null,
  slack_dm_channel: data.slack_dm_channel || null,
  manufacturing_lead_workflows: Array.isArray(data.manufacturing_lead_workflows) ? data.manufacturing_lead_workflows : []
    };

    userProfile.set(profile);
    return profile;
  } catch (e) {
    console.warn('user_profiles fetch exception:', e?.message || e);
    userProfile.set(null);
    return null;
  }
}

/**
 * Initialize auth once per app load.
 * - Sets current auth user on load
 * - Loads user_profiles row when signed in
 * - Clears userProfile when signed out
 *
 * No awaits inside the auth callback; async work is scheduled.
 */
export function initAuth() {
  initCount += 1;

  if (!initialized) {
    initialized = true;
    authReady.set(false);

    // Initial session load (safe to await here; not inside callback)
    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) console.warn('getSession error:', error.message || error);
        const authUser = data?.session?.user ?? null;
        user.set(authUser);
        if (authUser) {
          await fetchUserProfile(authUser.id);
        } else {
          userProfile.set(null);
        }
      } finally {
        authReady.set(true);
      }
    })();
  }

  if (!subscription) {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const authUser = session?.user ?? null;
      user.set(authUser);

      if (event === 'SIGNED_IN' && authUser) {
        // Avoid await inside callback to prevent deadlocks
        queueMicrotask(() => {
          void fetchUserProfile(authUser.id);
        });
      } else if (event === 'SIGNED_OUT') {
        userProfile.set(null);
      }

      authReady.set(true);
    });

    subscription = data?.subscription ?? null;
  }

  // Return unsubscribe function
  return () => {
    initCount = Math.max(0, initCount - 1);
    if (initCount > 0) return;

    subscription?.unsubscribe?.();
    subscription = null;
    initialized = false;
    authReady.set(false);
  };
}

/**
 * Simple sign-out helper.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error('Error logging out:', error);
}

// Back-compat alias for existing code that reads from "userStore"
export const userStore = userProfile;
