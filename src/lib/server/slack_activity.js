const ACTIVITY_TABLE = 'slack_messages';
const MAX_LOGGED_MESSAGE_LENGTH = 2_000;

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function buildSlackActivityEntry({
  text,
  channel = null,
  ts = null,
  recipient = null,
  category = 'Notification',
  notificationKey = null
} = {}) {
  const message = cleanText(text);
  if (!message) return null;

  return {
    table_name: ACTIVITY_TABLE,
    operation: 'INSERT',
    row_id: channel && ts ? `${channel}:${ts}` : null,
    actor: null,
    changed_columns: [],
    old_data: null,
    new_data: {
      name: category,
      message: message.slice(0, MAX_LOGGED_MESSAGE_LENGTH),
      channel,
      slack_ts: ts,
      recipient: cleanText(recipient) || null,
      notification_key: notificationKey
    }
  };
}

// Activity history must never make a successful Slack delivery look failed.
// Callers await this only so a newly sent message appears in the live feed
// immediately; insert failures are deliberately contained here.
export async function recordSlackActivity(supa, details) {
  const entry = buildSlackActivityEntry(details);
  if (!entry || !supa) return false;
  const { error } = await supa.from('activity_log').insert(entry);
  if (error) {
    console.warn('Failed to record Slack activity', error.message || error);
    return false;
  }
  return true;
}
