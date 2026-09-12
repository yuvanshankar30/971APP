// Many subsystem/part names in this app follow a CamelCase convention with
// no spaces at all (e.g. "2026ThirdRobotHopper") - a browser has no word
// boundary to wrap at, so a long one either overflows or gets cut mid-
// syllable by overflow-wrap: anywhere ("2026ThirdRobo" / "tHopper", a real
// reported bug). Inserting a <wbr> before each internal CamelCase boundary
// gives the browser a real, sensible place to break ("2026ThirdRobot" /
// "Hopper") while still rendering as one continuous word when there's
// enough width to fit it.
export function camelBreakHtml(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/([a-z0-9])(?=[A-Z])/g, '$1<wbr>');
}
