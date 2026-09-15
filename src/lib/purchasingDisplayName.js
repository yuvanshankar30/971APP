/**
 * Return the short display text for a purchasing row's requester/approver.
 *
 * purchasing.requester/approver are stored as a flattened
 * `full_name || email` string at write time (see cad/purchasing/+page.svelte),
 * so a bare email here means that user never set a full_name, not that
 * their name IS their email. Never manufacture a name from the email's
 * local part (same policy as scoutNames.js's scoutDisplayName) - showing
 * "Name not set" is honest; guessing "Mason J Qian" from
 * "mason.j.qian@gmail.com" is not.
 */
export function purchasingDisplayName(value) {
  const trimmed = (value || '').toString().trim();
  if (!trimmed) return 'Unknown';
  return trimmed.includes('@') ? 'Name not set' : trimmed.split(' ')[0];
}
