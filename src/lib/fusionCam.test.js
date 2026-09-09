import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), queries: [], createSignedUrl: vi.fn() }));
vi.mock('$lib/supabase.js', () => ({
  supabase: {
    from: mocks.from,
    storage: { from: vi.fn(() => ({ createSignedUrl: mocks.createSignedUrl })) }
  }
}));

import {
  FUSION_JOB_PAGE_SIZE,
  fetchFusionJobs,
  fetchFusionJobUpdates,
  fetchFusionJobNcFiles,
  fetchFusionPartStepFiles,
  fetchFusionJobsByManufacturingPartIds,
  fetchFusionFolderTree,
  installFusionPartCad,
  deleteAllFailedFusionJobs,
  deleteParts,
  deleteBoxTubes,
  deleteFusionJobs,
  isFusionOutputJob,
  queueFusionJob,
  updatePartQuantity,
  renameBoxTube,
  updateBoxTubeQuantity
} from './fusionCam.js';

function chain(result) {
  const query = {};
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'limit', 'range', 'delete', 'insert', 'update']) query[method] = vi.fn(() => query);
  query.single = vi.fn(async () => result);
  query.maybeSingle = vi.fn(async () => result);
  query.then = (resolve) => resolve(result);
  mocks.queries.push(query);
  return query;
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.queries.length = 0;
  mocks.createSignedUrl.mockReset();
});

