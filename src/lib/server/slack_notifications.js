import { getSupabase, getSlackClient, slackUserIdForEmail } from '$lib/server/971bot';
import { recordSlackActivity } from '$lib/server/slack_activity.js';
import { NOTIFICATION_KEYS } from '$lib/notifications/constants.js';
import { mergeNotificationSettings } from '$lib/notifications/settings.js';
import { formatPacificDateTimeWithZone, formatPacificTimeWithZone, formatPacificDate } from '$lib/timezone.js';

function formatMatchLabel(matchKey = '') {
  if (!matchKey) return 'match';
  const parts = matchKey.split('_');
  const last = parts[parts.length - 1] || matchKey;
  if (/^qm\d+/i.test(last)) {
    return `Qualification ${last.replace(/^qm/i, '')}`;
  }
  if (/^sf\d+/i.test(last)) {
    return `Semi ${last.replace(/^sf/i, '')}`;
  }
  if (/^f\d+/i.test(last)) {
    return `Final ${last.replace(/^f/i, '')}`;
  }
  return last.toUpperCase();
}

async function fetchNotificationUser(userId, supa) {
  if (!userId) return null;
  const { data } = await supa
    .from('user_profiles')
    .select('id, email, full_name, notification_settings, slack_user_id, slack_dm_channel')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

async function ensureSlackUserId(user, supa) {
  if (user.slack_user_id) return user.slack_user_id;
  if (!user.email) return null;
  const slackId = await slackUserIdForEmail(user.email);
  if (slackId) {
    await supa.from('user_profiles').update({ slack_user_id: slackId }).eq('id', user.id);
    user.slack_user_id = slackId;
  }
  return slackId;
}

async function ensureSlackDmChannel(user, supa) {
  if (user.slack_dm_channel) return user.slack_dm_channel;
  const slackUserId = await ensureSlackUserId(user, supa);
  if (!slackUserId) return null;
  const client = getSlackClient();
  const response = await client.conversations.open({ users: slackUserId });
  if (response?.ok && response.channel?.id) {
    const channel = response.channel.id;
    await supa.from('user_profiles').update({ slack_dm_channel: channel }).eq('id', user.id);
    user.slack_dm_channel = channel;
    return channel;
  }
  return null;
}

async function recordNotificationLog(supa, userId, notificationKey, entityKey) {
  if (!entityKey) return;
  const { data: existing } = await supa
    .from('user_notification_logs')
    .select('id')
    .eq('user_id', userId)
    .eq('event_type', notificationKey)
    .eq('entity_key', entityKey)
    .maybeSingle();
  if (existing) {
    throw new Error('duplicate_notification');
  }
  await supa
    .from('user_notification_logs')
    .insert({ user_id: userId, event_type: notificationKey, entity_key: entityKey });
}

async function dispatchNotification({ userId, notificationKey, entityKey = null, text, blocks = null }) {
  const supa = getSupabase();
  const user = await fetchNotificationUser(userId, supa);
  if (!user) return { ok: false, reason: 'missing-user' };

  const settings = mergeNotificationSettings(user.notification_settings);
  if (settings[notificationKey] === false) {
    return { ok: false, reason: 'disabled' };
  }

  try {
    await recordNotificationLog(supa, user.id, notificationKey, entityKey);
  } catch (err) {
    if (err?.message === 'duplicate_notification') {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }

  const channel = await ensureSlackDmChannel(user, supa);
  if (!channel) {
    return { ok: false, reason: 'missing-channel' };
  }

  const client = getSlackClient();
  const response = await client.chat.postMessage({ channel, text, blocks });
  if (response?.ok) {
    await recordSlackActivity(supa, {
      text,
      channel: response.channel || channel,
      ts: response.ts || null,
      recipient: user.full_name || user.email || null,
      category: 'Notification',
      notificationKey
    });
  }
  return {
    ok: !!response?.ok,
    channel: response?.channel || channel,
    ts: response?.ts || null
  };
}

export async function notifyScoutAssignment({ assignmentId, userId, matchKey, teamKey, scoutingType }) {
  if (!userId || !assignmentId) return { ok: false, reason: 'invalid-input' };
  const teamDisplay = teamKey ? teamKey.replace(/^frc/i, '') : 'team';
  const label = formatMatchLabel(matchKey);
  const typeLabel = scoutingType === 'note' ? 'note' : scoutingType === 'quick' ? 'quick' : 'data';
  const text = `You were assigned to ${typeLabel} scouting for ${label} (Team ${teamDisplay}).`;
  return dispatchNotification({
    userId,
    notificationKey: NOTIFICATION_KEYS.SHIFT_ASSIGNMENTS,
    text
  });
}

export async function notifyPitAssignment({ assignmentId, userId, teamKey }) {
  if (!userId || !assignmentId) return { ok: false, reason: 'invalid-input' };
  const teamDisplay = teamKey ? teamKey.replace(/^frc/i, '') : 'a team';
  const text = `You were assigned to pit scout Team ${teamDisplay}.`;
  return dispatchNotification({
    userId,
    notificationKey: NOTIFICATION_KEYS.SHIFT_ASSIGNMENTS,
    text
  });
}

export async function notifyPartAssignmentById(partId) {
  const supa = getSupabase();
  const { data: part } = await supa
    .from('parts')
    .select('id, name, project_id, workflow, assigned_to, updated_at')
    .eq('id', partId)
    .maybeSingle();
  if (!part?.assigned_to) {
    return { ok: false, reason: 'no-assignee' };
  }
  const text = `Manufacturing assigned you to ${part.name || 'a part'} (${part.workflow}) for ${part.project_id}.`;
  const entityKey = part.updated_at ? `${part.id}:${part.assigned_to}:${part.updated_at}` : null;
  return dispatchNotification({
    userId: part.assigned_to,
    notificationKey: NOTIFICATION_KEYS.PART_ASSIGNMENTS,
    entityKey,
    text
  });
}

async function findSubsystemIdForPart(partId, existingSubsystemId = null) {
  if (existingSubsystemId) return existingSubsystemId;
  const supa = getSupabase();
  const { data } = await supa
    .from('build_bom')
    .select('builds(subsystem_id)')
    .eq('parts_id', partId)
    .maybeSingle();
  return data?.builds?.subsystem_id || null;
}

export async function notifyPartCompletedById(partId) {
  const supa = getSupabase();
  const { data: part } = await supa
    .from('parts')
    .select('id, name, project_id, workflow, status, subsystem_id')
    .eq('id', partId)
    .maybeSingle();
  if (!part || part.status !== 'complete') {
    return { ok: false, reason: 'not-complete' };
  }
  const subsystemId = await findSubsystemIdForPart(part.id, part.subsystem_id);
  if (!subsystemId) {
    return { ok: false, reason: 'no-subsystem' };
  }
  const { data: members } = await supa
    .from('subsystem_members')
    .select('user_id')
    .eq('subsystem_id', subsystemId);
  if (!members?.length) {
    return { ok: false, reason: 'no-members' };
  }
  const text = `${part.name || 'A part'} for ${part.project_id} is marked complete.`;
  const results = [];
  for (const member of members) {
    if (!member?.user_id) continue;
    const entityKey = `${part.id}:${member.user_id}:complete`;
    const res = await dispatchNotification({
      userId: member.user_id,
      notificationKey: NOTIFICATION_KEYS.SUBSYSTEM_PARTS_COMPLETE,
      entityKey,
      text
    });
    results.push(res);
  }
  return { ok: true, sent: results.length };
}

export async function notifyPurchaseApprovedById(purchaseId) {
  const supa = getSupabase();
  const { data: purchase } = await supa
    .from('purchasing')
    .select('id, name, project_id, status, purchaser, requester')
    .eq('id', purchaseId)
    .maybeSingle();
  if (!purchase || purchase.status !== 'approved' || !purchase.purchaser) {
    return { ok: false, reason: 'not-approved' };
  }
  const text = `${purchase.name || 'Your purchase'} for ${purchase.project_id} was approved.`;
  const entityKey = `${purchase.id}:${purchase.purchaser}:approved`;
  return dispatchNotification({
    userId: purchase.purchaser,
    notificationKey: NOTIFICATION_KEYS.PURCHASE_APPROVED,
    entityKey,
    text
  });
}

export async function notifyMatchReminder({ userId, matchKey, teams, matchTime }) {
  if (!userId || !matchKey) return { ok: false, reason: 'invalid-input' };
  const label = formatMatchLabel(matchKey);
  const teamList = teams && teams.length ? teams.map((t) => t.replace(/^frc/i, '')).join(', ') : 'your assigned teams';
  const whenLabel = matchTime ? formatPacificTimeWithZone(matchTime * 1000) : '';
  const when = whenLabel ? ` at ${whenLabel}` : '';
  const text = `${label}${when} is starting soon. You're scouting teams ${teamList}.`; 
  const entityKey = `${matchKey}:${userId}`;
  return dispatchNotification({
    userId,
    notificationKey: NOTIFICATION_KEYS.MATCH_REMINDERS,
    entityKey,
    text
  });
}

function taskStatusLabel(status = '') {
  const map = {
    red: 'Red',
    yellow: 'Yellow',
    green: 'Green',
    completed: 'Completed',
    open: 'Red',
    in_progress: 'Yellow',
    file_uploaded: 'Yellow',
    under_review: 'Yellow',
    changes_requested: 'Red',
    approved: 'Green',
    done: 'Completed',
    closed: 'Completed'
  };
  return map[status] || String(status || 'Updated');
}

async function fetchPlannerItemOwnerId(supa, taskId) {
  const { data: ownerRow, error: ownerError } = await supa
    .from('planner_item_people')
    .select('user_id')
    .eq('planner_item_id', taskId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ownerError) throw ownerError;
  return ownerRow?.user_id || null;
}

export async function notifyTaskAssignedById(taskId) {
  const supa = getSupabase();
  const { data: task } = await supa
    .from('planner_items')
    .select('id, title, created_at, item_type')
    .eq('id', taskId)
    .eq('item_type', 'p0_bug')
    .maybeSingle();
  const ownerId = task?.id ? await fetchPlannerItemOwnerId(supa, task.id) : null;
  if (!ownerId) {
    return { ok: false, reason: 'no-assignee' };
  }
  const text = `You were assigned P0 bug: ${task.title || 'Untitled bug'}.`;
  const entityKey = task.created_at ? `task:${task.id}:assigned:${ownerId}:${task.created_at}` : `task:${task.id}:assigned`;
  return dispatchNotification({
    userId: ownerId,
    notificationKey: NOTIFICATION_KEYS.TASK_ASSIGNED,
    entityKey,
    text
  });
}

export async function handleP0BugAssignmentReaction({ channel, ts, reaction, reactingUser }) {
  void channel;
  void ts;
  void reaction;
  void reactingUser;
  return { handled: false };
}

export async function notifyTaskReviewRequestedById(taskId) {
  void taskId;
  return { ok: false, reason: 'review-flow-removed' };
}

export async function notifyTaskStatusChanged({
  taskId,
  previousStatus = null,
  nextStatus = null,
  changedByName = null,
  changedByUserId = null
}) {
  const supa = getSupabase();
  const { data: task } = await supa
    .from('planner_items')
    .select('id, title, status, updated_at, item_type')
    .eq('id', taskId)
    .eq('item_type', 'p0_bug')
    .maybeSingle();
  const ownerId = task?.id ? await fetchPlannerItemOwnerId(supa, task.id) : null;
  if (!ownerId) {
    return { ok: false, reason: 'no-assignee' };
  }
  if (changedByUserId && ownerId === changedByUserId) {
    return { ok: false, reason: 'self-change' };
  }
  const fromLabel = taskStatusLabel(previousStatus || task.status);
  const toLabel = taskStatusLabel(nextStatus || task.status);
  const actor = changedByName ? ` by ${changedByName}` : '';
  const text = `Task status updated${actor}: ${task.title || 'Untitled task'} (${fromLabel} -> ${toLabel}).`;
  const entityKey = task.updated_at
    ? `task:${task.id}:status:${ownerId}:${task.updated_at}:${toLabel}`
    : `task:${task.id}:status:${toLabel}`;
  return dispatchNotification({
    userId: ownerId,
    notificationKey: NOTIFICATION_KEYS.TASK_STATUS_CHANGED,
    entityKey,
    text
  });
}

export async function notifyTaskDeadlineById(taskId) {
  void taskId;
  return { ok: false, reason: 'deadlines-removed' };
}

// Manufacturing leads-per-workflow live in the DB
// (user_profiles.manufacturing_lead_workflows, a text[] of workflow
// values), editable from the admin panel's "Notifications" role field -
// not a hardcoded map anymore. Deliberately NOT tied to is_dev: an earlier
// version auto-included every is_dev account (meant to cover Yuvan Shankar
// for oversight), but that also silently pulled in other unrelated dev
// accounts (e.g. William Jojarth) who shouldn't get these pings. Anyone who
// needs to see everything - Yuvan included - is just assigned every current
// workflow explicitly, the same as any other lead. Workflow values are the
// real, verbatim strings used by parts.workflow throughout
// manufacture/create/+page.svelte and manufacture/+page.svelte - not an
// enum, just free text.
async function manufacturingLeadsForWorkflow(supa, workflow) {
  const { data, error } = await supa
    .from('user_profiles')
    .select('id, email, manufacturing_lead_workflows');
  if (error || !data) return [];
  return data.filter((u) => (u.manufacturing_lead_workflows || []).includes(workflow));
}

const WORKFLOW_LABELS = {
  'router': 'Router Cut',
  'lathe': 'Lathe Turn',
  'mill': 'Mill',
  'laser-cut': 'Laser Cut',
  '3d-print': '3D Print'
};

// Resolves the real downloadable file(s) attached to a part. Mirrors the
// exact parsing logic manufacture/+page.svelte's getFileMeta()/
// getStepFileName() already use client-side: file_url is either a plain
// Storage path (generic/3D-print forms - file_name and file_url are the
// same value) or a JSON blob { step_file, pdf_file, step_valid } (router/
// lathe, which can have both a STEP and a PDF attached to one part).
// Onshape-sourced parts (is_onshape_part) have no static Storage file at
// all - their STEP is translated on demand via the Onshape API - so
// there's nothing to link and this returns [].
function resolvePartFiles(part) {
  if (part.is_onshape_part) return [];
  let meta = {};
  try {
    meta = JSON.parse(part.file_url || '') || {};
  } catch {
    meta = {};
  }
  const files = [];
  if (meta.step_file) files.push({ label: 'STEP file', path: meta.step_file });
  if (meta.pdf_file) files.push({ label: 'PDF drawing', path: meta.pdf_file });
  if (!files.length && part.file_url) {
    const ext = (part.file_name || part.file_url).split('.').pop()?.toLowerCase();
    const label = ext === 'pdf' ? 'PDF drawing' : /^(step|stp)$/.test(ext || '') ? 'STEP file' : 'File';
    files.push({ label, path: part.file_url });
  }
  return files;
}

// A week is deliberately much longer than every other signed URL already
// in this codebase (60s-3600s elsewhere) - those are all "generate right
// before an immediate click" download buttons. This is a link sitting in a
// Slack DM that might not get opened same-day, so it needs to survive
// longer than a typical in-app download link does.
const NOTIFICATION_FILE_LINK_TTL_SECONDS = 60 * 60 * 24 * 7;

async function partFileLinks(supa, part) {
  const files = resolvePartFiles(part);
  const lines = [];
  for (const file of files) {
    const { data, error } = await supa.storage
      .from('manufacturing-files')
      .createSignedUrl(file.path, NOTIFICATION_FILE_LINK_TTL_SECONDS);
    if (!error && data?.signedUrl) {
      lines.push(`<${data.signedUrl}|Download ${file.label}>`);
    }
  }
  return lines;
}

export async function notifyManufacturingRequestById(partId) {
  const supa = getSupabase();
  const { data: part, error: partError } = await supa
    .from('parts')
    .select('id, name, workflow, project_id, requester, created_at, quantity, material, notes, file_name, file_url, is_onshape_part')
    .eq('id', partId)
    .maybeSingle();
  if (partError) console.error('notifyManufacturingRequestById: parts query failed', partError);
  if (!part) {
    return { ok: false, reason: 'no-part' };
  }

  const leads = await manufacturingLeadsForWorkflow(supa, part.workflow);
  if (!leads.length) {
    return { ok: false, reason: 'no-leads-configured' };
  }

  const workflowLabel = WORKFLOW_LABELS[part.workflow] || part.workflow;
  const requesterLabel = part.requester || 'Someone';
  const dateLabel = formatPacificDate(part.created_at) || formatPacificDate(new Date());
  const lines = [`${requesterLabel} has requested to ${workflowLabel} ${part.name || 'Unnamed part'}, on ${dateLabel}.`];

  // Quantity/material only ever appear if actually present - quantity is
  // usually set (form-required) but material isn't collected on every
  // creation path (only Quick Print Add and the CAD BOM insert set it;
  // manufacture/create's 3 forms don't), so this line is skipped rather
  // than showing a blank "Material: " when it was never typed.
  const details = [];
  if (part.quantity) details.push(`Quantity: ${part.quantity}`);
  if (part.material) details.push(`Material: ${part.material}`);
  if (details.length) lines.push(details.join(' · '));

  if (part.notes) lines.push(`Note: ${part.notes}`);

  lines.push(...(await partFileLinks(supa, part)));

  const text = lines.join('\n');

  const results = [];
  for (const lead of leads) {
    const entityKey = part.created_at ? `${part.id}:${lead.id}:${part.created_at}` : `${part.id}:${lead.id}`;
    const res = await dispatchNotification({
      userId: lead.id,
      notificationKey: NOTIFICATION_KEYS.MANUFACTURING_REQUEST,
      entityKey,
      text
    });
    results.push({ ...res, email: lead.email });
  }
  return { ok: true, sent: results };
}

// parts.requester is free-text (no FK to user_profiles - see the
// RosterManager plan doc for why), so this is a best-effort
// case-insensitive full_name match, not a reliable join. Silently no-ops
// if nothing matches (typo, nickname, requester never made an account,
// etc.) rather than erroring - same "skip gracefully" pattern used
// throughout this file for missing Slack users/channels.
async function findUserIdByFullName(supa, name) {
  if (!name) return null;
  const { data } = await supa
    .from('user_profiles')
    .select('id')
    .ilike('full_name', name.trim())
    .maybeSingle();
  return data?.id || null;
}

// Called on every status update, unconditionally - relies entirely on
// dispatchNotification's own dedup (entityKey with no timestamp/counter
// suffix) to make repeat calls a no-op after the first real "started"/
// "ready" transition, rather than the caller having to know the
// before/after status to detect a real transition itself.
export async function notifyPartRequesterStatusById(partId, newStatus) {
  if (!partId || !newStatus) return { ok: false, reason: 'invalid-input' };
  const supa = getSupabase();
  const { data: part, error: partError } = await supa
    .from('parts')
    .select('id, name, requester, workflow')
    .eq('id', partId)
    .maybeSingle();
  if (partError) console.error('notifyPartRequesterStatusById: parts query failed', partError);
  if (!part?.requester) return { ok: false, reason: 'no-requester' };

  const requesterId = await findUserIdByFullName(supa, part.requester);
  if (!requesterId) return { ok: false, reason: 'requester-not-found' };

  const workflowLabel = WORKFLOW_LABELS[part.workflow] || part.workflow;
  const partName = part.name || 'Unnamed part';
  const results = [];

  if (newStatus !== 'pending') {
    results.push(await dispatchNotification({
      userId: requesterId,
      notificationKey: NOTIFICATION_KEYS.MANUFACTURING_REQUEST_STARTED,
      entityKey: `${part.id}:started`,
      text: `Work has started on your ${workflowLabel} request: ${partName}.`
    }));
  }
  if (newStatus === 'complete' || newStatus === 'kitted') {
    results.push(await dispatchNotification({
      userId: requesterId,
      notificationKey: NOTIFICATION_KEYS.MANUFACTURING_REQUEST_READY,
      entityKey: `${part.id}:ready`,
      text: `Your ${workflowLabel} request is ready: ${partName}.`
    }));
  }
  return { ok: true, sent: results };
}

// Router-specific pipeline steps (see WORKFLOW_STATUSES.router in
// statuses.js) - the only workflow with this many distinct, individually
// actionable stages between "in progress" and "complete." 'pending' is
// deliberately excluded: it's the starting state parts already sit in, not
// something worth a "changed to" DM.
const ROUTER_STATUS_LEAD_MESSAGES = {
  'in-progress': (name) => `${name} is now in progress.`,
  'cam_review': (name) => `${name} is CAM'd and ready for review.`,
  'cammed': (name) => `CAM review done for ${name} - ready to postprocess.`,
  'postprocessed': (name) => `${name} has been postprocessed - ready to load on the machine.`,
  'jprogged': (name) => `${name} has been loaded onto the machine (Jprogged).`,
  'machined': (name) => `${name} has finished machining.`,
  'complete': (name) => `${name} is complete and kitted.`
};

// Notifies the leads signed up for the Router workflow (manufacturing_lead_
// workflows includes 'router') whenever a router part reaches a new
// pipeline step - not the requester (see notifyPartRequesterStatusById
// above for that) and not a test/reserved workflow value (manufacturingLeads
// ForWorkflow only ever returns real subscribers for the literal workflow
// string passed in, so a part with workflow: 'test' naturally resolves to no
// leads and this is a no-op, same safety property the rest of this file's
// notifications already have). Called on every status update, same
// unconditional-call-relies-on-dedup pattern as notifyPartRequesterStatusById
// - entityKey has no timestamp, so a repeat call for a status already
// notified is a silent no-op.
export async function notifyRouterLeadsStatusById(partId, newStatus) {
  if (!partId || !newStatus) return { ok: false, reason: 'invalid-input' };
  const buildMessage = ROUTER_STATUS_LEAD_MESSAGES[newStatus];
  if (!buildMessage) return { ok: false, reason: 'not-a-notifiable-status' };

  const supa = getSupabase();
  const { data: part, error: partError } = await supa
    .from('parts')
    .select('id, name, workflow')
    .eq('id', partId)
    .maybeSingle();
  if (partError) console.error('notifyRouterLeadsStatusById: parts query failed', partError);
  if (!part || part.workflow !== 'router') return { ok: false, reason: 'not-router-workflow' };

  const leads = await manufacturingLeadsForWorkflow(supa, 'router');
  if (!leads.length) return { ok: false, reason: 'no-leads-configured' };

  const text = buildMessage(part.name || 'Unnamed part');
  const results = [];
  for (const lead of leads) {
    results.push({
      ...(await dispatchNotification({
        userId: lead.id,
        notificationKey: NOTIFICATION_KEYS.ROUTER_STATUS_UPDATE,
        entityKey: `${part.id}:leads:${newStatus}`,
        text
      })),
      email: lead.email
    });
  }
  return { ok: true, sent: results };
}

// Vision alert recipients are an explicit admin-managed opt-in
// (user_profiles.vision_notify, set from the admin panel's "Vision Alerts"
// checkbox) rather than derived from a role - this is a small, restricted
// project (see docs/guides/scoutingvision.md) and the recipient list is meant to stay a
// short, deliberately-chosen set, not everyone with a given role.
async function visionAlertRecipients(supa) {
  const { data, error } = await supa
    .from('user_profiles')
    .select('id, email')
    .eq('vision_notify', true);
  if (error || !data) return [];
  return data;
}

export async function notifyVisionRunFailed(runId) {
  if (!runId) return { ok: false, reason: 'invalid-input' };
  const supa = getSupabase();
  const { data: run, error } = await supa
    .from('vision_runs')
    .select('id, model_name, model_version, error, vision_matches(match_key, event_key)')
    .eq('id', runId)
    .maybeSingle();
  if (error || !run) return { ok: false, reason: 'no-run' };

  const recipients = await visionAlertRecipients(supa);
  if (!recipients.length) return { ok: false, reason: 'no-recipients' };

  const matchLabel = run.vision_matches?.match_key || 'a match';
  const text = `Vision run failed on ${matchLabel} (${run.model_name} ${run.model_version}): ${run.error || 'no error message recorded'}.`;
  const results = [];
  for (const recipient of recipients) {
    results.push(await dispatchNotification({
      userId: recipient.id,
      notificationKey: NOTIFICATION_KEYS.VISION_ALERT,
      entityKey: `vision_run:${run.id}:failed`,
      text
    }));
  }
  return { ok: true, sent: results };
}

// A runner that can't reach Qwen stops claiming work entirely and only writes
// last_error to its own row, so queued runs would otherwise sit unprocessed
// with nobody told. Called from a cron sweep (see
// api/notifications/vision-stale-runners/+server.js).
//
// The threshold is deliberately far above the dashboard's 60s online cutoff:
// that one distinguishes "responding right now", this one only fires for an
// outage nobody could mistake for a slow iteration. vision_runner.py
// heartbeats per view and per Qwen clip, so even a runner grinding through a
// full match stays well inside this window - going quiet for 15 minutes means
// crashed, wedged, or shut down, not busy.
export const RUNNER_SILENT_MS = 15 * 60 * 1000;

// Returns the alert a runner row warrants right now, or null when it's
// healthy. Split out from the sweep below so the decision - which is the part
// with real edge cases - is directly testable without standing in for Slack.
export function visionRunnerAlert(runner, now = Date.now()) {
  const lastSeen = runner?.last_seen_at ? new Date(runner.last_seen_at).getTime() : 0;
  const silentMs = now - lastSeen;
  if (silentMs > RUNNER_SILENT_MS) {
    const minutes = Math.round(silentMs / 60000);
    return {
      reason: 'silent',
      // Keyed on last_seen_at so one continuous outage alerts once (the
      // timestamp is frozen while the runner is down, and
      // dispatchNotification dedups on entityKey), while a later, separate
      // outage is a new key and does alert again.
      entityKey: `vision_runner:${runner.runner_id}:silent:${runner.last_seen_at || 'never'}`,
      text: runner.last_seen_at
        ? `Vision runner "${runner.runner_id}" has not checked in for ${minutes} minutes. Queued runs are not being processed.`
        : `Vision runner "${runner.runner_id}" has never checked in. Queued runs are not being processed.`
    };
  }
  const qwen = runner?.runtime_metrics?.qwen;
  if (qwen && qwen.ready === false) {
    return {
      reason: 'qwen-down',
      entityKey: `vision_runner:${runner.runner_id}:qwen-down:${runner.last_seen_at || 'never'}`,
      text: `Vision runner "${runner.runner_id}" is up but cannot reach its Qwen service, so it is not claiming any runs: ${qwen.error || 'Qwen service not ready'}`
    };
  }
  return null;
}

export async function sendVisionRunnerHealthAlerts() {
  const supa = getSupabase();
  const { data: runners, error } = await supa
    .from('vision_runners')
    .select('runner_id, last_seen_at, last_error, current_run_id, runtime_metrics');
  if (error) {
    console.error('sendVisionRunnerHealthAlerts: runners query failed', error);
    return { ok: false, reason: 'query-failed' };
  }
  if (!runners?.length) return { ok: true, checked: 0, sent: 0 };

  const alerts = runners.map((runner) => [runner, visionRunnerAlert(runner)]).filter(([, alert]) => alert);
  if (!alerts.length) return { ok: true, checked: runners.length, sent: 0 };

  const recipients = await visionAlertRecipients(supa);
  if (!recipients.length) return { ok: true, checked: runners.length, sent: 0, reason: 'no-recipients' };

  let sentCount = 0;
  for (const [, alert] of alerts) {
    for (const recipient of recipients) {
      const res = await dispatchNotification({
        userId: recipient.id,
        notificationKey: NOTIFICATION_KEYS.VISION_ALERT,
        entityKey: alert.entityKey,
        text: alert.text
      });
      if (res?.ok) sentCount += 1;
    }
  }
  return { ok: true, checked: runners.length, alerting: alerts.length, sent: sentCount };
}

export async function notifyVisionCriticalDiscrepancy(discrepancyId) {
  if (!discrepancyId) return { ok: false, reason: 'invalid-input' };
  const supa = getSupabase();
  const { data: discrepancy, error } = await supa
    .from('vision_discrepancies')
    .select('id, metric, alliance, vision_value, reference_value, severity, vision_runs(vision_matches(match_key))')
    .eq('id', discrepancyId)
    .maybeSingle();
  if (error || !discrepancy || discrepancy.severity !== 'critical') {
    return { ok: false, reason: 'not-critical' };
  }

  const recipients = await visionAlertRecipients(supa);
  if (!recipients.length) return { ok: false, reason: 'no-recipients' };

  const matchLabel = discrepancy.vision_runs?.vision_matches?.match_key || 'a match';
  const metricLabel = String(discrepancy.metric || '').replaceAll('_', ' ');
  const allianceLabel = discrepancy.alliance ? `${discrepancy.alliance} alliance` : 'unattributed';
  const text = `Critical vision discrepancy on ${matchLabel} (${allianceLabel}): ${metricLabel} - vision ${JSON.stringify(discrepancy.vision_value)} vs TBA ${JSON.stringify(discrepancy.reference_value)}.`;
  const results = [];
  for (const recipient of recipients) {
    results.push(await dispatchNotification({
      userId: recipient.id,
      notificationKey: NOTIFICATION_KEYS.VISION_ALERT,
      entityKey: `vision_discrepancy:${discrepancy.id}:critical`,
      text
    }));
  }
  return { ok: true, sent: results };
}
