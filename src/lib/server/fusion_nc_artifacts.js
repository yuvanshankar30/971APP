import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const MAX_FILE_COUNT = 32;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function validRelativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.startsWith('/')) return false;
  const segments = name.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && !/[\0-\x1f\x7f]/.test(segment));
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Fusion NC file content must be canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Fusion NC file content is not valid base64');
  return bytes;
}

/** Validate unmodified Fusion-posted files and compute trustworthy server metadata. */
export function validateFusionNcFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILE_COUNT) {
    throw new Error(`Fusion CAM completion requires 1-${MAX_FILE_COUNT} NC files`);
  }
  const names = new Set();
  let totalBytes = 0;
  return files.map((file) => {
    if (!validRelativeName(file?.name) || names.has(file.name)) throw new Error('Fusion NC filenames must be unique safe relative paths');
    names.add(file.name);
    const bytes = decodeCanonicalBase64(file.contentBase64);
    // A zero-byte "G-code" file is a silent failure, not a real result - the
    // Runner's own post-export guards (camPlate.py/camTube.py/camTurning.py)
    // only check that *some* files were produced, not that each one actually
    // has content, so an empty file Fusion's post-processor touched but never
    // wrote to could otherwise reach a "completed" job. A job in that state
    // shows "No G-code files were posted for this job" in the UI even though
    // fusion_nc_files isn't empty, and if it were ever installed and opened
    // in JProg (the shop's sheet-nesting tool), JProg's parser has nothing to
    // read at all. Reject it here instead, at the one place every Runner
    // completion funnels through, so this can never reach a completed job.
    if (bytes.length === 0) throw new Error(`Fusion NC file "${file.name}" has no G-code content`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Fusion NC output exceeds the 20 MiB job limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (file.sha256 != null && file.sha256 !== sha256) throw new Error(`Fusion NC checksum mismatch for ${file.name}`);
    if (file.size != null && file.size !== bytes.length) throw new Error(`Fusion NC size mismatch for ${file.name}`);
    return { name: file.name, contentBase64: file.contentBase64, size: bytes.length, sha256 };
  });
}