describe('Fusion CAM queue query efficiency', () => {
  it('rejects a stale folder cache whose root does not match the requested project', async () => {
    mocks.from.mockReturnValue(chain({
      data: { project_name: '2026 Season CAM', tree: { name: 'AutoCAM' } },
      error: null
    }));

    await expect(fetchFusionFolderTree()).resolves.toBeNull();
  });

  it('keeps a linked manufacturing request quantity aligned with Fusion CAM', async () => {
    mocks.from.mockImplementation((table) => {
      if (table === 'fusion_parts' && mocks.queries.length === 0) {
        return chain({ data: { quantity: 2, original_quantity: 3, part_id: 'manufacturing-part' }, error: null });
      }
      if (table === 'fusion_parts') return chain({ data: { id: 'fusion-part', original_quantity: 5, quantity: 4 }, error: null });
      return chain({ data: null, error: null });
    });

    await expect(updatePartQuantity('fusion-part', 5)).resolves.toMatchObject({ original_quantity: 5, quantity: 4 });
    expect(mocks.from).toHaveBeenNthCalledWith(3, 'parts');
    expect(mocks.queries[2].update).toHaveBeenCalledWith(expect.objectContaining({ quantity: 5 }));
    expect(mocks.queries[2].eq).toHaveBeenCalledWith('id', 'manufacturing-part');
  });

  it('shows only jobs that produce machine output on manufacturing cards', () => {
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:cam' } })).toBe(true);
    expect(isFusionOutputJob({ params: { fusionJobKind: 'box_tube' } })).toBe(true);
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:arrange' } })).toBe(false);
    expect(isFusionOutputJob({ params: {} })).toBe(false);
  });

  it('queues tube stock directly without a plate or grouping contract', async () => {
    mocks.from.mockImplementation((table) =>
      table === 'cam_machine_tools'
        ? chain({ data: [{ tool_id: 'tool-1' }], error: null })
        : chain({ data: { id: 'tube-job' }, error: null })
    );

    await expect(queueFusionJob({
      fusionJobKind: 'box_tube', boxTubeId: 'tube-1', machineId: 'router-1', toolId: 'tool-1'
    })).resolves.toEqual({ id: 'tube-job' });

    expect(mocks.from).toHaveBeenCalledWith('cam_jobs');
    const inserted = mocks.queries[1].insert.mock.calls[0][0];
    expect(inserted.params).toEqual({ fusionJobKind: 'box_tube', boxTubeId: 'tube-1', fusionFileName: null, fusionFolderPath: null, singleToolMode: false });
    expect(inserted.params).not.toHaveProperty('plateId');
    expect(inserted.params).not.toHaveProperty('fusionGroupingMode');
  });

  it('includes a plate job\'s tab count override, converted to a number, and omits it entirely for tube stock', async () => {
    mocks.from.mockReturnValue(chain({ data: { id: 'plate-job' }, error: null }));

    await queueFusionJob({
      fusionJobKind: 'plate:cam', plateId: 'plate-1', groupingMode: 'single', tabCount: '8'
    });

    const inserted = mocks.queries[0].insert.mock.calls[0][0];
    expect(inserted.params.tabCount).toBe(8);
  });

  it('leaves a plate job\'s tab count null when not set - stays automatic', async () => {
    mocks.from.mockReturnValue(chain({ data: { id: 'plate-job' }, error: null }));

    await queueFusionJob({ fusionJobKind: 'plate:cam', plateId: 'plate-1', groupingMode: 'single' });

    const inserted = mocks.queries[0].insert.mock.calls[0][0];
    expect(inserted.params.tabCount).toBeNull();
  });

  it('refuses to queue when the selected tool is no longer loaded on the machine', async () => {
    // Real, confirmed live case: a job queued with a tool that wasn't
    // actually loaded (the queue picker's own cached list had gone stale)
    // succeeded and only failed later when a Runner tried to claim it.
    // This must be caught here, before cam_jobs ever gets a row at all.
    mocks.from.mockImplementation((table) =>
      table === 'cam_machine_tools'
        ? chain({ data: [{ tool_id: 'other-tool' }], error: null })
        : chain({ data: { id: 'plate-job' }, error: null })
    );

    await expect(queueFusionJob({
      fusionJobKind: 'plate:cam', plateId: 'plate-1', groupingMode: 'single', machineId: 'router-1', toolId: 'gone-tool'
    })).rejects.toThrow(/tool.*no longer loaded/i);
    expect(mocks.from).not.toHaveBeenCalledWith('cam_jobs');
  });


  it('does not check loaded tools at all when no machine is selected yet', async () => {
    mocks.from.mockReturnValue(chain({ data: { id: 'plate-job' }, error: null }));

    await expect(queueFusionJob({
      fusionJobKind: 'plate:cam', plateId: 'plate-1', groupingMode: 'single', toolId: 'tool-1'
    })).resolves.toEqual({ id: 'plate-job' });
    expect(mocks.from).not.toHaveBeenCalledWith('cam_machine_tools');
  });

  it('refuses a tube-stock job without tube stock', async () => {
    await expect(queueFusionJob({ fusionJobKind: 'box_tube' })).rejects.toThrow(/box tube is required/i);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('persists tube name and quantity edits used by the Tube Stock cards', async () => {
    mocks.from.mockImplementation(() => chain({ data: { id: 'tube-1', name: 'Renamed Tube', quantity: 3, part_id: null }, error: null }));

    await expect(renameBoxTube('tube-1', '  Renamed Tube  ')).resolves.toMatchObject({ name: 'Renamed Tube' });
    expect(mocks.from).toHaveBeenNthCalledWith(1, 'fusion_box_tubes');
    expect(mocks.queries[0].update).toHaveBeenCalledWith({ name: 'Renamed Tube' });

    await expect(updateBoxTubeQuantity('tube-1', 3)).resolves.toMatchObject({ quantity: 3 });
    expect(mocks.from).toHaveBeenNthCalledWith(2, 'fusion_box_tubes');
    expect(mocks.from).toHaveBeenNthCalledWith(3, 'fusion_box_tubes');
    expect(mocks.queries[2].update).toHaveBeenCalledWith({ quantity: 3 });
  });

  it('keeps a linked manufacturing request quantity aligned with tube stock', async () => {
    mocks.from
      .mockReturnValueOnce(chain({ data: { part_id: 'manufacturing-part' }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: 'tube-1', quantity: 4 }, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: null }));

    await expect(updateBoxTubeQuantity('tube-1', 4)).resolves.toMatchObject({ quantity: 4 });
    expect(mocks.from).toHaveBeenNthCalledWith(3, 'parts');
    expect(mocks.queries[2].update).toHaveBeenCalledWith(expect.objectContaining({ quantity: 4 }));
    expect(mocks.queries[2].eq).toHaveBeenCalledWith('id', 'manufacturing-part');
  });

  it('rejects invalid tube card edits before querying Supabase', async () => {
    await expect(renameBoxTube('tube-1', '   ')).rejects.toThrow(/name is required/i);
    await expect(updateBoxTubeQuantity('tube-1', -1)).rejects.toThrow(/whole number/i);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('loads only the first page of job history, not the whole queue', async () => {
    // A real 175-job queue was 290KB and ~340ms before a single row
    // rendered, almost none of which is what someone opening this tab
    // is looking at.
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await fetchFusionJobs();
    expect(mocks.queries[0].range).toHaveBeenCalledWith(0, FUSION_JOB_PAGE_SIZE);
    expect(mocks.queries[0].select.mock.calls[0][0]).not.toContain('fusion_nc_files');
  });

  it('reports another page exists without a second count query', async () => {
    // Asks for one row past the page; its presence is the answer.
    const rows = Array.from({ length: FUSION_JOB_PAGE_SIZE + 1 }, (_unused, index) => ({ id: `job-${index}` }));
    mocks.from.mockReturnValue(chain({ data: rows, error: null }));
    const page = await fetchFusionJobs();
    expect(page.jobs).toHaveLength(FUSION_JOB_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('reports the end of the history when the extra row is absent', async () => {
    mocks.from.mockReturnValue(chain({ data: [{ id: 'job-1' }], error: null }));
    const page = await fetchFusionJobs();
    expect(page.jobs).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('pages from an offset when asked for older jobs', async () => {
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await fetchFusionJobs({ offset: FUSION_JOB_PAGE_SIZE });
    expect(mocks.queries[0].range).toHaveBeenCalledWith(FUSION_JOB_PAGE_SIZE, FUSION_JOB_PAGE_SIZE * 2);
  });

  it('resolves job CAD from fusion_parts, since cam_jobs.step_file_name is null', async () => {
    // A Fusion job never carries its own STEP path; the CAD lives on the
    // fusion_parts row named by params.selectedPartId.
    mocks.from.mockReturnValue(chain({ data: [{ id: 'p1', step_file_name: 'a.step' }], error: null }));
    await expect(fetchFusionPartStepFiles(['p1', 'p1', null])).resolves.toEqual({ p1: 'a.step' });
    expect(mocks.from).toHaveBeenCalledWith('fusion_parts');
    // One batched request for the page, only the two columns needed, so
    // this does not undo the paging in fetchFusionJobs.
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.queries[0].select).toHaveBeenCalledWith('id, step_file_name');
    expect(mocks.queries[0].in).toHaveBeenCalledWith('id', ['p1']);
  });

  it('skips the CAD lookup entirely when no job has a part', async () => {
    expect(await fetchFusionPartStepFiles([])).toEqual({});
    expect(await fetchFusionPartStepFiles(null)).toEqual({});
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('loads heavy NC artifacts only for one completed job on demand', async () => {
    mocks.from.mockReturnValue(chain({ data: { fusion_nc_files: [{ name: 'part.nc' }] }, error: null }));
    await expect(fetchFusionJobNcFiles('job-1')).resolves.toEqual([{ name: 'part.nc' }]);
    expect(mocks.queries[0].select).toHaveBeenCalledWith('fusion_nc_files');
    expect(mocks.queries[0].eq).toHaveBeenCalledWith('status', 'completed');
  });

  it('refreshes only requested active job rows and skips an empty refresh', async () => {
    expect(await fetchFusionJobUpdates([])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();

    mocks.from.mockReturnValue(chain({ data: [{ id: 'job-1', status: 'processing' }], error: null }));
    await fetchFusionJobUpdates(['job-1', 'job-1']);
    expect(mocks.queries[0].in).toHaveBeenCalledWith('id', ['job-1']);
  });

  it('queries only jobs for relevant plates instead of downloading all Fusion history', async () => {
    const results = {
      fusion_parts: [{ data: [{ id: 'fusion-part', part_id: 'manufacturing-part' }], error: null }],
      fusion_box_tubes: [{ data: [], error: null }],
      fusion_part_category_assignments: [{ data: [{ part_id: 'fusion-part', plate_id: 'plate-1' }], error: null }],
      cam_jobs: [{ data: [{ id: 'job-1', created_at: '2026-09-06T00:00:00Z', params: { plateId: 'plate-1', fusionJobKind: 'plate:cam' } }], error: null }]
    };
    mocks.from.mockImplementation((table) => chain(results[table].shift()));

    const mapped = await fetchFusionJobsByManufacturingPartIds(['manufacturing-part']);
    expect(mapped['manufacturing-part']).toMatchObject({ id: 'job-1' });
    const camQuery = mocks.queries.at(-1);
    expect(camQuery.in).toHaveBeenCalledWith('params->>plateId', ['plate-1']);
    expect(camQuery.limit).not.toHaveBeenCalled();
  });

  it('installs CAD by creating a signed download URL for the real STEP file', async () => {
    mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.test/a.step' }, error: null });
    await expect(installFusionPartCad('a.step')).resolves.toBe('https://example.test/a.step');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('a.step', 60);
  });

  it('refuses to install CAD for a part with no STEP file rather than call storage', async () => {
    await expect(installFusionPartCad(null)).rejects.toThrow(/no STEP file/);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it('retries a URL-decoded filename when the stored name was encoded', async () => {
    mocks.createSignedUrl
      .mockResolvedValueOnce({ data: null, error: { message: 'Object not found' } })
      .mockResolvedValueOnce({ data: { signedUrl: 'https://example.test/decoded.step' }, error: null });
    await expect(installFusionPartCad('a%20b.step')).resolves.toBe('https://example.test/decoded.step');
    expect(mocks.createSignedUrl).toHaveBeenNthCalledWith(2, 'a b.step', 60);
  });

  it('deletes every failed Fusion job in one request and reports the real count', async () => {
    mocks.from.mockReturnValue(chain({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null }));

    await expect(deleteAllFailedFusionJobs()).resolves.toBe(3);

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('cam_jobs');
    expect(mocks.queries[0].delete).toHaveBeenCalled();
    expect(mocks.queries[0].eq).toHaveBeenCalledWith('operation_type', 'milling');
    expect(mocks.queries[0].eq).toHaveBeenCalledWith('status', 'failed');
  });

  it('reports zero rather than throwing when there is nothing failed to delete', async () => {
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(deleteAllFailedFusionJobs()).resolves.toBe(0);
  });

  it('deletes every selected part in one request and reports the real count', async () => {
    mocks.from.mockReturnValue(chain({ data: [{ id: 'a' }, { id: 'b' }], error: null }));

    await expect(deleteParts(['a', 'b'])).resolves.toBe(2);

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('fusion_parts');
    expect(mocks.queries[0].delete).toHaveBeenCalled();
    expect(mocks.queries[0].in).toHaveBeenCalledWith('id', ['a', 'b']);
  });

  it('never calls the database for an empty part selection', async () => {
    await expect(deleteParts([])).resolves.toBe(0);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('deletes every selected tube-stock entry in one request and reports the real count', async () => {
    mocks.from.mockReturnValue(chain({ data: [{ id: 'x' }], error: null }));

    await expect(deleteBoxTubes(['x'])).resolves.toBe(1);

    expect(mocks.from).toHaveBeenCalledWith('fusion_box_tubes');
    expect(mocks.queries[0].delete).toHaveBeenCalled();
    expect(mocks.queries[0].in).toHaveBeenCalledWith('id', ['x']);
  });

  it('never calls the database for an empty tube selection', async () => {
    await expect(deleteBoxTubes([])).resolves.toBe(0);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('deletes every selected job in one request, scoped to the same safe statuses as a single delete', async () => {
    mocks.from.mockReturnValue(chain({ data: [{ id: '1' }, { id: '2' }], error: null }));

    await expect(deleteFusionJobs(['1', '2'])).resolves.toBe(2);

    expect(mocks.from).toHaveBeenCalledWith('cam_jobs');
    expect(mocks.queries[0].delete).toHaveBeenCalled();
    expect(mocks.queries[0].in).toHaveBeenCalledWith('id', ['1', '2']);
    expect(mocks.queries[0].eq).toHaveBeenCalledWith('operation_type', 'milling');
    expect(mocks.queries[0].in).toHaveBeenCalledWith('status', ['queued', 'completed', 'failed', 'rejected']);
  });

  it('never calls the database for an empty job selection', async () => {
    await expect(deleteFusionJobs([])).resolves.toBe(0);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
