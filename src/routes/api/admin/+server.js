import { json } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import {
  PERMISSIONS,
  getRoleDerivedPermissions,
  normalizePermissions,
  hasPermission,
  GENERAL_ROLES,
  PURCHASING_ROLES
} from '$lib/permissions.js';
import { getSupabase } from '$lib/server/971bot.js';

const getClientFromRequest = (request) => {
  const auth = request?.headers?.get('authorization') || '';
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } }
  });
};

/** @type {import('./$types').RequestHandler} */
export async function GET({ url, request }) {
  const action = url.searchParams.get('action');

  if (action === 'list-users') {
    // First, verify the caller has admin access using their auth token
    const userSupa = getClientFromRequest(request);
    const { data: { user: authUser } } = await userSupa.auth.getUser();

    if (!authUser) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch caller's profile to check permissions
    const { data: callerProfile } = await userSupa
      .from('user_profiles')
      .select('id, role, permissions, general_role, purchasing_role')
      .eq('id', authUser.id)
      .single();

    // Check if caller has VIEW_ADMIN_PANEL permission (via hasPermission which checks roles too)
    if (!callerProfile || !hasPermission(callerProfile, 'VIEW_ADMIN_PANEL')) {
      return json({ error: 'Not authorized to view admin panel' }, { status: 403 });
    }

    // Use service role client to bypass RLS and get ALL users
    let serviceSupa;
    try {
      serviceSupa = getSupabase();
    } catch (e) {
      console.error('Failed to initialize service Supabase client for admin list-users:', e);
      return json({ error: 'Server misconfigured: missing SUPABASE_SERVICE_KEY' }, { status: 500 });
    }

    const { data, error } = await serviceSupa
      .from('user_profiles')
      .select('id, email, full_name, role, is_dev, permissions, banned, general_role, purchasing_role, team_role, frc_team, manufacturing_lead_workflows, vision_notify')
      .order('full_name', { ascending: true });

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ success: true, data });
  }

  return json({ error: 'Invalid action' }, { status: 400 });
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  try {
    const body = await request.json();
    const { actor_id, target_id, permissions, action } = body || {};
    const supa = getClientFromRequest(request);

    if (!actor_id || !target_id) {
      return json({ error: 'actor_id and target_id required' }, { status: 400 });
    }

    // Fetch actor profile and check permission
    const { data: actor } = await supa
      .from('user_profiles')
      .select('id, role, is_dev, permissions')
      .eq('id', actor_id)
      .single();

    const actorPerms = Array.isArray(actor?.permissions)
      ? actor.permissions.map(String)
      : actor?.permissions
        ? [String(actor.permissions)]
        : [];

    const isActorAdmin = actor?.role === 'admin';
    const isActorDev = !!actor?.is_dev;

    // Action shortcuts: promote / ban / approve
    if (action === 'promote') {
      // Granting the 'admin' role is reserved for existing admins — leads
      // with PROMOTE_USERS can still promote/approve in other ways, but
      // minting new admins is not one of them.
      if (!isActorAdmin) {
        return json({ error: 'Not authorized to promote users' }, { status: 403 });
      }
      const { error } = await supa
        .from('user_profiles')
        .update({ role: 'admin', banned: false })
        .eq('id', target_id);
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true });
    }

    if (action === 'ban') {
      if (!isActorAdmin && !actorPerms.includes('BAN_USERS')) {
        return json({ error: 'Not authorized to ban users' }, { status: 403 });
      }
      // Devs can only be banned by another dev; admins (dev or not) are
      // otherwise still bannable by anyone holding BAN_USERS, unchanged.
      const { data: banTarget } = await supa
        .from('user_profiles')
        .select('is_dev')
        .eq('id', target_id)
        .single();
      if (banTarget?.is_dev && !isActorDev) {
        return json({ error: 'Only a dev can ban another dev' }, { status: 403 });
      }
      const { error } = await supa
        .from('user_profiles')
        .update({ role: 'banned', banned: true })
        .eq('id', target_id);
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true });
    }

    if (action === 'remove') {
      if (!isActorAdmin && !actorPerms.includes('BAN_USERS')) {
        return json({ error: 'Not authorized to remove users' }, { status: 403 });
      }
      if (String(actor_id) === String(target_id)) {
        return json({ error: 'You cannot remove your own account' }, { status: 400 });
      }
      // Don't allow removing a dev unless the actor is a dev, or removing
      // another admin unless the actor is an admin.
      const { data: target } = await supa
        .from('user_profiles')
        .select('role, is_dev')
        .eq('id', target_id)
        .single();
      if (target?.is_dev && !isActorDev) {
        return json({ error: 'Only a dev can remove another dev' }, { status: 403 });
      }
      if (target?.role === 'admin' && !isActorAdmin) {
        return json({ error: 'Only an admin can remove another admin' }, { status: 403 });
      }
      const { error } = await supa
        .from('user_profiles')
        .delete()
        .eq('id', target_id);
      if (error) return json({ error: error.message }, { status: 500 });

      // Also delete the Supabase Auth account so the email frees up and the
      // person can re-register from scratch. Requires service-role access.
      try {
        const admin = getSupabase();
        await admin.auth.admin.deleteUser(target_id);
      } catch (e) {
        // Profile is gone either way; log but don't fail the request.
        console.warn('Could not delete auth user (they can still re-register if profile-gated):', e?.message || e);
      }
      return json({ success: true });
    }

    if (action === 'approve') {
      if (!isActorAdmin && !actorPerms.includes('APPROVE_USERS')) {
        return json({ error: 'Not authorized to approve users' }, { status: 403 });
      }

      // Ensure approved users can see routes by adding CAN_SEE_ROUTES
      const { data: target, error: tErr } = await supa
        .from('user_profiles')
        .select('permissions')
        .eq('id', target_id)
        .single();
      if (tErr) return json({ error: tErr.message }, { status: 500 });

      const currentPerms = Array.isArray(target?.permissions)
        ? target.permissions.map(String)
        : target?.permissions
          ? [String(target.permissions)]
          : [];

      // Normalize and ensure only known permissions
      const normalized = currentPerms.filter((p) => PERMISSIONS.includes(p));
      if (!normalized.includes('CAN_SEE_ROUTES')) normalized.push('CAN_SEE_ROUTES');

      const { error } = await supa
        .from('user_profiles')
        .update({ role: 'member', banned: false, permissions: normalized, general_role: 'member' })
        .eq('id', target_id);
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true });
    }

    if (action === 'update-roles') {
      const { general_role, purchasing_role, team_role, frc_team, manufacturing_lead_workflows, vision_notify } = body;
      if (!isActorAdmin && !actorPerms.includes('EDIT_PERMISSIONS')) {
        return json({ error: 'Not authorized' }, { status: 403 });
      }
      // Devs are exempt: they may edit their own roles (and each other's).
      if (!isActorDev && String(actor_id) === String(target_id)) {
        return json({ error: 'You cannot change your own roles' }, { status: 400 });
      }

      const { data: targetRow, error: targetErr } = await supa
        .from('user_profiles')
        .select('id, email, full_name, permissions, general_role, purchasing_role, team_role, frc_team, role, is_dev, header_tabs, dashboard_layout, created_at, updated_at, banned, notification_settings, slack_user_id, slack_dm_channel')
        .eq('id', target_id)
        .single();
      if (targetErr) return json({ error: targetErr.message }, { status: 500 });

      // Dev roles can only be changed by another dev. Failing that, only an
      // admin can change another admin's roles — leads with EDIT_PERMISSIONS
      // otherwise have no ceiling on who they can edit.
      if (targetRow.is_dev && !isActorDev) {
        return json({ error: "Only a dev can change another dev's roles" }, { status: 403 });
      }
      if (targetRow.role === 'admin' && !isActorAdmin) {
        return json({ error: "Only an admin can change another admin's roles" }, { status: 403 });
      }

      const existingPerms = normalizePermissions(targetRow.permissions);
      const prevRolePerms = getRoleDerivedPermissions({
        general_role: targetRow.general_role,
        purchasing_role: targetRow.purchasing_role,
        team_role: targetRow.team_role
      });
      const manualExtras = existingPerms.filter((perm) => !prevRolePerms.has(perm));

      const nextGeneralRole = general_role ?? targetRow.general_role ?? GENERAL_ROLES.NONE;
      const nextPurchasingRole = purchasing_role ?? targetRow.purchasing_role ?? PURCHASING_ROLES.BASIC;
      const nextTeamRole = team_role ?? targetRow.team_role;

      const nextRolePerms = getRoleDerivedPermissions({
        general_role: nextGeneralRole,
        purchasing_role: nextPurchasingRole,
        team_role: nextTeamRole
      });
      let merged = Array.from(new Set([...nextRolePerms, ...manualExtras])).filter((perm) => PERMISSIONS.includes(perm));

      if (!merged.includes('VIEW_ADMIN_PANEL')) {
        merged = merged.filter((perm) => perm !== 'BAN_USERS' && perm !== 'APPROVE_USERS');
      }

      // Build update payload - only include fields that were passed
      const updatePayload = { permissions: merged };
      if (general_role !== undefined) updatePayload.general_role = general_role;
      if (purchasing_role !== undefined) updatePayload.purchasing_role = purchasing_role;
      if (team_role !== undefined) updatePayload.team_role = team_role;
      if (frc_team !== undefined) updatePayload.frc_team = frc_team;
      if (manufacturing_lead_workflows !== undefined) updatePayload.manufacturing_lead_workflows = manufacturing_lead_workflows;
      if (vision_notify !== undefined) updatePayload.vision_notify = !!vision_notify;

      const { data: updatedRow, error } = await supa
        .from('user_profiles')
        .update(updatePayload)
        .eq('id', target_id)
        .select('id, email, full_name, role, permissions, general_role, purchasing_role, team_role, frc_team, header_tabs, dashboard_layout, created_at, updated_at, banned, notification_settings, slack_user_id, slack_dm_channel, manufacturing_lead_workflows, vision_notify')
        .single();
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data: updatedRow });
    }

    if (action === 'update-notifications') {
      const { manufacturing_lead_workflows, vision_notify } = body;
      const { data: { user: authenticatedUser } } = await supa.auth.getUser();
      if (!authenticatedUser) return json({ error: 'Unauthorized' }, { status: 401 });
      if (String(authenticatedUser.id) !== String(actor_id)) {
        return json({ error: 'Actor does not match authenticated user' }, { status: 403 });
      }

      const editingSelf = String(actor_id) === String(target_id);
      if (!editingSelf && !isActorAdmin && !isActorDev && !actorPerms.includes('EDIT_PERMISSIONS')) {
        return json({ error: 'Not authorized' }, { status: 403 });
      }
      if (manufacturing_lead_workflows === undefined && vision_notify === undefined) {
        return json({ error: 'No notification settings supplied' }, { status: 400 });
      }

      const { data: targetRow, error: targetErr } = await supa
        .from('user_profiles')
        .select('id, role, is_dev')
        .eq('id', target_id)
        .single();
      if (targetErr) return json({ error: targetErr.message }, { status: 500 });

      if (!editingSelf && targetRow.is_dev && !isActorDev) {
        return json({ error: "Only a dev can change another dev's notifications" }, { status: 403 });
      }
      if (!editingSelf && targetRow.role === 'admin' && !isActorAdmin) {
        return json({ error: "Only an admin can change another admin's notifications" }, { status: 403 });
      }

      const updatePayload = {};
      if (manufacturing_lead_workflows !== undefined) {
        if (!Array.isArray(manufacturing_lead_workflows)) {
          return json({ error: 'manufacturing_lead_workflows must be an array' }, { status: 400 });
        }
        const allowedWorkflows = new Set(['3d-print', 'router', 'lathe']);
        const normalizedWorkflows = Array.from(new Set(manufacturing_lead_workflows.map(String)));
        if (normalizedWorkflows.some((workflow) => !allowedWorkflows.has(workflow))) {
          return json({ error: 'Unknown manufacturing notification workflow' }, { status: 400 });
        }
        updatePayload.manufacturing_lead_workflows = normalizedWorkflows;
      }
      if (vision_notify !== undefined) updatePayload.vision_notify = !!vision_notify;

      const { data: updatedRow, error } = await supa
        .from('user_profiles')
        .update(updatePayload)
        .eq('id', target_id)
        .select('id, manufacturing_lead_workflows, vision_notify')
        .single();
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, data: updatedRow });
    }

    // Default to editing permissions
    if (!Array.isArray(permissions)) {
      return json({ error: 'permissions[] required for permission updates' }, { status: 400 });
    }

    if (!isActorAdmin && !actorPerms.includes('EDIT_PERMISSIONS')) {
      return json({ error: 'Not authorized' }, { status: 403 });
    }

    // Ensure only known permissions are stored
    let filtered = permissions
      .map(String)
      .filter((p) => PERMISSIONS.includes(p));

    // Enforce: without VIEW_ADMIN_PANEL, you cannot be granted BAN_USERS or APPROVE_USERS
    if (!filtered.includes('VIEW_ADMIN_PANEL')) {
      filtered = filtered.filter((p) => p !== 'BAN_USERS' && p !== 'APPROVE_USERS');
    }

    const { error } = await supa
      .from('user_profiles')
      .update({ permissions: filtered })
      .eq('id', target_id);

    if (error) return json({ error: error.message }, { status: 500 });

    return json({ success: true });
  } catch (err) {
    return json({ error: err.message || String(err) }, { status: 500 });
  }
}
