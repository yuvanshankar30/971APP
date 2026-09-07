export const ROUTER_STAGES = [
  'pending',
  'cam_ing',
  'cam_review',
  'cammed',
  'queued',
  'cut',
  'jigsawed',
  'countersinking',
  'deburred',
  'inspecting',
  'kitted'
];

export const ROUTER_STAGE_LABELS = {
  pending: 'Pending',
  cam_ing: 'CAMing',
  cam_review: 'CAM Review',
  cammed: 'CAM Reviewed',
  queued: 'Jprogged',
  cut: 'Cut',
  jigsawed: 'Jigsawed',
  countersinking: 'Countersunk',
  deburred: 'Deburred',
  inspecting: 'Inspecting',
  kitted: 'Kitted'
};

export const ROUTER_PRE_CUT_STAGES = ['pending', 'cam_ing', 'cam_review', 'cammed', 'queued', 'cut'];
export const ROUTER_POST_PROCESSING_STAGES = ['cut', 'jigsawed', 'countersinking', 'deburred', 'inspecting', 'kitted'];

export function canAdvanceRouterToCamReview(part, fusionJob) {
  return part?.workflow === 'router'
    && fusionJob?.status === 'completed'
    && Array.isArray(fusionJob.fusion_nc_files)
    && fusionJob.fusion_nc_files.length > 0;
}

export function normalizePositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMeta(part) {
  try {
    return JSON.parse(part?.file_url || '{}') || {};
  } catch {
    return {};
  }
}

export function getPartQuantity(part) {
  return normalizePositiveInt(part?.quantity, 1);
}

export function inferLegacyRouterStage(part) {
  const meta = parseMeta(part);
  const step = meta?.router_meta?.step;

  if (part?.status === 'complete' || part?.status === 'kitted') return 'kitted';
  if (step === 'cut' || part?.status === 'machined') return 'cut';
  if (step === 'queued' || meta?.travis_progged) return 'queued';
  if (step === 'cammed' || part?.status === 'cammed') return 'cammed';
  if (step === 'cam_review') return 'cam_review';
  if (step === 'cam_ing' || part?.status === 'in-progress') return 'cam_ing';
  return 'pending';
}

export function getRouterStageCounts(part) {
  const quantity = getPartQuantity(part);
  const meta = parseMeta(part);
  const rawCounts = meta?.router_meta?.stage_counts;

  if (!rawCounts || typeof rawCounts !== 'object') {
    return { [inferLegacyRouterStage(part)]: quantity };
  }

  const counts = {};
  let total = 0;
  for (const stage of ROUTER_STAGES) {
    const count = Math.max(0, Number.parseInt(rawCounts[stage], 10) || 0);
    if (count > 0) {
      counts[stage] = count;
      total += count;
    }
  }

  if (total !== quantity) {
    return { [inferLegacyRouterStage(part)]: quantity };
  }

  return counts;
}

export function getStageCount(part, stage) {
  return getRouterStageCounts(part)[stage] || 0;
}

export function hasStageCount(part, stage) {
  return getStageCount(part, stage) > 0;
}

export function isFullyCut(part) {
  const counts = getRouterStageCounts(part);
  return ROUTER_STAGES
    .slice(0, ROUTER_STAGES.indexOf('cut'))
    .every((stage) => (counts[stage] || 0) === 0);
}

export function isFullyKitted(part) {
  return getStageCount(part, 'kitted') >= getPartQuantity(part);
}

export function summarizeRouterStages(part) {
  const counts = getRouterStageCounts(part);
  return ROUTER_STAGES
    .map((stage) => ({ stage, count: counts[stage] || 0 }))
    .filter(({ count }) => count > 0)
    .map(({ stage, count }) => `${count} ${ROUTER_STAGE_LABELS[stage]}`)
    .join(', ');
}

export function getLegacyStatusForStageCounts(counts) {
  if ((counts.kitted || 0) > 0 && Object.keys(counts).length === 1) return 'complete';
  if ((counts.cut || 0) > 0 || (counts.jigsawed || 0) > 0 || (counts.countersinking || 0) > 0 || (counts.deburred || 0) > 0 || (counts.inspecting || 0) > 0 || (counts.kitted || 0) > 0) {
    return 'machined';
  }
  if ((counts.queued || 0) > 0 || (counts.cammed || 0) > 0) {
    return 'cammed';
  }
  if ((counts.cam_review || 0) > 0 || (counts.cam_ing || 0) > 0) {
    return 'in-progress';
  }
  return 'pending';
}

export function getLegacyStepForStageCounts(counts) {
  if ((counts.kitted || 0) > 0) return 'kitted';
  if ((counts.inspecting || 0) > 0) return 'inspecting';
  if ((counts.deburred || 0) > 0) return 'deburred';
  if ((counts.countersinking || 0) > 0) return 'countersinking';
  if ((counts.jigsawed || 0) > 0) return 'jigsawed';
  if ((counts.cut || 0) > 0) return 'cut';
  if ((counts.queued || 0) > 0) return 'queued';
  if ((counts.cammed || 0) > 0) return 'cammed';
  if ((counts.cam_review || 0) > 0) return 'cam_review';
  if ((counts.cam_ing || 0) > 0) return 'cam_ing';
  return 'pending';
}

export function advanceRouterStageCounts(part, fromStage, toStage, amount = 1) {
  const counts = { ...getRouterStageCounts(part) };
  const moveAmount = Math.min(Math.max(0, amount), counts[fromStage] || 0);
  if (!moveAmount) return null;

  counts[fromStage] -= moveAmount;
  if (counts[fromStage] <= 0) delete counts[fromStage];
  counts[toStage] = (counts[toStage] || 0) + moveAmount;

  return counts;
}

export function buildRouterProgressUpdate(part, counts) {
  const meta = parseMeta(part);
  const routerMeta = { ...(meta.router_meta || {}) };
  routerMeta.stage_counts = counts;
  routerMeta.step = getLegacyStepForStageCounts(counts);
  if (routerMeta.step !== 'queued') delete routerMeta.travis_progged;
  if (routerMeta.step === 'queued') routerMeta.travis_progged = true;

  return {
    status: getLegacyStatusForStageCounts(counts),
    file_url: JSON.stringify({ ...meta, router_meta: routerMeta }),
    updated_at: new Date().toISOString()
  };
}
