import { createClient } from '@supabase/supabase-js';
import { WebClient } from '@slack/web-api';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { canApprovePurchases } from '$lib/permissions.js';
import { recordSlackActivity } from '$lib/server/slack_activity.js';

// Lazy initialization to avoid throwing at module import time (build-time).
let _supabaseClient = null;
let _slackClient = null;

const APPROVER_GROUP_NAME = env.APPROVER_DM_NAME || 'purchase-approvals';
const FALLBACK_APPROVER_EMAILS = (env.FALLBACK_APPROVER_EMAILS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function getSlackTokenFromEnv() {
  return env.SLACK_BOT_TOKEN || env.BOT_TOKEN || env.TOKEN || null;
}

export function getSlackClient() {
  if (_slackClient) return _slackClient;
  const token = getSlackTokenFromEnv();
  if (!token) {
    throw new Error('Missing SLACK_BOT_TOKEN/BOT_TOKEN in environment');
  }
  _slackClient = new WebClient(token);
  return _slackClient;
}

export function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const SUPABASE_URL = env.SUPABASE_URL || publicEnv.PUBLIC_SUPABASE_URL;
  // The bot MUST use service_role key to bypass RLS and query all user_profiles for approvers
  const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL) {
    throw new Error('Missing SUPABASE_URL in environment');
  }
  if (!SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_KEY in environment. The bot requires service_role access to query user_profiles for approvers.');
  }
  _supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return _supabaseClient;
}

// Cached state
export let approverSlackUserIds = [];
export let approverDmChannelId = null;
export let lastApproverSync = 0;
export const APPROVER_SYNC_TTL = 60; // seconds

