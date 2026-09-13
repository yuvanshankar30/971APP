// Never manufacture a person's name from an email local part.
export function scoutDisplayName(profile) {
  const name = String(profile?.full_name || '').trim();
  if (name && !name.includes('@')) return name;
  const email = String(profile?.email || '').trim();
  return email ? `Name not set (${email})` : 'Name not set';
}
