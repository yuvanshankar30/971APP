/**
 * Which machine profiles a given AutoCAM operation can be run on.
 *
 * Every operation but tube stock maps straight onto a machine's own
 * operation_type. Tube stock does not, and that is the whole reason this
 * exists: tube stock is drilled on the router with the operator flipping the
 * tube between faces by hand, so no machine is registered with
 * operation_type 'tubestock' and the New Job picker had nothing to offer -
 * the dropdown showed only "Unspecified" and the job could not be pointed at
 * a machine at all.
 *
 * Routers are therefore what tube stock offers, narrowed to LinuxCNC ones.
 * The narrowing is not arbitrary: the generated tube programs are verified
 * against the LinuxCNC interpreter (see routingLinuxcnc.test.js, and the
 * bare O-word program number that only LinuxCNC's reading of it makes safe),
 * while the WinCNC path through generateTubestockGcode has no equivalent
 * check behind it. Widen this when that path is actually verified, rather
 * than by adding a machine.
 *
 * A machine explicitly registered as 'tubestock' is still honoured, so
 * setting one up is not blocked by this.
 */

const TUBESTOCK_CONTROLLERS = new Set(['linuxcnc']);

export function machinesForOperation(machines, operation) {
  if (!Array.isArray(machines)) return [];
  const enabled = machines.filter((machine) => machine?.enabled);
  if (operation !== 'tubestock') {
    return enabled.filter((machine) => machine.operation_type === operation);
  }
  return enabled.filter((machine) => {
    if (machine.operation_type === 'tubestock') return true;
    if (machine.operation_type !== 'routing') return false;
    return TUBESTOCK_CONTROLLERS.has(String(machine.controller || '').toLowerCase());
  });
}
