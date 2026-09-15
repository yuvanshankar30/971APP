const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

export function jprogOutputDateFolder(date = new Date()) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${values.year}${values.month}${values.day}`;
}
