<script>
  // Two checkboxes to filter a list by FRC team. Both can be checked (show
  // everything) or just one. Bind show971 / show9584 in the parent and use
  // passesTeamFilter() from $lib/frcTeams.js in the filtered computation.
  export let show971 = true;
  export let show9584 = true;
</script>

<div class="team-filter">
  <span class="team-filter-label">Team</span>
  <label class="team-checkbox team-971">
    <input type="checkbox" bind:checked={show971} />
    <span>971</span>
  </label>
  <label class="team-checkbox team-9584">
    <input type="checkbox" bind:checked={show9584} />
    <span>9584</span>
  </label>
</div>

<style>
  .team-filter {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .team-filter-label {
    font-size: var(--font-xs, 0.75rem);
    font-weight: 600;
    color: var(--text-muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .team-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--border, #d1d5db);
    border-radius: var(--radius-sm, 4px);
    font-size: var(--font-xs, 0.75rem);
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    background: var(--surface-1, #fff);
  }

  .team-checkbox input { cursor: pointer; margin: 0; }

  /* Both teams read in the normal text colour. They used to be tinted blue
     and green, which made a pair of filter checkboxes look like two
     different kinds of thing - the number already says which team it is. */
  .team-971,
  .team-9584 { color: var(--text); }
</style>
