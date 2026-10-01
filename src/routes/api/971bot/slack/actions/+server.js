import { json } from '@sveltejs/kit';
import { getSlackClient, getSupabase, verifySlackSignature } from '$lib/server/971bot.js';
import { hasPermission } from '$lib/permissions.js';
import { approveDraftCodeChangePr, rejectDraftCodeChangePr } from '$lib/server/hub_change_request.js';
import { APPROVE_EDIT_ACTION_ID, REJECT_EDIT_ACTION_ID, changeLeadReviewBlocks, mergedEditBlocks, rejectedEditBlocks } from '$lib/server/hub_edit_actions.js';

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

async function postRequestThreadUpdate(supa, slack, prNumber, text) {
  // The durable preview row is created with every bot draft before leads
  // receive the controls, so it is the authoritative link back to the request.
  try {
    const { data, error } = await supa.from('edit_preview_notifications')
      .select('slack_channel, slack_thread_ts')
      .eq('pr_number', prNumber)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.slack_channel && data?.slack_thread_ts) {
      await slack.chat.postMessage({ channel: data.slack_channel, thread_ts: data.slack_thread_ts, text });
    }
  } catch (error) {
    console.error('Could not post Slack edit state update', error?.message || error);
  }
}

function controlsFor(prNumber, approvalStatus) {
  return changeLeadReviewBlocks({
    requesterName: 'the requester', request: 'the draft pull request', summary: 'Use this control only after the PR is ready.',
    prUrl: `https://github.com/frc971/spartanshub/pull/${prNumber}`, prNumber, approvalStatus
  });
}

export async function POST({ request }) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  if (!verifySlackSignature(rawBody, headers)) {
    return new Response('Invalid Slack signature', { status: 401 });
  }

  const payload = actionPayload(rawBody);
  const action = payload?.actions?.[0];
  if (payload?.type !== 'block_actions' || ![REJECT_EDIT_ACTION_ID, APPROVE_EDIT_ACTION_ID].includes(action?.action_id)) {
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
      return json({ ok: true, error: 'Only a Change Lead can approve or reject a draft pull request.' });
    }
    const channel = payload.container?.channel_id;
    const ts = payload.container?.message_ts || payload.message?.ts;
    const slack = getSlackClient();
    const reviewerName = reviewer.full_name || 'a Change Lead';
    if (action.action_id === APPROVE_EDIT_ACTION_ID) {
      const result = await approveDraftCodeChangePr(prNumber, { supa });
      if (!result.merged) {
        const status = result.phase === 'checks'
          ? `*Approval blocked:* ${result.checks.message}`
          : `*Gemini review did not approve this draft:* ${result.review.summary}`;
        if (channel && ts) await slack.chat.update({ channel, ts, text: status.replace(/\*/g, ''), blocks: controlsFor(prNumber, status) });
        await postRequestThreadUpdate(supa, slack, prNumber, `PR #${prNumber} is still open. ${status.replace(/\*/g, '')}`);
        return json({ ok: true, merged: false, phase: result.phase });
      }
      const mergeUrl = result.merge?.html_url || result.pr?.html_url || null;
      if (channel && ts) {
        await slack.chat.update({
          channel, ts, text: `Draft PR #${prNumber} merged by ${reviewerName}.`,
          blocks: mergedEditBlocks(prNumber, reviewerName, mergeUrl)
        });
      }
      await postRequestThreadUpdate(supa, slack, prNumber, `PR #${prNumber} was approved and merged by ${reviewerName}. All GitHub checks passed and Gemini approved the code review.${mergeUrl ? ` ${mergeUrl}` : ''}`);
      return json({ ok: true, merged: true });
    }

    await rejectDraftCodeChangePr(prNumber, { supa });
    if (channel && ts) {
      await slack.chat.update({
        channel,
        ts,
        text: `Draft PR #${prNumber} rejected by ${reviewerName}.`,
        blocks: rejectedEditBlocks(prNumber, reviewerName)
      });
    }
    await postRequestThreadUpdate(supa, slack, prNumber, `PR #${prNumber} was rejected by ${reviewerName}. The pull request was closed and its bot-created branch was deleted.`);
    return json({ ok: true, rejected: true });
  } catch (error) {
    console.error('Could not reject Slack edit draft', error?.message || error);
    return json({ ok: true, error: 'I could not reject that draft pull request.' });
  }
}
