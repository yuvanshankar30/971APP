import { describe, it, expect } from 'vitest';
import { getWorkflowStatuses, getDisplayStatus, getBadgeClass, isAutocamEligible, ALL_STATUSES, DISPLAY_ORDER, WORKFLOW_STATUSES, routeStageIndex, normalizeRouteStatus } from './statuses.js';

describe('getWorkflowStatuses', () => {
  it('keeps router stages separate from the compact shop workflows', () => {
    expect(getWorkflowStatuses('router')).toBe(ALL_STATUSES);
    expect(getWorkflowStatuses('router')).toHaveLength(8);
    for (const workflow of ['lathe', 'mill', 'laser-cut', undefined]) {
      expect(getWorkflowStatuses(workflow).map((stage) => stage.value)).toEqual([
        'pending', 'in-progress', 'machined', 'complete'
      ]);
    }
    expect(getWorkflowStatuses('3d-print').map((stage) => stage.value)).toEqual([
      'pending', 'in-progress', 'printed', 'complete'
    ]);
  });
});

describe('router workflow ordering', () => {
  // Direct instruction: a part can't be postprocessed (deburred/cleaned up)
  // before it's actually been machined - Postprocessed must come after
  // Machined, not before it.
  it('places Postprocessed after Machined in the display order', () => {
    expect(DISPLAY_ORDER.indexOf('Postprocessed')).toBeGreaterThan(DISPLAY_ORDER.indexOf('Machined'));
  });

  it('places postprocessed after machined in the router workflow status list', () => {
    const values = WORKFLOW_STATUSES.router.map((option) => option.value);
    expect(values.indexOf('postprocessed')).toBeGreaterThan(values.indexOf('machined'));
  });
});

describe('getDisplayStatus', () => {
  it('maps each known DB status to its display label', () => {
    expect(getDisplayStatus('pending')).toBe('Pending');
    expect(getDisplayStatus('autocammed')).toBe('Autocammed');
    expect(getDisplayStatus('in-progress')).toBe('In Progress');
    expect(getDisplayStatus('cammed')).toBe('CAM Reviewed');
    expect(getDisplayStatus('postprocessed')).toBe('Postprocessed');
    expect(getDisplayStatus('jprogged')).toBe('Jprogged');
    expect(getDisplayStatus('printed')).toBe('Printed');
    expect(getDisplayStatus('machined')).toBe('Machined');
    expect(getDisplayStatus('inspected')).toBe('Machined');
    expect(getDisplayStatus('kitted')).toBe('Kitted');
    expect(getDisplayStatus('complete')).toBe('Kitted');
  });

  it('forces the CAM Review Pending label when router_meta.step is cam_review, regardless of status', () => {
    expect(getDisplayStatus('in-progress', { step: 'cam_review' })).toBe('CAM Review Pending');
    expect(getDisplayStatus('in-progress', { router_meta: { step: 'cam_review' } })).toBe('CAM Review Pending');
  });

  it('title-cases an unrecognized status as a fallback', () => {
    expect(getDisplayStatus('weird_status')).toBe('Weird_status');
  });

  it('returns an empty string for non-string status with no meta override', () => {
    expect(getDisplayStatus(null)).toBe('');
    expect(getDisplayStatus(undefined)).toBe('');
  });
});

describe('getBadgeClass', () => {
  it('maps each known status to a distinct badge class', () => {
    expect(getBadgeClass('pending')).toBe('status-pending');
    expect(getBadgeClass('in-progress')).toBe('status-progress');
    expect(getBadgeClass('cammed')).toBe('status-cammed');
    expect(getBadgeClass('machined')).toBe('status-machined');
    expect(getBadgeClass('kitted')).toBe('status-complete');
  });

  it('forces the cam-review class when router_meta.step is cam_review', () => {
    expect(getBadgeClass('in-progress', { step: 'cam_review' })).toBe('status-cam-review');
  });

  it('falls back to status-pending for an unrecognized status', () => {
    expect(getBadgeClass('totally_unknown')).toBe('status-pending');
  });
});

describe('isAutocamEligible', () => {
  const stockData = { router: [{ id: 'sheet-1', dimensions: 'Sheet' }, { id: 'bar-1', dimensions: 'Bar' }] };

  it('is eligible for a router part assigned to sheet stock', () => {
    const part = { workflow: 'router', stock_assignment: 'sheet-1' };
    expect(isAutocamEligible(part, stockData)).toBe(true);
  });

  it('is not eligible for a non-router workflow', () => {
    const part = { workflow: 'lathe', stock_assignment: 'sheet-1' };
    expect(isAutocamEligible(part, stockData)).toBe(false);
  });

  it('is not eligible when the assigned stock is not a sheet', () => {
    const part = { workflow: 'router', stock_assignment: 'bar-1' };
    expect(isAutocamEligible(part, stockData)).toBe(false);
  });

  it('is not eligible with no stock assignment', () => {
    const part = { workflow: 'router', stock_assignment: null };
    expect(isAutocamEligible(part, stockData)).toBe(false);
  });

  it('is not eligible for a null part', () => {
    expect(isAutocamEligible(null, stockData)).toBe(false);
  });
});

describe('routeStageIndex', () => {
  const router = WORKFLOW_STATUSES['router'];

  it('places a part on its own stage', () => {
    expect(routeStageIndex(router, 'pending', {})).toBe(0);
    expect(routeStageIndex(router, 'in-progress', {})).toBe(1);
    expect(routeStageIndex(router, 'machined', {})).toBe(5);
  });

  it('treats the several spellings of finished as the last stage', () => {
    for (const status of ['complete', 'kitted', 'done']) {
      expect(routeStageIndex(router, status, {})).toBe(router.length - 1);
    }
  });

  describe('autocammed', () => {
    // AutoCAM does not advance a part - a person still has to review the
    // G-code from where the part already was - so the track must not move.
    it('holds at pending when the part was pending', () => {
      expect(routeStageIndex(router, 'autocammed', { autocam_from_status: 'pending' })).toBe(0);
    });

    it('holds at in progress when the part had been started', () => {
      expect(routeStageIndex(router, 'autocammed', { autocam_from_status: 'in-progress' })).toBe(1);
    });

    it('never advances the part past where it was', () => {
      const pendingIndex = routeStageIndex(router, 'autocammed', { autocam_from_status: 'pending' });
      expect(pendingIndex).toBeLessThan(routeStageIndex(router, 'cammed', {}));
    });

    it('falls back to pending for rows autocammed before this was recorded', () => {
      expect(routeStageIndex(router, 'autocammed', {})).toBe(0);
      expect(routeStageIndex(router, 'autocammed', { autocam_from_status: '' })).toBe(0);
    });

    it('keeps the track on the row at all - the real bug was it vanishing', () => {
      expect(routeStageIndex(router, 'autocammed', {})).toBeGreaterThanOrEqual(0);
    });
  });

  it('returns -1 for a status with no place on this route', () => {
    expect(routeStageIndex(router, 'not-a-status', {})).toBe(-1);
  });
});

describe('normalizeRouteStatus', () => {
  it('folds case, spaces and underscores the way the list does', () => {
    expect(normalizeRouteStatus('In Progress')).toBe('in-progress');
    expect(normalizeRouteStatus('  IN_PROGRESS ')).toBe('in-progress');
    expect(normalizeRouteStatus(null)).toBe('');
  });
});
