import { describe, it, expect, vi, afterEach } from 'vitest';
import { todayDriveDateFolderName, driveDeliveryFileName, listChangesSince } from './drive_watcher.js';

describe('todayDriveDateFolderName', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats as YYYY-MM-DD', () => {
    expect(todayDriveDateFolderName()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses Pacific time, not server/UTC time - a moment that is already "tomorrow" in UTC can still be "today" in Pacific', () => {
    // 2026-08-21 03:00 UTC = 2026-08-20 20:00 PDT (UTC-7) - past midnight UTC,
    // but still Thursday evening on the west coast. If this ever used the
    // server's local/UTC date instead of PACIFIC_TIME_ZONE, a job delivered
    // in the evening would silently land in tomorrow's folder instead of
    // today's - the exact bug this test pins down.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T03:00:00Z'));
    expect(todayDriveDateFolderName()).toBe('2026-08-20');
  });

  it('rolls over correctly right after Pacific midnight', () => {
    // 2026-08-21 07:01 UTC = 2026-08-21 00:01 PDT - just past midnight Pacific.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T07:01:00Z'));
    expect(todayDriveDateFolderName()).toBe('2026-08-21');
  });
});

describe('driveDeliveryFileName', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefixes with the machine name and keeps the original extension - the real reason this exists: multiple machines can share one drive_output_folder_id (both routers deliver into the same dated Cammed folder), so nothing else in this system tells two machines\' files apart once they land there', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T21:05:09Z')); // 14:05:09 PDT
    const job = { id: '12345678-abcd', gcode_file_name: 'gearbox-plate.ngc' };
    const machine = { name: 'Old Router (ShopSabre)' };
    expect(driveDeliveryFileName(job, machine)).toBe('old-router-shopsabre_gearbox-plate_140509_12345678-abcd.ngc');
  });

  it('two different machines cutting the same-named part at the same moment still produce different filenames', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T21:05:09Z'));
    const job = { id: '12345678-abcd', gcode_file_name: 'bracket.ngc' };
    const oldRouter = driveDeliveryFileName(job, { name: 'Old Router' });
    const newRouter = driveDeliveryFileName(job, { name: 'New Router' });
    expect(oldRouter).not.toBe(newRouter);
    expect(oldRouter).toContain('old-router');
    expect(newRouter).toContain('new-router');
  });

  it('preserves a non-.ngc extension (e.g. .tap for a Mach3/Mach4-style profile)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T21:05:09Z'));
    const job = { id: '12345678-abcd', gcode_file_name: 'bracket.tap' };
    expect(driveDeliveryFileName(job, { name: 'New Router' })).toMatch(/\.tap$/);
  });

  it('falls back to sane defaults for a missing machine name or gcode_file_name', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T21:05:09Z'));
    // Matches the pre-existing 'output.ngc' fallback this replaced.
    expect(driveDeliveryFileName({}, {})).toBe('machine_output_140509_no-id.ngc');
  });

  it('does not collide for two same-name jobs delivered in the same second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T21:05:09Z'));
    const first = driveDeliveryFileName({ id: 'aaaaaaaa-1111', gcode_file_name: 'bracket.ngc' }, { name: 'Router' });
    const second = driveDeliveryFileName({ id: 'bbbbbbbb-2222', gcode_file_name: 'bracket.ngc' }, { name: 'Router' });
    expect(first).not.toBe(second);
  });
});

describe('listChangesSince', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads one bounded page and returns its immediate cursor without skipping later work', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ changes: [{ fileId: 'first' }], nextPageToken: 'page-2' })
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listChangesSince('token', 'page-1', 'drive-id')).resolves.toEqual({
      changes: [{ fileId: 'first' }],
      nextPageToken: 'page-2'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('pageSize=10');
  });
});
