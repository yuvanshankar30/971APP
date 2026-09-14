export function buildEmitFilename(baseName, suffix = '', suffixCount = 1, extension = 'ngc') {
  const safeBase = String(baseName || 'nest').trim().replace(/[^a-z0-9._-]+/gi, '_') || 'nest';
  const cleanSuffix = String(suffix || '').trim().replace(/[^a-z0-9._-]+/gi, '_');
  return `${safeBase}${suffixCount > 1 && cleanSuffix ? `_${cleanSuffix}` : ''}.${String(extension).replace(/^\./, '')}`;
}
