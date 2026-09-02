import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { buildTaskPromptSchedule } from '$lib/planner/schedule.js';
import {
  isPlannerDrivePracticeTask,
  PLANNER_REACTION_TO_STATUS,
  PLANNER_STATUS_TO_REACTION
} from '$lib/planner/constants.js';
import { canPlannerReactionUpdateStatus } from '$lib/planner/status.js';
import { ensureApproverDmChannel, getSlackClient, getSupabase, slackUserIdForEmail } from '$lib/server/971bot.js';
import { recordSlackActivity } from '$lib/server/slack_activity.js';
import { fetchPlannerSnapshot } from '$lib/server/planner_data.js';
import { formatPacific } from '$lib/timezone.js';

const PLANNER_PROMPT_SWEEP_LEASE_KEY = 'planner_prompt_sweep';
const PLANNER_PROMPT_SWEEP_LEASE_SECONDS = 120;

function getAppBaseUrl() {
  const origin =
    env.PUBLIC_APP_ORIGIN ||
    env.APP_ORIGIN ||
    env.SITE_URL ||
    env.PUBLIC_SITE_URL ||
    publicEnv.PUBLIC_APP_ORIGIN ||
    publicEnv.PUBLIC_SITE_URL ||
    'https://971app.vercel.app';
  return String(origin || '').replace(/\/$/, '');
}

function getPlannerLink(itemId) {
  return `${getAppBaseUrl()}/planner?item=${itemId}`;
}

function getDrivePracticeReportLink(item, scheduledFor) {
  const params = new URLSearchParams({
    item_id: String(item?.id || ''),
    source: 'drive_practice',
    practice_label: String(item?.title || 'Drive Practice'),
    scheduled_for: new Date(scheduledFor).toISOString()
  });
  return `${getAppBaseUrl()}/tasks/report-p0?${params.toString()}`;
}

function checkpointLabel(checkpoint) {
  if (checkpoint === 'session_midpoint' || checkpoint === 'midpoint') return 'Halfway Through Meeting';
  if (checkpoint === 'session_start') return 'Meeting Start';
  if (checkpoint === 'session_end') return 'Meeting End';
  if (checkpoint === 'task_end' || checkpoint === 'end') return 'Task End';
  if (checkpoint === 'task_start' || checkpoint === 'start') return 'Task Start';
  return 'Planner Check-In';
}

