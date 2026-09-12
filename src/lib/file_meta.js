// Shared helpers for the {step_file, step_valid}/{pdf_file} JSON convention
// stored in a build_bom row's or a parts row's file_url column (see
// manufacture/+page.svelte's getFileMeta for the original). Centralized here
// so cad/[id] and cad/build/[id] (and manufacture) all agree on what counts
// as "this row has a STEP/PDF attached."
export function getFileMeta(item) {
  try { return JSON.parse(item?.file_url || '{}') || {}; } catch { return {}; }
}

export function getStepFileName(item) {
  const meta = getFileMeta(item);
  if (meta.step_file) return meta.step_file;
  if (item?.file_name && /\.(step|stp)$/i.test(item.file_name)) return item.file_name;
  return null;
}

export function canViewCad(item) {
  return !!getStepFileName(item);
}

export function getPdfFileName(item) {
  const meta = getFileMeta(item);
  if (meta.pdf_file) return meta.pdf_file;
  if (item?.file_name && /\.pdf$/i.test(item.file_name)) return item.file_name;
  return null;
}

export function canViewPdf(item) {
  return !!getPdfFileName(item);
}

// Direct instruction: promoting a BOM row to a manufacturing request
// requires the right file to already be attached, per workflow -
//   router:    STEP required
//   lathe:     PDF required (STEP optional)
//   3d-print:  STEP required
//   mill / laser-cut / anything else: no file required
// Returns an error message string to show the user and block the add, or
// null when the row's attachments already satisfy its workflow.
export function fileRequirementError(item) {
  const workflow = item?.workflow;
  if (workflow === 'router' && !canViewCad(item)) {
    return 'Attach a STEP file before adding this router part to manufacturing.';
  }
  if (workflow === 'lathe' && !canViewPdf(item)) {
    return 'Attach a PDF drawing before adding this lathe part to manufacturing (STEP is optional).';
  }
  if (workflow === '3d-print' && !canViewCad(item)) {
    return 'Attach a STEP file before adding this 3D-print part to manufacturing.';
  }
  return null;
}
