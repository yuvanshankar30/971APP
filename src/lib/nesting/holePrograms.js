import hole060Ngc from '../../../jprog/assets/holes/holes_060.ngc?raw';
import hole090Ngc from '../../../jprog/assets/holes/holes_090.ngc?raw';
import hole125Ngc from '../../../jprog/assets/holes/holes_125.ngc?raw';
import hole1875Ngc from '../../../jprog/assets/holes/holes_1875.ngc?raw';
import hole250Ngc from '../../../jprog/assets/holes/holes_250.ngc?raw';
import hole3125Ngc from '../../../jprog/assets/holes/holes_3125.ngc?raw';
import hole375Ngc from '../../../jprog/assets/holes/holes_375.ngc?raw';
import hole500Ngc from '../../../jprog/assets/holes/holes_500.ngc?raw';
import hole750Ngc from '../../../jprog/assets/holes/holes_750.ngc?raw';
import hole060Tap from '../../../jprog/assets/holes/holes_060.tap?raw';
import hole125Tap from '../../../jprog/assets/holes/holes_125.tap?raw';
import hole250Tap from '../../../jprog/assets/holes/holes_250.tap?raw';
import hole375Tap from '../../../jprog/assets/holes/holes_375.tap?raw';
import hole500Tap from '../../../jprog/assets/holes/holes_500.tap?raw';
import hole750Tap from '../../../jprog/assets/holes/holes_750.tap?raw';

const ngc = { '0.060': hole060Ngc, '0.090': hole090Ngc, '0.125': hole125Ngc, '0.1875': hole1875Ngc, '0.25': hole250Ngc, '0.3125': hole3125Ngc, '0.375': hole375Ngc, '0.5': hole500Ngc, '0.75': hole750Ngc };
const tap = { '0.060': hole060Tap, '0.125': hole125Tap, '0.25': hole250Tap, '0.375': hole375Tap, '0.5': hole500Tap, '0.75': hole750Tap };
const thicknessToProgram = { '0.063': '0.060', '0.09': '0.090', '0.125': '0.125', '0.1875': '0.1875', '0.25': '0.25', '0.3125': '0.3125', '0.375': '0.375', '0.5': '0.5', '0.75': '0.75' };

// Matches JProg's ScrewHeadSize setting. This is the on-sheet visual and
// selection envelope; the bundled program supplies the actual cutting path.
export const HOLE_HEAD_SIZE_IN = 0.4;

export function holeProgramForThickness(thickness, dialect = 'linuxcnc') {
  const key = thicknessToProgram[String(thickness)] || '0.125';
  const programs = dialect === 'wincnc' ? tap : ngc;
  return programs[key] || programs['0.125'] || ngc['0.125'];
}
