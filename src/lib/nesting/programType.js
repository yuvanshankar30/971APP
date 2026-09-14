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

export function assertProgramTypeCompatible(sheetType, programType) {
  if (sheetType && programType && sheetType !== programType) {
    throw new Error(`This sheet uses .${sheetType} programs and cannot add .${programType} programs.`);
  }
}
