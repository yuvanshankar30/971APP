export function evaluateVisionReadiness({ match = {}, views = [], modelName = '', modelVersion = '', runners = [] } = {}) {
  match = match || {};
  views = views || [];
  runners = runners || [];
  modelName = String(modelName || '');
  modelVersion = String(modelVersion || '');
  const roster = match.team_roster || {};
  const rosterCount = (roster.red?.length || 0) + (roster.blue?.length || 0);
  const onlineRunners = runners.filter((runner) => runner.online);
  const checks = [
    {
      id: 'views', level: 'blocking', ready: views.length > 0,
      label: views.length ? `${views.length} camera view${views.length === 1 ? '' : 's'} uploaded` : 'Upload at least one camera view'
    },
    {
      id: 'model', level: 'blocking', ready: Boolean(modelName.trim() && modelVersion.trim()),
      label: modelName.trim() && modelVersion.trim() ? `${modelName} ${modelVersion}` : 'Name the detector and exact model version'
    },
    {
      id: 'runner', level: 'warning', ready: onlineRunners.length > 0,
      label: onlineRunners.length ? `${onlineRunners.length} runner${onlineRunners.length === 1 ? '' : 's'} online` : 'No runner heartbeat is currently online'
    },
    {
      id: 'roster', level: 'warning', ready: rosterCount === 6,
      label: rosterCount === 6 ? 'Six-team match roster loaded' : `Match roster has ${rosterCount} of 6 teams`
    },
    {
      id: 'mask', level: 'warning', ready: views.length > 0 && views.every((view) => view.field_mask?.length >= 3),
      label: views.length > 0 && views.every((view) => view.field_mask?.length >= 3) ? 'Every view has a field mask' : 'One or more views need a field mask'
    },
    {
      id: 'goals', level: 'warning', ready: views.length > 0 && views.every((view) => view.goal_zones?.length > 0),
      label: views.length > 0 && views.every((view) => view.goal_zones?.length > 0) ? 'Every view has goal zones' : 'One or more views need goal zones for fuel attribution'
    },
    {
      id: 'field', level: 'warning', ready: views.length > 0 && views.every((view) => view.homography),
      label: views.length > 0 && views.every((view) => view.homography) ? 'Every view has field calibration' : 'One or more views lack a homography; mobility will use pixels'
    },
    {
      id: 'starts', level: 'warning', ready: views.length > 0 && views.every((view) => view.start_zones?.length > 0),
      label: views.length > 0 && views.every((view) => view.start_zones?.length > 0) ? 'Every view has starting zones' : 'One or more views lack starting zones'
    }
  ];
  return {
    checks,
    blocking: checks.filter((check) => check.level === 'blocking' && !check.ready),
    warnings: checks.filter((check) => check.level === 'warning' && !check.ready)
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
