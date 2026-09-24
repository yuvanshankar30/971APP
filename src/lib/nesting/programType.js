const PROGRAM_TYPE = /\.(ngc|tap)$/i;

export function programTypeForName(name) {
  return String(name || '').match(PROGRAM_TYPE)?.[1]?.toLowerCase() || null;
}

export function singleProgramType(names) {
  const types = new Set((names || []).map(programTypeForName).filter(Boolean));
  if (types.size > 1) throw new Error('A sheet cannot mix .ngc and .tap programs.');
  return [...types][0] || null;
}

export function dialectForProgramType(type) {
  return type === 'tap' ? 'wincnc' : 'linuxcnc';
}

export function assertProgramTypeCompatible(cutType, programType) {
  if (cutType && programType && cutType !== programType) {
    throw new Error(`This cut uses .${cutType} programs and cannot add .${programType} programs.`);
  }
}

// A cut locks to whichever type its first part was (assertProgramTypeCompatible
// above). Once every part is removed there is nothing left to be locked to,
// so the lock should release and let the cut accept the other type next -
// otherwise an emptied cut stays stuck on its old type forever. Placements
// are the cut's current placements (parts and holes); holes never carry a
// file type and don't keep the lock held.
export function nextCutProgramType(currentType, placements) {
  if (currentType && !(placements || []).some((item) => item.kind === 'part')) return null;
  return currentType;
}