// Temporary in-memory map from `${channel}:${ts}` -> purchaseId to avoid needing
// conversation history scopes in development. Not reliable in serverless/prod.
export const messageToPurchaseMap = new Map();
// Short-lived dedupe cache to avoid posting the same purchase repeatedly.
// Keyed by a string like `${requester}:${itemName}:${projectId}` -> {ts, channel, expires}
export const recentPostDedupe = new Map();
const DEDUPE_TTL_MS = 10 * 1000; // 10 seconds

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toPositiveNumber(value) {
  const num = toNumber(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatPriceLine(perUnitPrice, quantity = 1) {
  const price = toNumber(perUnitPrice);
  if (!Number.isFinite(price)) return null;
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const total = price * qty;
  if (!Number.isFinite(total)) return null;
  const totalFmt = USD_FORMATTER.format(total);
  if (qty === 1) return totalFmt;
  const unitFmt = USD_FORMATTER.format(price);
  return `${totalFmt} (${qty} @ ${unitFmt})`;
}

export async function listApproversFromDb() {
  const supa = getSupabase();
  try {
    console.log('Querying user_profiles for approvers...');
    const { data, error } = await supa.from('user_profiles').select('id, email, full_name, role, permissions, purchasing_role, team_role, frc_team');

    if (error) {
      console.error('Supabase query error:', error);
      throw error;
    }

    const users = data || [];
    console.log(`Found ${users.length} total users in user_profiles`);

    // Same rule as everywhere else purchase approval is gated: admins,
    // mentors, and anyone holding APPROVE_PURCHASES (purchasing
    // approver/lead roles or the Purchasing Lead team role). Previously this
    // re-implemented only the permissions-array/purchasing_role half of that
    // rule, so admins with a sparse permissions array (or Purchasing Leads,
    // or mentors) silently never got a Slack DM for pending approvals.
    const approvers = users.filter((u) => canApprovePurchases(u));
    console.log(`Found ${approvers.length} approvers:`, approvers.map(a => a.email));

    return approvers;
  } catch (e) {
    console.error('Error fetching approvers from Supabase:', e);
    console.error('This may be an RLS policy issue. Ensure SUPABASE_SERVICE_KEY is set correctly.');
    return [];
  }
}

export async function slackUserIdForEmail(email) {
  if (!email) return null;
  try {
    const client = getSlackClient();
    const resp = await client.users.lookupByEmail({ email });
    if (resp.ok) return resp.user?.id || null;
  } catch (e) {
    console.error(`Slack lookup failed for ${email}:`, e?.data || e?.message || e);
  }
  return null;
}

export async function syncApprovers(force = false) {
  if (!force && Date.now() / 1000 - lastApproverSync < APPROVER_SYNC_TTL && approverSlackUserIds.length && approverDmChannelId) return;

  console.log('Syncing approvers from database...');
  const approvers = await listApproversFromDb();
  let emails = approvers.map((a) => a.email).filter(Boolean);

  if (!emails.length && FALLBACK_APPROVER_EMAILS.length) {
    console.log('No approvers found in DB, using fallback emails:', FALLBACK_APPROVER_EMAILS);
    emails = FALLBACK_APPROVER_EMAILS;
  }

  if (!emails.length) {
    console.warn('No approver emails configured. Set FALLBACK_APPROVER_EMAILS or add users with APPROVE_PURCHASES permission.');
    return;
  }

  const userIds = [];
  for (const email of emails) {
    const uid = await slackUserIdForEmail(email);
    if (uid) {
      console.log(`Found Slack user ID for ${email}: ${uid}`);
      userIds.push(uid);
    } else {
      console.warn(`Could not find Slack user ID for ${email}`);
    }
  }

  approverSlackUserIds = Array.from(new Set(userIds)).sort();
  lastApproverSync = Date.now() / 1000;

  if (!approverSlackUserIds.length) {
    console.warn('No Slack user IDs found for approvers. Check that approver emails match Slack workspace users.');
    return;
  }

  console.log(`Found ${approverSlackUserIds.length} approver(s):`, approverSlackUserIds);

  try {
    const client = getSlackClient();

    // For a single approver, open a DM. For multiple, open a multi-party DM (MPIM).
    if (approverSlackUserIds.length === 1) {
      console.log('Opening 1-on-1 DM with single approver...');
      const conv = await client.conversations.open({ users: approverSlackUserIds[0] });
      if (conv.ok && conv.channel) {
        approverDmChannelId = conv.channel.id;
        console.log('Approver DM channel opened:', approverDmChannelId);
      } else {
        console.error('Failed to open 1-on-1 DM:', conv);
      }
    } else {
      // For multiple users, we need to open an MPIM (multi-party instant message).
      // The conversations.open API with multiple users creates an MPIM.
      console.log('Opening MPIM with multiple approvers...');
      const conv = await client.conversations.open({
        users: approverSlackUserIds.join(','),
        return_im: false // Ensure we get a proper MPIM
      });
      if (conv.ok && conv.channel) {
        approverDmChannelId = conv.channel.id;
        console.log('Approver MPIM channel opened:', approverDmChannelId, 'Type:', conv.channel.is_mpim ? 'MPIM' : conv.channel.is_im ? 'IM' : 'other');
      } else {
        console.error('Failed to open MPIM:', conv);
      }
    }
  } catch (e) {
    console.error('Failed to open approver DM/MPIM:', e?.data || e?.message || e);
    approverDmChannelId = null;
  }
}

export async function ensureApproverDmChannel() {
  if (!approverDmChannelId) {
    console.log('No approver DM channel cached, syncing approvers...');
    await syncApprovers(true);
  }

  if (!approverDmChannelId) {
    console.error('Failed to establish approver DM channel after sync');
  }

  return approverDmChannelId;
}

export async function postPurchaseRequestMessage(requester, itemName, projectId, purchaseId = null) {
  const channel = await ensureApproverDmChannel();
  if (!channel) {
    console.warn('No approver DM channel available; skipping Slack post');
    return false;
  }
  // Deduplicate very recent identical posts to avoid spamming approvers if callers retry.
  const dedupeKey = `${requester}:${itemName}:${projectId}`;
  const now = Date.now();
  const existing = recentPostDedupe.get(dedupeKey);
  if (existing && existing.expires > now) {
    // Return the original post response-like object so callers see a consistent result.
    console.log('Skipping duplicate purchase post (dedupe)', dedupeKey);
    return { ok: true, ts: existing.ts, channel: existing.channel, deduped: true };
  }

  // Do not include purchase id in message text (avoid leaking IDs in chat)
  // Mapping from message ts -> purchaseId is still stored in-memory and persisted below when purchaseId provided.
  let text = `${requester} needs ${itemName} for ${projectId}`;
  if (purchaseId) {
    try {
      const supa = getSupabase();
      const { data: purchaseRow } = await supa
        .from('purchasing')
        .select('price, quantity, url')
        .eq('id', purchaseId)
        .single();
      if (purchaseRow) {
        const formattedPrice = formatPriceLine(purchaseRow.price, purchaseRow.quantity || 1);
        const normalizedUrl = normalizeUrl(purchaseRow.url);
        const purchaseLinkBase =
          env.PUBLIC_APP_ORIGIN ||
          env.APP_ORIGIN ||
          env.SITE_URL ||
          env.PUBLIC_SITE_URL ||
          publicEnv.PUBLIC_APP_ORIGIN ||
          publicEnv.PUBLIC_SITE_URL ||
          'https://971app.vercel.app';
        const purchaseLink = `${purchaseLinkBase.replace(/\/$/, '')}/cad/purchasing?purchase=${purchaseId}`;

        const blocks = [];
        blocks.push(`${requester} needs *${itemName}* for *${projectId}*`);
        if (formattedPrice) {
          blocks.push(`Cost: ${formattedPrice}`);
        }
        blocks.push(`<${purchaseLink}|Review & Approve>`);
        if (normalizedUrl) {
          blocks.push(`<${normalizedUrl}|Vendor Link>`);
        }
        text = blocks.join('\n');
      }
    } catch (err) {
      console.warn('Failed to enrich Slack purchase message:', err?.message || err);
    }
  }
  try {
    const client = getSlackClient();
    console.log('Posting purchase message to channel:', channel);
    const resp = await client.chat.postMessage({ channel, text });

    if (!resp.ok) {
      console.error('Slack API returned ok=false:', resp);
      return false;
    }

    // Log message and response for debugging
    console.log('Posted purchase message to Slack successfully', {
      channel,
      ts: resp?.ts,
      purchaseId,
      textPreview: text.substring(0, 100)
    });
    await recordSlackActivity(getSupabase(), {
      text,
      channel: resp.channel || channel,
      ts: resp.ts || null,
      category: 'Purchase approval request'
    });

    // If we posted successfully and have a purchaseId, record the mapping in memory
    if (resp && resp.ok && resp.ts && purchaseId) {
      try {
        messageToPurchaseMap.set(`${channel}:${resp.ts}`, Number(purchaseId));
        // Persist the slack channel/ts to the purchasing row so the reaction handler can find it.
        try {
          const supa = getSupabase();
          await supa.from('purchasing').update({ slack_channel: resp.channel, slack_ts: resp.ts }).eq('id', purchaseId);
        } catch (dbErr) {
          // Non-fatal; we still keep the in-memory map as a fallback
          console.warn('Failed to persist slack channel/ts to purchasing row:', dbErr);
        }
      } catch (e) {
        console.warn('Failed to store message->purchase mapping:', e);
      }
    }
    // Record the dedupe entry for a short period to avoid repeat postings
    try {
      recentPostDedupe.set(dedupeKey, { ts: resp?.ts, channel: resp?.channel, expires: Date.now() + DEDUPE_TTL_MS });
      // Schedule removal
      setTimeout(() => recentPostDedupe.delete(dedupeKey), DEDUPE_TTL_MS + 1000);
    } catch (e) {
      // ignore
    }
    // Return the full response so callers can persist ts/channel if desired
    return resp;
  } catch (e) {
    console.error('Slack error posting purchase request:', e?.data || e?.message || e);
    return false;
  }
}

export async function postBuildApprovalRequest(build, requesterName = 'Unknown') {
  // build: { id, release_name, subsystem_id, project_id }
  const channel = await ensureApproverDmChannel();
  if (!channel) {
    console.warn('No approver DM channel; skipping build approval post');
    return false;
  }
  const title = build?.release_name || build?.build_hash || 'Build';
  const proj = build?.project_id || build?.release_name || '';
  const buildId = build?.id;
  const text = `${requesterName} requests approval for build ${title} (${proj}) build_id:${buildId}`;
  try {
    const client = getSlackClient();
    const resp = await client.chat.postMessage({ channel, text });
    if (resp?.ok) {
      await recordSlackActivity(getSupabase(), {
        text,
        channel: resp.channel || channel,
        ts: resp.ts || null,
        category: 'Build approval request'
      });
    }
    if (resp && resp.ok && resp.ts && buildId) {
      try {
        const supa = getSupabase();
        await supa.from('builds').update({ slack_channel: resp.channel, slack_ts: resp.ts }).eq('id', buildId);
      } catch (e) {
        console.warn('Failed to persist slack mapping for build approval:', e);
      }
    }
    return resp;
  } catch (e) {
    console.error('Slack error posting build approval request:', e?.data || e?.message || e);
    return false;
  }
}

export async function approvePurchaseInDb(purchaseId, approverName = 'Slack Approver') {
  try {
    const supa = getSupabase();
    await supa.from('purchasing').update({ approved: true, approver: approverName, status: 'approved' }).eq('id', purchaseId);
    try {
      const { notifyPurchaseApprovedById } = await import('$lib/server/slack_notifications.js');
      await notifyPurchaseApprovedById(purchaseId);
    } catch (notifyErr) {
      console.warn('Failed to send purchase approval DM', notifyErr?.message || notifyErr);
    }
    return true;
  } catch (e) {
    console.error('Error approving purchase in DB:', e);
    return false;
  }
}

export async function addPermissionCanSeeRoutes(userId) {
  try {
    const supa = getSupabase();
    const { data } = await supa.from('user_profiles').select('permissions').eq('id', userId).single();
    if (!data) return false;
    const perms = data.permissions || [];
    if (!perms.includes('CAN_SEE_ROUTES')) perms.push('CAN_SEE_ROUTES');
    await supa.from('user_profiles').update({ permissions: perms, role: 'member', banned: false }).eq('id', userId);
    return true;
  } catch (e) {
    console.error('Error adding CAN_SEE_ROUTES permission:', e);
    return false;
  }
}

export async function postUserApprovalNeeded(name) {
  const channel = await ensureApproverDmChannel();
  if (!channel) {
    console.warn('No approver DM channel available for user approval message');
    return false;
  }
  const text = `New user *${name}* needs approval to access the system`;
  try {
    const client = getSlackClient();
    console.log('Posting user approval message to channel:', channel);
    const resp = await client.chat.postMessage({ channel, text });
    if (resp.ok) {
      console.log('User approval message posted successfully');
      await recordSlackActivity(getSupabase(), {
        text,
        channel: resp.channel || channel,
        ts: resp.ts || null,
        category: 'User approval request'
      });
    } else {
      console.error('Failed to post user approval message:', resp);
    }
    return resp.ok;
  } catch (e) {
    console.error('Slack error posting user approval request:', e?.data || e?.message || e);
    return false;
  }
}

// Basic signature verification for Slack requests (raw body needed by SvelteKit handler)
import crypto from 'crypto';
// secretOverride exists for testability (mirrors cron_auth.js's isAuthorizedCronRequest
// taking env as a parameter) - SvelteKit's $env/dynamic/private doesn't reliably pick up
// vi.stubEnv in a unit test, but it's never passed by the one real call site.
export function verifySlackSignature(rawBody, headers, secretOverride) {
  const SLACK_SIGNING_SECRET = secretOverride ?? env.SLACK_SIGNING_SECRET ?? '';
  if (!SLACK_SIGNING_SECRET) return true;
  const timestamp = headers['x-slack-request-timestamp'];
  if (!timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBasestring).digest('hex');
  const slackSig = headers['x-slack-signature'] || '';
  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  } catch (e) {
    return false;
  }
}
