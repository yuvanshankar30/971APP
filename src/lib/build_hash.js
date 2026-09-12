// Computes a short, deterministic hash from a build's identifying parts
// (subsystem id, OnShape document id, version id, ...) for builds.build_hash,
// a varchar(64) dedup key. Concatenating the raw parts directly overflowed
// that column - a subsystem UUID (36 chars) plus an OnShape document id and
// version id (~24 chars each) is well past 64 once joined - so this reduces
// them to a fixed 16-character hex digest instead. Not cryptographic: this
// only needs to be a stable, low-collision key for "same combo of parts
// produces the same build row," not a security boundary.
export function computeBuildHash(...parts) {
  const input = parts.filter((p) => p !== undefined && p !== null).join('_');

  let hash1 = 5381;
  let hash2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash1 = (hash1 * 33 + code) | 0;
    hash2 = (hash2 * 33 - code) | 0;
  }

  const hex1 = (hash1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (hash2 >>> 0).toString(16).padStart(8, '0');
  return `${hex1}${hex2}`;
}
