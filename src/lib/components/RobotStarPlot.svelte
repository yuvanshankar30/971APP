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
  const labelPoint = (index, count) => point(index, count, 100, labelRadius);
  const anchor = (x) => x < center - 8 ? 'end' : x > center + 8 ? 'start' : 'middle';
  const profileLabel = (team) => (team?.starProfile || [])
    .map((axis) => `${axis.label} ${axis.value == null ? 'not observed' : `${Math.round(axis.value)} out of 100`}`)
    .join(', ');

  $: axes = left?.starProfile || right?.starProfile || [];
  $: description = `Event-relative robot star plot. Team ${left?.team_number}: ${profileLabel(left)}. Team ${right?.team_number}: ${profileLabel(right)}.`;
</script>

<div class="star-plot">
  <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={description}>
    <title>Robot star plot for teams {left?.team_number} and {right?.team_number}</title>
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
      <polygon class="team-shape team-right" points={polygon(right.starProfile)} />
      {#each right.starProfile as axis, index}
        {@const marker = point(index, right.starProfile.length, axis.value)}
        <circle class="marker marker-right" cx={marker[0]} cy={marker[1]} r="3.5" />
      {/each}
    {/if}
    {#if left?.starProfile?.length}
      <polygon class="team-shape team-left" points={polygon(left.starProfile)} />
      {#each left.starProfile as axis, index}
        {@const marker = point(index, left.starProfile.length, axis.value)}
        <circle class="marker marker-left" cx={marker[0]} cy={marker[1]} r="3.5" />
      {/each}
    {/if}
  </svg>
  <div class="legend" aria-hidden="true">
    <span><i class="left-swatch"></i> Team {left?.team_number}</span>
    <span><i class="right-swatch"></i> Team {right?.team_number}</span>
  </div>
  <p>Each axis is normalized against this event's scouted field. Missing observations collapse to the center; tied fields sit at 50.</p>
</div>

<style>
  .star-plot { display:grid; justify-items:center; padding:var(--space-3) 0; }
  svg { width:min(100%, 28rem); height:auto; overflow:visible; }
  .grid-ring, .grid-spoke { fill:none; stroke:var(--border); stroke-width:1; }
  .grid-ring:last-of-type { stroke:var(--text-muted); }
  .axis-label { fill:var(--text-muted); font-family:var(--font-mono-stack); font-size:11px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; }
  .team-shape { stroke-width:2.5; stroke-linejoin:round; }
  .team-left { fill:color-mix(in srgb, var(--accent) 26%, transparent); stroke:var(--accent-strong); }
  .team-right { fill:color-mix(in srgb, #3987d8 22%, transparent); stroke:#3987d8; }
  .marker { stroke:var(--surface); stroke-width:1.5; }
  .marker-left, .left-swatch { background:var(--accent-strong); fill:var(--accent-strong); }
  .marker-right, .right-swatch { background:#3987d8; fill:#3987d8; }
  .legend { display:flex; flex-wrap:wrap; justify-content:center; gap:var(--gap-4); font-size:.8rem; font-weight:600; }
  .legend span { display:flex; align-items:center; gap:var(--space-1); }
  .legend i { display:inline-block; width:.8rem; height:.8rem; border-radius:2px; }
  p { max-width:34rem; margin:var(--space-2) 0 0; color:var(--text-muted); font-size:.74rem; text-align:center; }
</style>
