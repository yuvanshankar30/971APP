import { json } from '@sveltejs/kit';
import {
  verifySlackSignature,
  approvePurchaseInDb,
  getSlackClient,
  ensureApproverDmChannel,
  messageToPurchaseMap,
  getSupabase
} from '$lib/server/971bot';
import { handlePlannerReaction } from '$lib/server/planner_notifications.js';
import { handleP0BugAssignmentReaction } from '$lib/server/slack_notifications.js';
import { handleHubAppMention } from '$lib/server/hub_slack_assistant.js';

// Avoid approving the same purchase repeatedly when multiple reactions are added.
const recentlyApprovedPurchases = new Set();
const recentlyHandledMentions = new Set();

export async function POST({ request }) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  if (!verifySlackSignature(rawBody, headers)) {
    return new Response('Invalid Slack signature', { status: 401 });
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    payload = {};
  }

  if (payload.type === 'url_verification') {
    return json({ challenge: payload.challenge });
  }

  if (payload.type === 'event_callback') {
    const event = payload.event || {};
    const event_type = event.type;
    console.log('Slack event callback received', { event_type, event_id: payload.event_id || null });

    if (event_type === 'app_mention') {
      const dedupeKey = payload.event_id || `${event.channel || ''}:${event.ts || ''}`;
      if (recentlyHandledMentions.has(dedupeKey)) return json({ ok: true, duplicate: true });
      recentlyHandledMentions.add(dedupeKey);
      setTimeout(() => recentlyHandledMentions.delete(dedupeKey), 5 * 60 * 1000);
      try {
        const result = await handleHubAppMention(event);
        return json({ ok: true, handled: result.ok });
      } catch (error) {
        console.error('Failed to answer Slack app mention', error?.data?.error || error?.message || error);
        return json({ ok: true, handled: false });
      }
    }

    if (event_type === 'reaction_added') {
      const reaction = event.reaction;
      const item = event.item || {};
      const channel = item.channel;
      const ts = item.ts;
      // The user who reacted is available on the event as `user`
      const reactingUser = event.user || null;

      try {
        const plannerResult = await handlePlannerReaction({
          channel,
          ts,
          reaction,
          reactingUser
        });
        if (plannerResult?.handled) {
          return json({ ok: true });
        }

        const p0BugAssignmentResult = await handleP0BugAssignmentReaction({
          channel,
          ts,
          reaction,
          reactingUser
        });
        if (p0BugAssignmentResult?.handled) {
          return json({ ok: true });
        }

        const approverChannel = await ensureApproverDmChannel();
        console.log('Approver channel (cached):', approverChannel, 'event channel:', channel);

  if (channel && channel === approverChannel && ts) {
          // First check in-memory map (temporary workaround)
            try {
              const mapKey = `${channel}:${ts}`;
              let mapped = messageToPurchaseMap.get(mapKey);
              if (!mapped) {
                // Try to find a durable mapping in Supabase for purchasing or builds
                try {
                  const supa = getSupabase();
                  // Check purchasing first
                  const { data: pRows, error: pErr } = await supa
                    .from('purchasing')
                    .select('id')
                    .eq('slack_channel', channel)
                    .eq('slack_ts', ts)
                    .limit(1);
                  if (!pErr && Array.isArray(pRows) && pRows.length) {
                    mapped = pRows[0].id;
                    console.log('Found purchasing mapping in DB for', channel, ts, '->', mapped);
                  }
                } catch (dbErr) {
                  console.warn('DB lookup for slack mapping failed:', dbErr);
                }
              }

              // Resolve a friendly approver name from the reacting user's Slack profile when possible
              let approverName = 'Slack Approver';
              try {
                if (reactingUser) {
                  const client = getSlackClient();
                  const info = await client.users.info({ user: reactingUser });
                  if (info && info.ok && info.user) {
                    approverName = info.user.profile?.display_name || info.user.profile?.real_name || info.user.name || approverName;
                  }
                }
              } catch (e) {
                console.warn('Failed to lookup reacting user info:', e?.data || e?.message || e);
              }

              if (mapped) {
                // mapped is a purchasing id (number)
                const purchaseId = Number(mapped);
                if (reaction !== 'x') {
                  if (recentlyApprovedPurchases.has(purchaseId)) {
                    console.log('Purchase already approved recently, skipping duplicate approve for', purchaseId);
                  } else {
                    console.log('Approving purchase from mapping', purchaseId, 'based on reaction', reaction, 'by', approverName);
                    const ok = await approvePurchaseInDb(purchaseId, approverName);
                    if (ok) {
                      recentlyApprovedPurchases.add(purchaseId);
                      setTimeout(() => recentlyApprovedPurchases.delete(purchaseId), 30 * 1000);
                    }
                  }
                }
              } else {
                // No durable DB mapping found. Conversation history requires additional Slack scopes
                // (channels:history, groups:history, mpim:history, im:history). Avoid calling conversations.history
                // to prevent missing_scope errors. Instead, log and skip.
                console.warn('No DB mapping for slack message', channel, ts, 'and cannot fetch conversation history due to scope limitations. Skipping reaction processing.');
              }
            } catch (e) {
              console.error('Failed to fetch message for reaction processing:', e);
            }
        }
      } catch (e) {
        console.error('Failed to process reaction:', e);
      }
    }

    return json({ ok: true });
  }

  return json({ ok: true });
}
