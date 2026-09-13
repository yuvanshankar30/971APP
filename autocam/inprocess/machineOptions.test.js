import { describe, it, expect } from 'vitest';
import { machinesForOperation } from './machineOptions.js';

// The three profiles that actually exist, as they are stored today.
const lathe = { id: 1, name: '971 Lathe', operation_type: 'turning', controller: 'linuxcnc', enabled: true };
const newRouter = { id: 2, name: 'New Router', operation_type: 'routing', controller: 'wincnc', enabled: true };
const uncRouter = { id: 3, name: 'UNC Router', operation_type: 'routing', controller: 'linuxcnc', enabled: true };
const machines = [lathe, newRouter, uncRouter];

const names = (list) => list.map((machine) => machine.name);

describe('machinesForOperation', () => {
  it('offers the UNC Router for tube stock', () => {
    // The bug this fixes: no machine is stored with operation_type
    // 'tubestock', so the picker offered nothing at all and the job could
    // not be pointed at a machine.
    expect(names(machinesForOperation(machines, 'tubestock'))).toEqual(['UNC Router']);
  });

  it('leaves the WinCNC router out of tube stock', () => {
    expect(names(machinesForOperation(machines, 'tubestock'))).not.toContain('New Router');
  });

  it('still offers both routers for routing', () => {
    expect(names(machinesForOperation(machines, 'routing'))).toEqual(['New Router', 'UNC Router']);
  });

  it('still offers the lathe for turning', () => {
    expect(names(machinesForOperation(machines, 'turning'))).toEqual(['971 Lathe']);
  });

  it('never offers the lathe for tube stock', () => {
    expect(names(machinesForOperation(machines, 'tubestock'))).not.toContain('971 Lathe');
  });

  it('honours a machine explicitly registered for tube stock, whatever its controller', () => {
    const dedicated = { id: 4, name: 'Tube Cell', operation_type: 'tubestock', controller: 'wincnc', enabled: true };
    expect(names(machinesForOperation([...machines, dedicated], 'tubestock'))).toEqual(['UNC Router', 'Tube Cell']);
  });

  it('skips disabled machines for every operation', () => {
    const off = machines.map((machine) => ({ ...machine, enabled: false }));
    expect(machinesForOperation(off, 'tubestock')).toEqual([]);
    expect(machinesForOperation(off, 'routing')).toEqual([]);
  });

  it('matches the controller case-insensitively', () => {
    const shouty = [{ ...uncRouter, controller: 'LinuxCNC' }];
    expect(names(machinesForOperation(shouty, 'tubestock'))).toEqual(['UNC Router']);
  });

  it('treats a router with no controller recorded as not tube-stock capable', () => {
    const unknown = [{ ...uncRouter, controller: null }];
    expect(machinesForOperation(unknown, 'tubestock')).toEqual([]);
  });

  it('tolerates a missing machine list', () => {
    expect(machinesForOperation(null, 'tubestock')).toEqual([]);
    expect(machinesForOperation(undefined, 'routing')).toEqual([]);
  });
});
