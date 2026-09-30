import { json } from '@sveltejs/kit';
import { getSlackClient, getSupabase, verifySlackSignature } from '$lib/server/971bot.js';
import { hasPermission } from '$lib/permissions.js';
import { rejectDraftCodeChangePr } from '$lib/server/hub_change_request.js';
import { REJECT_EDIT_ACTION_ID, rejectedEditBlocks } from '$lib/server/hub_edit_actions.js';

function actionPayload(rawBody) {
  const encoded = new URLSearchParams(rawBody).get('payload');
  if (!encoded) return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

async function changeLeadForSlackUser(supa, slackUserId) {
  if (!slackUserId) return null;
  const { data, error } = await supa.from('user_profiles')
    .select('id, full_name, banned, role, permissions, general_role, purchasing_role, team_role, frc_team')
    .eq('slack_user_id', slackUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const rosterResult = await supa.from('roster_entries')
    .select('key:key_id(key_name)')
    .eq('user_id', data.id);
  if (rosterResult.error) throw rosterResult.error;
  const profile = {
    ...data,
    roster_keys: (rosterResult.data || []).map((row) => row?.key?.key_name).filter(Boolean)
  };
  return !profile.banned && hasPermission(profile, 'REQUEST_CODE_CHANGES') ? profile : null;
}

export async function POST({ request }) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  if (!verifySlackSignature(rawBody, headers)) {
    return new Response('Invalid Slack signature', { status: 401 });
  }

  const payload = actionPayload(rawBody);
  const action = payload?.actions?.[0];
  if (payload?.type !== 'block_actions' || action?.action_id !== REJECT_EDIT_ACTION_ID) {
    return json({ ok: true, ignored: true });
  }

  const prNumber = Number(action.value);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    return json({ ok: true, error: 'Invalid draft pull request.' });
  }

  try {
    const supa = getSupabase();
    const reviewer = await changeLeadForSlackUser(supa, payload.user?.id);
    if (!reviewer) {
      return json({ ok: true, error: 'Only a Change Lead can reject a draft pull request.' });
    }

    await rejectDraftCodeChangePr(prNumber, { supa });
    const channel = payload.container?.channel_id;
    const ts = payload.container?.message_ts || payload.message?.ts;
    if (channel && ts) {
      const reviewerName = reviewer.full_name || 'a Change Lead';
      await getSlackClient().chat.update({
        channel,
        ts,
        text: `Draft PR #${prNumber} rejected by ${reviewerName}.`,
        blocks: rejectedEditBlocks(prNumber, reviewerName)
      });
    }
    return json({ ok: true, rejected: true });
  } catch (error) {
    console.error('Could not reject Slack edit draft', error?.message || error);
    return json({ ok: true, error: 'I could not reject that draft pull request.' });
  }
}
