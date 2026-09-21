import { describe, it, expect } from 'vitest';
import { getWorkflowStatuses, getDisplayStatus, getBadgeClass, isAutocamEligible, ALL_STATUSES } from './statuses.js';

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
