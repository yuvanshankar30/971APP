<script>
  export let left = null;
  export let right = null;

  const size = 360;
  const center = size / 2;
  const radius = 112;
  const labelRadius = 142;
  const rings = [20, 40, 60, 80, 100];

  const point = (index, count, percent, distance = radius) => {
    const angle = (-Math.PI / 2) + (index * Math.PI * 2 / count);
    const scaled = distance * Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    return [center + Math.cos(angle) * scaled, center + Math.sin(angle) * scaled];
  };
  const polygon = (profile, fixedPercent = null) => {
    if (!profile?.length) return '';
    return profile.map((axis, index) => point(index, profile.length, fixedPercent ?? axis.value).join(',')).join(' ');
  };
  const observed = (axis) => Number.isFinite(Number(axis?.value)) && axis.value !== null && axis.value !== '';
  const hasCompleteProfile = (profile) => profile?.length && profile.every(observed);
  // Do not join a known rating to the chart centre just because another axis
  // was never observed. A polygon is only meaningful when every dimension is
  // present; partial profiles render honest, disconnected observed segments.
  const segments = (profile) => (profile || []).flatMap((axis, index) => {
    const next = profile[(index + 1) % profile.length];
    if (!observed(axis) || !observed(next)) return [];
    const start = point(index, profile.length, axis.value);
    const end = point((index + 1) % profile.length, profile.length, next.value);
    return [{ x1: start[0], y1: start[1], x2: end[0], y2: end[1] }];
  });
  const labelPoint = (index, count) => point(index, count, 100, labelRadius);
  const anchor = (x) => x < center - 8 ? 'end' : x > center + 8 ? 'start' : 'middle';
  const profileLabel = (team) => (team?.starProfile || [])
    .map((axis) => `${axis.label} ${axis.value == null ? 'not observed' : `${Math.round(axis.value)} out of 100`}`)
    .join(', ');

  $: axes = left?.starProfile || right?.starProfile || [];
  $: leftComplete = hasCompleteProfile(left?.starProfile);
  $: rightComplete = hasCompleteProfile(right?.starProfile);
  $: leftSegments = segments(left?.starProfile);
  $: rightSegments = segments(right?.starProfile);
  $: description = right
    ? `Event-relative robot star plot. Team ${left?.team_number}: ${profileLabel(left)}. Team ${right?.team_number}: ${profileLabel(right)}.`
    : `Event-relative robot star plot. Team ${left?.team_number}: ${profileLabel(left)}.`;
</script>

<div class="star-plot">
  <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={description}>
    <title>{right ? `Robot star plot for teams ${left?.team_number} and ${right?.team_number}` : `Robot star plot for team ${left?.team_number}`}</title>
    {#each rings as ring}
      <polygon class="grid-ring" points={polygon(axes, ring)} />
    {/each}
    {#each axes as axis, index}
      {@const end = point(index, axes.length, 100)}
      {@const label = labelPoint(index, axes.length)}
      <line class="grid-spoke" x1={center} y1={center} x2={end[0]} y2={end[1]} />
      <text class="axis-label" x={label[0]} y={label[1]} text-anchor={anchor(label[0])} dominant-baseline="middle">{axis.label}</text>
    {/each}
    {#if right?.starProfile?.length}
      {#if rightComplete}<polygon class="team-shape team-right" points={polygon(right.starProfile)} />{/if}
      {#each rightSegments as segment}
        <line class="team-segment team-right" {...segment} />
      {/each}
      {#each right.starProfile as axis, index}
        {#if observed(axis)}
          {@const marker = point(index, right.starProfile.length, axis.value)}
          <circle class="marker marker-right" cx={marker[0]} cy={marker[1]} r="3.5" />
        {/if}
      {/each}
    {/if}
    {#if left?.starProfile?.length}
      {#if leftComplete}<polygon class="team-shape team-left" points={polygon(left.starProfile)} />{/if}
      {#each leftSegments as segment}
        <line class="team-segment team-left" {...segment} />
      {/each}
      {#each left.starProfile as axis, index}
        {#if observed(axis)}
          {@const marker = point(index, left.starProfile.length, axis.value)}
          <circle class="marker marker-left" cx={marker[0]} cy={marker[1]} r="3.5" />
        {/if}
      {/each}
    {/if}
  </svg>
  <div class="legend" aria-hidden="true">
    <span><i class="left-swatch"></i> Team {left?.team_number}</span>
    {#if right}<span><i class="right-swatch"></i> Team {right.team_number}</span>{/if}
  </div>
  <p>Each axis is normalized against this event's scouted field. Missing observations are omitted; tied fields sit at 50.</p>
</div>

<style>
  .star-plot { display:grid; justify-items:center; padding:var(--space-3) 0; }
  svg { width:min(100%, 28rem); height:auto; overflow:visible; }
  .grid-ring, .grid-spoke { fill:none; stroke:var(--border); stroke-width:1; }
  .grid-ring:last-of-type { stroke:var(--text-muted); }
  .axis-label { fill:var(--text-muted); font-family:var(--font-mono-stack); font-size:11px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; }
  .team-shape { stroke-width:2.5; stroke-linejoin:round; }
  .team-segment { fill:none; stroke-width:2.5; stroke-linecap:round; }
  .team-left { fill:color-mix(in srgb, var(--accent) 26%, transparent); stroke:var(--accent-strong); }
  .team-right { fill:color-mix(in srgb, #3987d8 22%, transparent); stroke:#3987d8; }
  .marker { stroke:var(--surface-1); stroke-width:1.5; }
  .marker-left, .left-swatch { background:var(--accent-strong); fill:var(--accent-strong); }
  .marker-right, .right-swatch { background:#3987d8; fill:#3987d8; }
  .legend { display:flex; flex-wrap:wrap; justify-content:center; gap:var(--gap-4); font-size:.8rem; font-weight:600; }
  .legend span { display:flex; align-items:center; gap:var(--space-1); }
  .legend i { display:inline-block; width:.8rem; height:.8rem; border-radius:2px; }
  p { max-width:34rem; margin:var(--space-2) 0 0; color:var(--text-muted); font-size:.74rem; text-align:center; }
</style>
