import { describe, it, expect } from 'vitest';
import { buildDuplicatePartPayload, getFileFormatForWorkflow } from './parts_helpers.js';

describe('getFileFormatForWorkflow', () => {
  it('uses STEP for 3d-print', () => {
    expect(getFileFormatForWorkflow('3d-print')).toBe('step');
  });

  it('uses parasolid for router, laser-cut, mill, and lathe', () => {
    expect(getFileFormatForWorkflow('router')).toBe('parasolid');
    expect(getFileFormatForWorkflow('laser-cut')).toBe('parasolid');
    expect(getFileFormatForWorkflow('mill')).toBe('parasolid');
    expect(getFileFormatForWorkflow('lathe')).toBe('parasolid');
  });

  it('falls back to STEP for an unrecognized workflow', () => {
    expect(getFileFormatForWorkflow('unknown-workflow')).toBe('step');
    expect(getFileFormatForWorkflow(undefined)).toBe('step');
  });
});

describe('buildDuplicatePartPayload', () => {
  it('retains the request and CAD source while resetting completed state', () => {
    const payload = buildDuplicatePartPayload({
      id: 'completed-part',
      name: 'Gearbox side plate',
      requester: 'Alex',
      project_id: 'Drivetrain',
      workflow: 'router',
      quantity: 2,
      material: 'Aluminum 6061',
      stock_assignment: '1/4" Aluminum Sheet',
      file_name: 'gearbox.step',
      file_url: JSON.stringify({
        step_file: 'gearbox.step',
        step_valid: true,
        router_meta: { step: 'kitted', stage_counts: { kitted: 2 } },
        travis_progged: true
      }),
      notes: 'Use the fixture holes.',
      frc_team: '971',
      part_number: 'P006946',
      onshape_document_id: 'doc-id',
      onshape_wvm: 'v',
      onshape_wvmid: 'version-id',
      onshape_element_id: 'element-id',
      onshape_part_id: 'part-id',
      file_format: 'step',
      is_onshape_part: true,
      status: 'complete',
      delivered: true,
      kitting_bin: 'A1',
      assigned_to: 'operator-id',
      due_date: '2026-09-06',
      created_at: '2026-09-01T00:00:00Z'
    });

    expect(payload).toMatchObject({
      name: 'Gearbox side plate',
      requester: 'Alex',
      project_id: 'Drivetrain',
      workflow: 'router',
      quantity: 2,
      material: 'Aluminum 6061',
      stock_assignment: '1/4" Aluminum Sheet',
      file_name: 'gearbox.step',
      notes: 'Use the fixture holes.',
      frc_team: '971',
      part_number: 'P006946',
      onshape_document_id: 'doc-id',
      status: 'pending',
      delivered: false,
      kitting_bin: null,
      assigned_to: null,
      due_date: null
    });
    expect(payload.id).toBeUndefined();
    expect(payload.created_at).toBeUndefined();
    expect(JSON.parse(payload.file_url)).toEqual({ step_file: 'gearbox.step', step_valid: true });
  });

  it('preserves a plain Storage path for non-router uploads', () => {
    const payload = buildDuplicatePartPayload({
      name: 'Printed spacer',
      workflow: '3d-print',
      file_url: '1750000000000_spacer.step'
    });

    expect(payload.file_url).toBe('1750000000000_spacer.step');
    expect(payload.status).toBe('pending');
  });
});
