// Removes only the old manufacturing-request stale reminders from Slack.
//
// First inspect the exact affected messages:
//   node --env-file=.env scripts/delete-stale-manufacturing-slack-messages.mjs
//
// Then delete them when the environment has both the service-role database
// key and Slack bot token (normally the deployed service's secret context):
//   node --env-file=.env scripts/delete-stale-manufacturing-slack-messages.mjs --delete
//
// The Slack API needs both a channel and timestamp to delete a message. Those
// are available only for deliveries recorded after Slack activity logging was
// introduced; entries without either value are reported and never guessed at.
import { createClient } from '@supabase/supabase-js';
import { WebClient } from '@slack/web-api';

const STALE_KEY = 'manufacturing_request_stale';
const isDeleteRun = process.argv.includes('--delete');
const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const slackToken = process.env.SLACK_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;

if (!supabaseUrl || !serviceKey) {
  console.error('SUPABASE_URL/PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}
if (isDeleteRun && !slackToken) {
  console.error('A Slack bot token is required for --delete. Run the dry run first or use the deployed secret context.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);
const { data: activity, error } = await supabase
  .from('activity_log')
  .select('id, created_at, new_data')
  .eq('table_name', 'slack_messages')
  .limit(5000);
if (error) {
  console.error(`Could not load Slack activity: ${error.message}`);
  process.exit(1);
}

const staleMessages = (activity || []).filter((entry) => entry?.new_data?.notification_key === STALE_KEY);
console.log(`${staleMessages.length} stale manufacturing reminder message(s) found.`);
for (const entry of staleMessages) {
  const data = entry.new_data || {};
  console.log(`- ${entry.id}: ${data.recipient || 'unknown recipient'} (${data.channel || 'no channel'} / ${data.slack_ts || 'no timestamp'})`);
}

if (!isDeleteRun || !staleMessages.length) process.exit(0);

const slack = new WebClient(slackToken);
let deleted = 0;
let skipped = 0;
let failed = 0;
for (const entry of staleMessages) {
  const { channel, slack_ts: ts } = entry.new_data || {};
  if (!channel || !ts) {
    skipped += 1;
    console.warn(`Skipping ${entry.id}: no channel/timestamp was recorded.`);
    continue;
  }
  try {
    await slack.chat.delete({ channel, ts });
    const { error: deleteLogError } = await supabase.from('activity_log').delete().eq('id', entry.id);
    if (deleteLogError) throw new Error(`Slack deleted, but activity cleanup failed: ${deleteLogError.message}`);
    deleted += 1;
  } catch (cause) {
    failed += 1;
    console.error(`Could not delete ${entry.id}: ${cause?.data?.error || cause?.message || cause}`);
  }
}

console.log(`Deleted ${deleted}; skipped ${skipped}; failed ${failed}.`);
process.exit(failed ? 1 : 0);
