import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), queries: [] }));
vi.mock('$lib/supabase.js', () => ({
  supabase: { from: mocks.from }
}));

import {
  FUSION_JOB_PAGE_SIZE,
  fetchFusionJobs,
  fetchFusionJobUpdates,
  fetchFusionJobNcFiles,
  fetchFusionJobsByManufacturingPartIds,
  isFusionOutputJob
} from './fusionCam.js';

function chain(result) {
  const query = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'range']) query[method] = vi.fn(() => query);
  query.single = vi.fn(async () => result);
  query.then = (resolve) => resolve(result);
  mocks.queries.push(query);
  return query;
}

beforeEach(() => {
  mocks.from.mockReset();
  mocks.queries.length = 0;
});

describe('Fusion CAM queue query efficiency', () => {
  it('shows only jobs that produce machine output on manufacturing cards', () => {
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:cam' } })).toBe(true);
    expect(isFusionOutputJob({ params: { fusionJobKind: 'box_tube' } })).toBe(true);
    expect(isFusionOutputJob({ params: { fusionJobKind: 'plate:arrange' } })).toBe(false);
    expect(isFusionOutputJob({ params: {} })).toBe(false);
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
});