function formatMoment(value) {
  try {
    const formatted = formatPacific(value, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
    return formatted ? `${formatted} PT` : '';
  } catch {
    return String(value || '');
  }
}

async function fetchNotificationUser(userId, supa) {
  if (!userId) return null;
  const { data } = await supa
    .from('user_profiles')
    .select('id, email, full_name, slack_user_id, slack_dm_channel, banned')
    .eq('id', userId)
    .maybeSingle();
  return data?.banned ? null : (data || null);
}

async function ensureSlackUserId(user, supa) {
  if (user?.slack_user_id) return user.slack_user_id;
  if (!user?.email) return null;
  const slackId = await slackUserIdForEmail(user.email);
  if (slackId) {
    await supa.from('user_profiles').update({ slack_user_id: slackId }).eq('id', user.id);
    user.slack_user_id = slackId;
  }
  return slackId;
}

async function ensureSlackDmChannel(user, supa) {
  if (user?.slack_dm_channel) return user.slack_dm_channel;
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

function promptText({ item, checkpoint, scheduledFor, ownerName }) {
  const when = formatMoment(scheduledFor);
  const who = ownerName ? `${ownerName}, ` : '';
  const isTaskStartPrompt = checkpoint === 'task_start' || checkpoint === 'start';
  const actionHelp = isTaskStartPrompt
    ? 'React to this message with white, green, yellow, red, or the check mark reaction to set the planner status.'
    : 'React with white, green, yellow, red, or the check mark reaction to update the planner status.';
  return `${who}${checkpointLabel(checkpoint)} check-in for ${item.title} at ${when}. ${actionHelp} ${getPlannerLink(item.id)}`;
}

function drivePracticePromptText({ item, scheduledFor, ownerName }) {
  const when = formatMoment(scheduledFor);
  const who = ownerName ? `${ownerName}, ` : '';
  return `${who}drive practice "${item?.title || 'Drive Practice'}" wrapped at ${when}. Please report any P0 bugs you found here: ${getDrivePracticeReportLink(item, scheduledFor)} If there were no P0 bugs, no action is needed.`;
}

function isUniqueViolation(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '23505' || message.includes('duplicate key value') || message.includes('unique constraint');
}

async function persistPlannerPromptRecord({ item, ownerId, checkpoint, scheduledFor, response, supa }) {
  const scheduledForIso = new Date(scheduledFor).toISOString();
  const payload = {
    frc_team: item.frc_team,
    planner_item_id: item.id,
    owner_id: ownerId,
    checkpoint,
    scheduled_for: scheduledForIso,
    sent_at: new Date().toISOString(),
    slack_channel: response.channel,
    slack_ts: response.ts
  };

  const { data: exactRow, error: exactRowError } = await supa
    .from('planner_slack_prompts')
    .select('id')
    .eq('planner_item_id', item.id)
    .eq('owner_id', ownerId)
    .eq('checkpoint', checkpoint)
    .eq('scheduled_for', scheduledForIso)
    .maybeSingle();
  if (exactRowError) throw exactRowError;

  if (exactRow?.id) {
    const { error: updateError } = await supa
      .from('planner_slack_prompts')
      .update(payload)
      .eq('id', exactRow.id);
    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await supa
    .from('planner_slack_prompts')
    .insert(payload);
  if (!insertError) return;
  if (!isUniqueViolation(insertError)) throw insertError;

  // Back-compat for older databases that only allow one row per item/owner/checkpoint.
  const { data: legacyRow, error: legacyRowError } = await supa
    .from('planner_slack_prompts')
    .select('id')
    .eq('planner_item_id', item.id)
    .eq('owner_id', ownerId)
    .eq('checkpoint', checkpoint)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (legacyRowError) throw legacyRowError;
  if (!legacyRow?.id) throw insertError;

  const { error: legacyUpdateError } = await supa
    .from('planner_slack_prompts')
    .update(payload)
    .eq('id', legacyRow.id);
  if (legacyUpdateError) throw legacyUpdateError;
}

export async function sendPlannerPrompt({ item, ownerId, checkpoint, scheduledFor }) {
  const supa = getSupabase();
  const user = await fetchNotificationUser(ownerId, supa);
  if (!user) return { ok: false, reason: 'missing-user' };

  const channel = await ensureSlackDmChannel(user, supa);
  if (!channel) return { ok: false, reason: 'missing-channel' };

  const isDrivePracticePrompt = isPlannerDrivePracticeTask(item) && checkpoint === 'task_end';
  const client = getSlackClient();
  const response = await client.chat.postMessage({
    channel,
    text: isDrivePracticePrompt
      ? drivePracticePromptText({
        item,
        scheduledFor,
        ownerName: user.full_name || user.email || null
      })
      : promptText({
        item,
        checkpoint,
        scheduledFor,
        ownerName: user.full_name || user.email || null
      })
  });

  if (!response?.ok || !response.ts || !response.channel) {
    return { ok: false, reason: 'post-failed' };
  }

  await recordSlackActivity(supa, {
    text: isDrivePracticePrompt
      ? drivePracticePromptText({ item, scheduledFor, ownerName: user.full_name || user.email || null })
      : promptText({ item, checkpoint, scheduledFor, ownerName: user.full_name || user.email || null }),
    channel: response.channel,
    ts: response.ts,
    recipient: user.full_name || user.email || null,
    category: 'Planner prompt'
  });

  if (!isDrivePracticePrompt) {
    const seededReactions = Array.from(new Set(Object.values(PLANNER_STATUS_TO_REACTION)));
    for (const checkpointReaction of seededReactions) {
      try {
        await client.reactions.add({
          channel: response.channel,
          timestamp: response.ts,
          name: checkpointReaction
        });
      } catch (error) {
        console.warn('Failed to add planner reaction', error?.data || error?.message || error);
      }
    }
  }

  await persistPlannerPromptRecord({
    item,
    ownerId,
    checkpoint,
    scheduledFor,
    response,
    supa
  });

  return { ok: true, channel: response.channel, ts: response.ts };
}

async function getAlertChannel() {
  const configured = env.PLANNER_ALERT_CHANNEL_ID || env.SLACK_ALERT_CHANNEL_ID || null;
  if (configured) return configured;
  try {
    return await ensureApproverDmChannel();
  } catch {
    return null;
  }
}

export async function broadcastPlannerRedAlert({ item, checkpoint, reactionUserId }) {
  const alertChannel = await getAlertChannel();
  if (!alertChannel) return { ok: false, reason: 'missing-alert-channel' };

  const supa = getSupabase();
  const user = reactionUserId ? await fetchNotificationUser(reactionUserId, supa) : null;
  const actorLabel = user?.full_name || user?.email || 'A teammate';
  const client = getSlackClient();
  const response = await client.chat.postMessage({
    channel: alertChannel,
    text: `Planner alert: ${item.title} was marked RED during ${checkpointLabel(checkpoint)}. Updated by ${actorLabel}. ${getPlannerLink(item.id)}`
  });
  if (response?.ok) {
    await recordSlackActivity(supa, {
      text: `Planner alert: ${item.title} was marked RED during ${checkpointLabel(checkpoint)}. Updated by ${actorLabel}. ${getPlannerLink(item.id)}`,
      channel: response.channel || alertChannel,
      ts: response.ts || null,
      category: 'Planner alert'
    });
  }
  return { ok: !!response?.ok };
}

export async function sendDuePlannerPrompts(now = new Date()) {
  const supa = getSupabase();
  const { data: existingPrompts, error: promptsError } = await supa
    .from('planner_slack_prompts')
    .select('planner_item_id, owner_id, checkpoint, scheduled_for, sent_at');
  if (promptsError) throw promptsError;

  const sentKeys = new Set(
    (existingPrompts || [])
      .filter((prompt) => prompt?.sent_at)
      .map((prompt) => `${prompt.planner_item_id}:${prompt.owner_id}:${prompt.checkpoint}:${new Date(prompt.scheduled_for).toISOString()}`)
  );

  const teams = ['971', '9584'];
  let sentCount = 0;
  for (const team of teams) {
    const snapshot = await fetchPlannerSnapshot(supa, team);
    const ownerRowsByItem = new Map();
    for (const ownerRow of snapshot.owner_rows || []) {
      if (ownerRow.owner_type !== 'owner') continue;
      if (!ownerRowsByItem.has(ownerRow.planner_item_id)) ownerRowsByItem.set(ownerRow.planner_item_id, []);
      ownerRowsByItem.get(ownerRow.planner_item_id).push(ownerRow.user_id);
    }

    for (const item of snapshot.items || []) {
      if (item.kind !== 'task' || !item.scheduled_start_at || !item.scheduled_end_at) continue;
      const checkpoints = buildTaskPromptSchedule(item, snapshot.calendar_rules);
      if (!checkpoints.length) continue;
      const owners = ownerRowsByItem.get(item.id) || [];

      for (const ownerId of owners) {
        for (const checkpoint of checkpoints) {
          const dueAt = checkpoint.scheduled_for;
          if (!dueAt || dueAt > now) continue;
          const dedupeKey = `${item.id}:${ownerId}:${checkpoint.checkpoint}:${new Date(dueAt).toISOString()}`;
          if (sentKeys.has(dedupeKey)) continue;
          const result = await sendPlannerPrompt({
            item,
            ownerId,
            checkpoint: checkpoint.checkpoint,
            scheduledFor: dueAt
          });
          if (result?.ok) {
            sentKeys.add(dedupeKey);
            sentCount += 1;
          }
        }
      }
    }
  }

  return {
    ok: true,
    sent: sentCount,
    plannerPromptsSent: sentCount,
    drivePracticePromptsSent: 0
  };
}

async function claimPlannerPromptSweepLease({ leaseSeconds = PLANNER_PROMPT_SWEEP_LEASE_SECONDS, minIntervalSeconds = 0 } = {}) {
  const supa = getSupabase();
  const { data, error } = await supa.rpc('claim_runtime_lease', {
    lease_key: PLANNER_PROMPT_SWEEP_LEASE_KEY,
    lease_seconds: leaseSeconds,
    min_interval_seconds: Math.max(0, Number(minIntervalSeconds) || 0)
  });
  if (error) throw error;
  return !!data;
}

async function releasePlannerPromptSweepLease() {
  const supa = getSupabase();
  const { error } = await supa.rpc('release_runtime_lease', {
    lease_key: PLANNER_PROMPT_SWEEP_LEASE_KEY
  });
  if (error) throw error;
}

export async function runPlannerPromptSweep(now = new Date(), options = {}) {
  const claimed = await claimPlannerPromptSweepLease(options);
  if (!claimed) {
    return {
      ok: true,
      skipped: true,
      reason: 'lease-unavailable',
      sent: 0,
      plannerPromptsSent: 0,
      drivePracticePromptsSent: 0
    };
  }

  try {
    return await sendDuePlannerPrompts(now);
  } finally {
    try {
      await releasePlannerPromptSweepLease();
    } catch (error) {
      console.warn('Failed to release planner prompt sweep lease', error?.message || error);
    }
  }
}

export async function handlePlannerReaction({ channel, ts, reaction, reactingUser }) {
  const status = PLANNER_REACTION_TO_STATUS[String(reaction || '').trim()];
  if (!status || !channel || !ts) return { handled: false };

  const supa = getSupabase();
  const { data: prompt, error: promptError } = await supa
    .from('planner_slack_prompts')
    .select('id, frc_team, planner_item_id, owner_id, checkpoint, slack_channel, slack_ts')
    .eq('slack_channel', channel)
    .eq('slack_ts', ts)
    .maybeSingle();
  if (promptError) throw promptError;
  if (!prompt?.id) return { handled: false };

  const owner = await fetchNotificationUser(prompt.owner_id, supa);
  if (owner?.slack_user_id && reactingUser && owner.slack_user_id !== reactingUser) {
    return { handled: true, ignored: true };
  }

  const { data: item, error: itemError } = await supa
    .from('planner_items')
    .select('id, frc_team, item_type, work_category, title, status')
    .eq('id', prompt.planner_item_id)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item?.id) return { handled: true, ignored: true };
  if (isPlannerDrivePracticeTask(item)) return { handled: true, ignored: true };

  await supa
    .from('planner_slack_prompts')
    .update({
      responded_status: status,
      responded_at: new Date().toISOString()
    })
    .eq('id', prompt.id);

  if (!canPlannerReactionUpdateStatus(item.status, prompt.checkpoint)) {
    return {
      handled: true,
      ignored: true,
      reason: 'awaiting-task-start-reaction',
      status: item.status,
      recorded_status: status
    };
  }

  if (item.status !== status) {
    await supa
      .from('planner_items')
      .update({ status })
      .eq('id', item.id);
  }

  if (status === 'red') {
    await broadcastPlannerRedAlert({
      item,
      checkpoint: prompt.checkpoint,
      reactionUserId: prompt.owner_id
    });
  }

  return { handled: true, status };
}
