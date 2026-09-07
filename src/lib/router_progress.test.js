import { describe, it, expect } from 'vitest';
import {
  normalizePositiveInt,
  getPartQuantity,
  inferLegacyRouterStage,
  getRouterStageCounts,
  getStageCount,
  hasStageCount,
  isFullyCut,
  isFullyKitted,
  summarizeRouterStages,
  getLegacyStatusForStageCounts,
  getLegacyStepForStageCounts,
  advanceRouterStageCounts,
  buildRouterProgressUpdate,
  canAdvanceRouterToCamReview
} from './router_progress.js';

describe('canAdvanceRouterToCamReview', () => {
  it('requires a completed Fusion job for a router request', () => {
    const part = { workflow: 'router' };
    const output = [{ name: 'part.nc', contentBase64: 'RzIw' }];
    expect(canAdvanceRouterToCamReview(part, { status: 'completed', fusion_nc_files: output })).toBe(true);
    expect(canAdvanceRouterToCamReview(part, { status: 'completed', fusion_nc_files: [] })).toBe(false);
    expect(canAdvanceRouterToCamReview(part, { status: 'processing', fusion_nc_files: output })).toBe(false);
    expect(canAdvanceRouterToCamReview(part, null)).toBe(false);
  });

  it('does not treat a completed Fusion job as CAM for another workflow', () => {
    expect(canAdvanceRouterToCamReview(
      { workflow: 'lathe' },
      { status: 'completed', fusion_nc_files: [{ name: 'part.nc' }] }
    )).toBe(false);
  });
});

describe('normalizePositiveInt', () => {
  it('parses a valid positive integer', () => {
    expect(normalizePositiveInt('5')).toBe(5);
    expect(normalizePositiveInt(5)).toBe(5);
  });

  it('falls back to the default for zero, negative, or garbage input', () => {
    expect(normalizePositiveInt(0)).toBe(1);
    expect(normalizePositiveInt(-3)).toBe(1);
    expect(normalizePositiveInt('abc')).toBe(1);
    expect(normalizePositiveInt(undefined, 7)).toBe(7);
  });
});

describe('getPartQuantity', () => {
  it('defaults to 1 when no quantity is set', () => {
    expect(getPartQuantity({})).toBe(1);
  });

  it('reads a valid quantity off the part', () => {
    expect(getPartQuantity({ quantity: 4 })).toBe(4);
  });
});

describe('inferLegacyRouterStage (fallback for parts with no stage_counts)', () => {
  it('maps complete/kitted status to the kitted stage', () => {
    expect(inferLegacyRouterStage({ status: 'complete' })).toBe('kitted');
    expect(inferLegacyRouterStage({ status: 'kitted' })).toBe('kitted');
  });

  it('maps machined status to the cut stage', () => {
    expect(inferLegacyRouterStage({ status: 'machined' })).toBe('cut');
  });

  it('maps travis_progged meta to the queued stage', () => {
    const part = { status: 'in-progress', file_url: JSON.stringify({ travis_progged: true }) };
    expect(inferLegacyRouterStage(part)).toBe('queued');
  });

  it('maps cammed status to the cammed stage', () => {
    expect(inferLegacyRouterStage({ status: 'cammed' })).toBe('cammed');
  });

  it('defaults to pending for an unrecognized/empty part', () => {
    expect(inferLegacyRouterStage({})).toBe('pending');
  });

  it('tolerates unparseable file_url JSON', () => {
    expect(inferLegacyRouterStage({ status: 'pending', file_url: 'not json' })).toBe('pending');
  });
});

describe('getRouterStageCounts', () => {
  it('falls back to the legacy single-stage inference when there is no stage_counts meta', () => {
    const part = { status: 'kitted', quantity: 3 };
    expect(getRouterStageCounts(part)).toEqual({ kitted: 3 });
  });

  it('reads real per-stage counts when they sum to the part quantity', () => {
    const part = {
      quantity: 5,
      file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 2, kitted: 3 } } })
    };
    expect(getRouterStageCounts(part)).toEqual({ cut: 2, kitted: 3 });
  });

  it('falls back to legacy inference if stage_counts do not sum to the part quantity (stale/corrupt data)', () => {
    const part = {
      status: 'pending',
      quantity: 5,
      file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 2 } } }) // sums to 2, not 5
    };
    expect(getRouterStageCounts(part)).toEqual({ pending: 5 });
  });

  it('drops zero/negative counts from the result', () => {
    const part = {
      quantity: 2,
      file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 2, kitted: 0, jigsawed: -1 } } })
    };
    expect(getRouterStageCounts(part)).toEqual({ cut: 2 });
  });
});

describe('getStageCount / hasStageCount', () => {
  const part = {
    quantity: 4,
    file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 1, kitted: 3 } } })
  };

  it('returns the count for a given stage, or 0 if absent', () => {
    expect(getStageCount(part, 'cut')).toBe(1);
    expect(getStageCount(part, 'inspecting')).toBe(0);
  });

  it('reports whether a stage has any count', () => {
    expect(hasStageCount(part, 'kitted')).toBe(true);
    expect(hasStageCount(part, 'inspecting')).toBe(false);
  });
});

describe('isFullyCut', () => {
  it('is true once nothing remains in a pre-cut stage', () => {
    const part = { quantity: 3, file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 3 } } }) };
    expect(isFullyCut(part)).toBe(true);
  });

  it('is false while some quantity is still in a pre-cut stage', () => {
    const part = { quantity: 3, file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 1, cam_ing: 2 } } }) };
    expect(isFullyCut(part)).toBe(false);
  });
});

describe('isFullyKitted', () => {
  it('is true once the kitted count meets the part quantity', () => {
    const part = { quantity: 2, file_url: JSON.stringify({ router_meta: { stage_counts: { kitted: 2 } } }) };
    expect(isFullyKitted(part)).toBe(true);
  });

  it('is false while kitted count is under the part quantity', () => {
    const part = { quantity: 3, file_url: JSON.stringify({ router_meta: { stage_counts: { kitted: 1, cut: 2 } } }) };
    expect(isFullyKitted(part)).toBe(false);
  });
});

describe('summarizeRouterStages', () => {
  it('produces a human-readable, stage-ordered summary of non-zero counts', () => {
    const part = { quantity: 3, file_url: JSON.stringify({ router_meta: { stage_counts: { kitted: 1, cut: 2 } } }) };
    // ROUTER_STAGES order puts "cut" before "kitted"
    expect(summarizeRouterStages(part)).toBe('2 Cut, 1 Kitted');
  });
});

describe('getLegacyStatusForStageCounts', () => {
  it('maps a fully-kitted single-stage count to complete', () => {
    expect(getLegacyStatusForStageCounts({ kitted: 5 })).toBe('complete');
  });

  it('maps any post-cut progress to machined', () => {
    expect(getLegacyStatusForStageCounts({ cut: 1, kitted: 4 })).toBe('machined');
    expect(getLegacyStatusForStageCounts({ deburred: 5 })).toBe('machined');
  });

  it('maps queued/cammed to cammed', () => {
    expect(getLegacyStatusForStageCounts({ queued: 5 })).toBe('cammed');
    expect(getLegacyStatusForStageCounts({ cammed: 5 })).toBe('cammed');
  });

  it('maps cam_review/cam_ing to in-progress', () => {
    expect(getLegacyStatusForStageCounts({ cam_review: 5 })).toBe('in-progress');
    expect(getLegacyStatusForStageCounts({ cam_ing: 5 })).toBe('in-progress');
  });

  it('defaults to pending', () => {
    expect(getLegacyStatusForStageCounts({})).toBe('pending');
    expect(getLegacyStatusForStageCounts({ pending: 5 })).toBe('pending');
  });
});

describe('getLegacyStepForStageCounts', () => {
  it('reports the most-advanced stage present, in pipeline order', () => {
    expect(getLegacyStepForStageCounts({ cut: 2, cam_ing: 1 })).toBe('cut');
    expect(getLegacyStepForStageCounts({ kitted: 1, cut: 4 })).toBe('kitted');
    expect(getLegacyStepForStageCounts({})).toBe('pending');
  });
});

describe('advanceRouterStageCounts', () => {
  it('moves the requested amount from one stage to the next', () => {
    const part = { quantity: 5, file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 5 } } }) };
    const result = advanceRouterStageCounts(part, 'cut', 'jigsawed', 2);
    expect(result).toEqual({ cut: 3, jigsawed: 2 });
  });

  it('clamps the move amount to what is actually available in the source stage', () => {
    const part = { quantity: 3, file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 3 } } }) };
    const result = advanceRouterStageCounts(part, 'cut', 'jigsawed', 100);
    expect(result).toEqual({ jigsawed: 3 });
  });

  it('removes the source stage entirely once it hits zero', () => {
    const part = { quantity: 2, file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 2 } } }) };
    const result = advanceRouterStageCounts(part, 'cut', 'jigsawed', 2);
    expect(result.cut).toBeUndefined();
  });

  it('returns null when there is nothing in the source stage to move', () => {
    const part = { quantity: 2, file_url: JSON.stringify({ router_meta: { stage_counts: { kitted: 2 } } }) };
    expect(advanceRouterStageCounts(part, 'cut', 'jigsawed', 1)).toBeNull();
  });
});

describe('buildRouterProgressUpdate', () => {
  it('derives status and step from the new counts and stores them back into file_url', () => {
    const part = { file_url: JSON.stringify({ router_meta: { stage_counts: { cut: 5 } } }) };
    const update = buildRouterProgressUpdate(part, { jigsawed: 5 });
    expect(update.status).toBe('machined');
    const meta = JSON.parse(update.file_url);
    expect(meta.router_meta.step).toBe('jigsawed');
    expect(meta.router_meta.stage_counts).toEqual({ jigsawed: 5 });
  });

  it('sets travis_progged only while the step is queued, and clears it otherwise', () => {
    const part = { file_url: '{}' };
    const queuedUpdate = buildRouterProgressUpdate(part, { queued: 3 });
    expect(JSON.parse(queuedUpdate.file_url).router_meta.travis_progged).toBe(true);

    const cutUpdate = buildRouterProgressUpdate(part, { cut: 3 });
    expect(JSON.parse(cutUpdate.file_url).router_meta.travis_progged).toBeUndefined();
  });
});
