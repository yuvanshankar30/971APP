// Deterministic, server-side product knowledge for Slack. These entries are
// answered locally and are never included in Gemini or Google Search requests.
// Keep routes/subtabs aligned with the user-facing implementation and README.
const HUB_ORIGIN = 'https://spartanshub.spartanrobotics.org';

export const HUB_FEATURES = [
  {
    name: 'Home', aliases: ['home page', 'home tab', 'dashboard'], route: '/', location: 'Home (always the first navigation item)',
    summary: 'The signed-in starting dashboard for current personal and competition work.',
    sections: ['Current or next competition match', 'Personal scouting assignments and completion state', 'Task/work summaries', 'Shortcuts into daily workflows'],
    details: 'Home is not removable from the primary navigation. Completed scouting assignments remain visible below open work.'
  },
  {
    name: 'EPA', aliases: ['epa', 'expected points added'], route: '/epa', location: 'Competition → EPA',
    summary: "Spartans Hub's own Expected Points Added model computed from raw TBA match results. It is not Statbotics EPA, TBA OPR, 971 Scout Power, Robot Ratings, or the official event rank.",
    sections: ['Rankings (/epa?tab=rankings): local EPA beside OPR, win percentage, average score, matches, and record', 'Events (/epa?tab=events): event details, team count, and matches played', 'Predict (/epa?tab=predict): alliance EPA totals and estimated red/blue win probability', 'Accuracy (/epa?tab=accuracy): chronological back-test and model record'],
    details: 'The model predicts each match before learning its result, then fits its learning rate and win-probability scale against played matches. Use the event picker for past events; Scouting Admin sets the active event.'
  },
  {
    name: 'JProg', aliases: ['jprog', 'justinprog', 'nesting', 'sheet layout'], route: '/jprog', location: 'Manufacturing → JustinProg',
    summary: 'Manual sheet layout and G-code emission for router programs. It is standalone: emitting JProg output does not queue or update AutoCAM or Fusion.',
    sections: ['Home / Sheets (/jprog): search, create, rename, delete, and open sheets', 'Settings (/jprog/settings): coordinate system, part-library suffix workflow, output location, and hole-program behavior', 'Sheet editor (/jprog/sheets/{sheet id}): cuts, part placement, holes, coordinates, rotate/duplicate, measurements, validation, output editor, and G-code emission', 'Part sources: uploaded .ngc/.tap files, the parts library, Manufacturing Files, or completed AutoCAM jobs'],
    details: 'Sheet zero is the lower-right corner: X runs negative left and Y positive up. Output is saved under Manufacturing Files → JustinProgOutput/YYYYMMDD. Use Emit G-code in an open sheet; supported output is LinuxCNC .ngc or WinCNC .tap according to the sheet program type.'
  },
  {
    name: 'Fusion AutoCAM', aliases: ['fusion autocam', 'fusion cam', 'autocam fusion'], route: '/autocam/fusion', location: 'Manufacturing → Fusion AutoCAM',
    summary: 'Queues and tracks Fusion 360 CAM work handled by the installed Fusion runner.',
    sections: ['Parts (/autocam/fusion/parts): plate/part stock and jobs', 'Tube Stock (/autocam/fusion/tubes): box-tube jobs and face setups', 'Turning (/autocam/fusion/turning): lathe/turning jobs', 'Jobs (/autocam/fusion/jobs): queued, running, completed, and failed work', 'Stock Categories (/autocam/fusion/stock-categories): reusable stock definitions', 'Usage Guide (/autocam/fusion/usage)', 'Runner Setup (/autocam/fusion/setup)'],
    details: 'Authorized users also get Quick Queue, Send to Fusion CAM, and ATC Slots controls. Job output and status return from the separate Fusion runner.'
  },
  {
    name: 'Manufacturing', aliases: ['manufacturing', 'manufacture', 'manufacturing request'], route: '/manufacture', location: 'Manufacturing → Manufacture',
    summary: 'Tracks requested parts through shop workflows such as router, turning/lathe, mill, laser cutting, 3D printing, and post-processing.',
    sections: ['Create request (/manufacture/create)', 'Router (/manufacture/router)', 'Post Processing (/manufacture/post-processing)', 'Bins (/manufacture/bins)', 'Kitting (/manufacture/kitting)', 'Completed (/manufacture/completed)', 'Files (/manufacture/files)', 'Portal (/manufacture/portal)'],
    details: 'Requests include ownership, status, files, quantities, workflow and lead notifications. Manufacturing Files is shared with CAD.'
  },
  {
    name: 'Legacy AutoCAM', aliases: ['autocam', 'in process autocam', 'legacy autocam'], route: '/manufacture/autocam', location: 'Manufacturing → Manufacture → AutoCAM settings/direct route',
    summary: 'The in-process STEP-to-G-code engine and machine/material configuration, separate from Fusion AutoCAM.',
    sections: ['Turning/lathe profile generation', 'Router plate contour and hole generation', 'Indexed box-tube drilling', '2D/3D toolpath previews', 'Machine, material and tool configuration'],
    details: 'Generated programs still require operator review. Fusion AutoCAM is the separate Fusion-runner queue at /autocam/fusion.'
  },
  {
    name: 'G-code Converter', aliases: ['g code converter', 'gcode converter', 'convert gcode'], route: '/manufacture/gcode-converter', location: 'Manufacturing → G-code Converter when enabled; otherwise search/direct',
    summary: 'Converts and repairs supported CNC program text for the target machine workflow.',
    sections: ['Load/paste a supported program', 'Convert units or supported dialect details', 'Repair recognized formatting/comment issues', 'Download the converted program'],
    details: 'It is a converter, not CAM: it does not derive a safe toolpath from arbitrary CAD geometry.'
  },
  {
    name: 'Manufacturing Portal', aliases: ['manufacturing portal', 'shop portal'], route: '/manufacture/portal', location: 'Open /manufacture/portal through search/direct navigation',
    summary: 'A shop-floor overview for manufacturing work.',
    sections: ['Current work visibility', 'Workflow/status shortcuts', 'Operator-oriented access to manufacturing jobs'],
    details: 'Use the main Manufacture page to create and edit full requests.'
  },
  {
    name: 'Router Workflow', aliases: ['router workflow', 'router parts', 'router tab'], route: '/manufacture/router', location: 'Manufacturing → Manufacture → Router/direct route',
    summary: 'The router-specific manufacturing queue and status workflow.',
    sections: ['Router part queue', 'Machining/review status', 'Relevant files and completion progress'],
    details: 'CAM generation may come from Fusion AutoCAM, legacy AutoCAM, or uploaded programs depending on the part.'
  },
  {
    name: 'Post Processing', aliases: ['post processing', 'deburr', 'countersink'], route: '/manufacture/post-processing', location: 'Manufacturing → Manufacture → Post Processing/direct route',
    summary: 'Tracks finishing work after primary machining, such as deburring and countersinking.',
    sections: ['Parts awaiting finishing', 'Post-processing status and ownership', 'Completion handoff'],
    details: 'It is part of the manufacturing request lifecycle, not a separate CAD or purchasing workflow.'
  },
  {
    name: 'Bins', aliases: ['manufacturing bins', 'bin locations', 'bins tab'], route: '/manufacture/bins', location: 'Manufacturing → Manufacture → Bins/direct route',
    summary: 'Tracks manufacturing storage/bin locations for parts.',
    sections: ['Bin/location list', 'Part location assignment', 'Shop-floor retrieval context'],
    details: 'COTS Stocking is the separate commercial-parts inventory surface.'
  },
  {
    name: 'Kitting', aliases: ['kitting', 'kits'], route: '/kitting', location: 'Search/direct route; optional Manufacturing navigation item',
    summary: 'Groups and stages required parts for builds.',
    sections: ['Kit/build grouping', 'Part readiness and assignment', 'Bin/inventory context'],
    details: 'The related manufacturing-embedded route is /manufacture/kitting. Kitting may be hidden from the default menu without being disabled.'
  },
  {
    name: 'COTS Stocking', aliases: ['cots stocking', 'cots inventory', 'commercial parts'], route: '/cots-stocking', location: 'Search/direct route; optional Manufacturing navigation item',
    summary: 'Inventory tracking for commercial off-the-shelf parts.',
    sections: ['Stocked items', 'Quantities and locations', 'Restocking/build availability context'],
    details: 'Purchasing tracks acquisition and receiving; COTS Stocking tracks inventory after acquisition.'
  },
  {
    name: 'Strategy', aliases: ['strategy'], route: '/strategy', location: 'Competition → Strategy',
    summary: 'The competition decision board combining the TBA schedule, local scouting, pit capabilities/issues, comparisons, and sortable team evidence.',
    sections: ['Match schedule and rough local Scout Power win likelihood', 'Sortable team board', 'Per-team brief and scouting coverage', 'Send a sorted team set to Picklist'],
    details: 'Its rough win likelihood is not a Prediction Market bet and is not an official FIRST forecast.'
  },
  {
    name: 'Drive Team', aliases: ['drive team'], route: '/driveteam', location: 'Competition → Drive Team',
    summary: 'Team 971’s field-facing event schedule.',
    sections: ['Next-match countdown, alliance and roster', 'Matches-away and downtime estimates', 'Later matches', 'Past Win/Loss/Tie results and final scores'],
    details: 'It uses the active scouting event and public TBA match data.'
  },
  {
    name: 'Match Scouting', aliases: ['match scouting', 'match scout'], route: '/matchscout', location: 'Competition → Match Scouting',
    summary: 'Records what one robot did in one event match and lets the scout correct their own submitted reports.',
    sections: ['Pre-match assignment, alliance, start and preload', 'Autonomous movement, fuel estimate/source and optional path', 'Teleop role, ball/fuel estimate, intake, driving, accuracy, defense and incidents', 'Robot state, climb, beached/carded outcome and notes', 'My reports and manual-versus-vision comparison'],
    details: 'Mechanical, disabled, and dead-robot observations require an ACE/Pit handoff. This is match performance; Pit Scouting describes the robot as built.'
  },
  {
    name: 'Pit Scouting', aliases: ['pit scouting', 'pit scout'], route: '/pitscout', location: 'Competition → Pit Scouting',
    summary: 'The shared per-team robot profile collected in the pits.',
    sections: ['Archetype, mechanisms, dimensions, weight and drive base', 'Intake/scoring capabilities and named autonomous paths', 'Climb, technical ratings, photos and reliability risks', 'Notes and ACE/Pit issue resolution'],
    details: 'Saved profiles can be reopened and updated. It describes capability and construction, not match-by-match performance.'
  },
  {
    name: 'My Scout', aliases: ['my scout'], route: '/myscout', location: 'Competition → My Scout',
    summary: "The signed-in scout's assignment inbox and scouting history.",
    sections: ['Open assignments', 'Completed assignments', 'Submitted Match Scouting reports', 'Submitted Pit Scouting reports'],
    details: 'Completed work remains visible and can link back to Match Scouting for corrections.'
  },
  {
    name: 'Picklist', aliases: ['picklist', 'pick list'], route: '/picklist', location: 'Competition → Picklist',
    summary: 'The shared alliance-selection ordering workspace.',
    sections: ['Human drag-to-reorder list', 'Seed from Strategy or automatic ranking', 'Advisory move flags', 'Slider-weighted automatic rank using Performance, Notes impact, Reliability and OPR'],
    details: 'Automated flags advise; they never block the human ordering decision.'
  },
  {
    name: 'Match Rankings', aliases: ['match rankings', 'rank a match'], route: '/matchrankings', location: 'Competition → Match Rankings',
    summary: 'Stores one shared, revisable best-to-worst order of all six robots after each match.',
    sections: ['Select a played match', 'Order its six robots', 'Save or revise the shared conclusion'],
    details: 'These pairwise relationships feed Human Consensus in Power Rankings. They never alter calculated Scout Power.'
  },
  {
    name: 'Power Rankings', aliases: ['power rankings', 'scout power', 'human consensus'], route: '/powerrankings', location: 'Competition → Power Rankings',
    summary: "971's event-relative scouting ranking and head-to-head comparison page. It is not an official FRC ranking.",
    sections: ['971 Scout Power: calculated local scouting score', 'Human Consensus: Match Rankings plus authenticated comparisons', 'Team Rating: display-only average from Robot Ratings', 'Official Event Rank: FIRST qualification standing from TBA', 'TBA OPR: least-squares contribution estimate', 'Head-to-head table, star plot, evidence and review flags'],
    details: 'Scout Power currently blends observed performance, explicit note impact, pit reliability and TBA OPR while rebalancing around missing inputs. Human Consensus and Robot Ratings do not change it.'
  },
  {
    name: 'Robot Ratings', aliases: ['robot ratings', 'team rating'], route: '/robotratings', location: 'Competition → Robot Ratings',
    summary: "Scouts' subjective 1–10 impressions, shared with the team.",
    sections: ['Overall, auto, offense, shuttling and driving', 'Defense or N/A', 'General notes', 'Practice-match strategy notes', 'Individual entries and team averages'],
    details: 'The average appears in Power Rankings for context but never changes Scout Power.'
  },
  {
    name: 'Vision Scouting', aliases: ['vision scouting', 'vision review'], route: '/scouting/vision', location: 'Competition → Vision Scouting',
    summary: 'A review-first match-video evidence workflow; model output is provisional until an authorized human releases it.',
    sections: ['Recordings and camera views', 'ML runs and runner status', 'Robot tracks and calibrated trajectories', 'Fuel attribution and detected actions', 'Qwen clip audit and discrepancies', 'Human review, release preview and explicit release', 'Dashboard (/scouting/vision/dashboard)'],
    details: 'Vision suggestions never silently overwrite a manual scout report. VISION_RELEASE gates publication into real scouting data.'
  },
  {
    name: 'Prediction Market', aliases: ['prediction market', 'predictions', 'leaderboard', 'alliance draft'], route: '/predictions', location: 'Competition → Prediction Market',
    summary: 'The points-based game for predicting match and alliance-selection outcomes.',
    sections: ['Match Watch and event stream', 'Upcoming matches/markets', 'My Predictions (/predictions/mine)', 'Match detail (/predictions/matches/{match key})', 'Leaderboard (/predictions/leaderboard)', 'Alliance Draft (/predictions/alliance-draft)'],
    details: 'The hidden system model participates as an ordinary vote without displaying a model prediction. Market points are unrelated to EPA, Scout Power, official rank, and scouting assignments.'
  },
  {
    name: 'Blue Alliance', aliases: ['blue alliance', 'tba'], route: '/bluealliance', location: 'Competition → Blue Alliance',
    summary: 'An in-Hub browser for public The Blue Alliance event and team data.',
    sections: ['Event information', 'Team profiles', 'TBA-backed schedules, results, rankings and OPR used elsewhere in Hub'],
    details: 'TBA data is public reference data and is distinct from local scout observations.'
  },
  {
    name: 'Scouting Admin', aliases: ['scouting admin', 'scout assignments', 'scouting assignments'], route: '/scouting-admin', location: 'Competition → Scouting Admin (restricted)',
    summary: 'Permission-restricted control room for competition setup, assignments, coverage and exports.',
    sections: ['Set or browse competition events', 'Manage match, note, quick, pit and pre-scout assignments', 'Configure scouting form settings', 'Seed teams before TBA publishes the roster', 'Coverage/status dashboard', 'Google Sheet synchronization', 'Export submitted Match Scouting results for one event/day as CSV'],
    details: 'The CSV contains submitted Match Scouting results, not assignment rows. Slack assignment questions must identify exactly one full name or clearly ask for the caller’s own assignments.'
  },
  {
    name: 'Quick Scout', aliases: ['quick scout', 'quickscout'], route: '/quickscout', location: 'Competition → Quick Scout (direct/search)',
    summary: 'Fast event-based scouting for timestamped robot actions, fuel events, and objective endgame results.',
    sections: ['Select match/team', 'Record timed actions and fuel', 'Record endgame result'],
    details: 'It writes the event data used by scouting analytics; it is separate from the structured Match Scouting report.'
  },
  {
    name: 'Team View', aliases: ['team view', 'teamview'], route: '/teamview', location: 'Open a team from competition pages or use /teamview',
    summary: 'A detailed local scouting view for one team and event.',
    sections: ['Match trends and performance breakdowns', 'Pit and scouting evidence', 'Match video when available', 'Links back to the originating competition page'],
    details: 'Team View is deliberately outside the default navigation; most users reach it by clicking a team number elsewhere.'
  },
  {
    name: 'Note Scouting', aliases: ['note scouting', 'notes scouting', 'notescout'], route: '/notescout', location: 'Open /notescout through search/direct navigation',
    summary: 'The legacy/freeform team-note collection surface.',
    sections: ['Select event/team', 'Record qualitative observations', 'Feed saved notes into scouting context'],
    details: 'It is not in the default navigation. Structured Match Scouting and Robot Ratings cover different evidence.'
  },
  {
    name: 'CAD', aliases: ['cad', 'onshape'], route: '/cad', location: 'CAD → CAD',
    summary: 'The Onshape-backed design and part workspace.',
    sections: ['Parts and metadata', 'Drawings and STEP files', 'BOM CSV handling', 'Manufacturing and purchasing linkage', 'Build context'],
    details: 'Build is at /cad/build. Files is shared with Manufacturing so exports, drawings and STEP files stay in one browser.'
  },
  {
    name: 'Build', aliases: ['builds', 'build tab'], route: '/cad/build', location: 'CAD → Build',
    summary: 'Groups assemblies/projects and the parts required to build them.',
    sections: ['Build list', 'Build detail (/cad/build/{id})', 'Parts/BOM and manufacturing context'],
    details: 'Build is a CAD sub-workflow, not the general Tasks or Planner page.'
  },
  {
    name: 'Files', aliases: ['manufacturing files', 'files tab', 'file browser'], route: '/manufacture/files', location: 'Manufacturing → Files or CAD → Files',
    summary: 'The shared manufacturing-drive file browser used by Manufacturing, CAD, AutoCAM and JProg outputs.',
    sections: ['Browse folders', 'Upload/download supported files', 'Access BOM exports, drawings, STEP files and generated programs'],
    details: 'JProg output is under JustinProgOutput/YYYYMMDD.'
  },
  {
    name: 'Purchasing', aliases: ['purchasing', 'orders', 'budgets', 'receiving'], route: '/cad/purchasing', location: 'Purchasing',
    summary: 'Tracks requested items through approval, ordering, receiving and delivery.',
    sections: ['Requests, vendors, quantities and prices', 'Budgets and approvals', 'Orders and receiving', 'Scan package/label to suggest an open item'],
    details: 'The scan photo is not stored and confirmation is required before marking delivery. Permissions determine who can request, approve, order, manage vendors or edit budgets.'
  },
  {
    name: 'Planner', aliases: ['planner', 'gantt'], route: '/planner', location: 'Open /planner through search/direct navigation',
    summary: 'Schedule-focused planning with dated work, dependencies, ownership, a Gantt view, and Slack reminders.',
    sections: ['Timeline/Gantt', 'Dependencies', 'Owners and due dates', 'Automated reminders'],
    details: 'Planner is scheduling-focused; Tasks is the general work tracker.'
  },
  {
    name: 'Tasks', aliases: ['tasks', 'p0 issue', 'p0 bug'], route: '/tasks', location: 'Open /tasks through search/direct navigation',
    summary: 'The general work-assignment tracker, separate from Planner.',
    sections: ['Task list and ownership', 'Categories and status', 'P0 issue reporting (/tasks/report-p0)'],
    details: 'Use Planner when the core need is dependencies and schedule/Gantt planning.'
  },
  {
    name: 'Admin', aliases: ['admin page', 'site admin', 'user roles', 'permissions'], route: '/admin', location: 'Admin (restricted; appended for authorized users)',
    summary: 'The VIEW_ADMIN_PANEL-gated administration surface.',
    sections: ['Users and account status', 'General, team and purchasing roles', 'Explicit permissions and competition roster roles', 'Manufacturing notifications and vision alert opt-ins', 'Attendance settings', 'Budgets and activity'],
    details: 'In Slack, linked users may ask for their own shareable role summary. Only VIEW_ADMIN_PANEL callers may inspect one named person. Email, Slack IDs, notification settings and credentials are not returned.'
  },
  {
    name: 'Account', aliases: ['account settings', 'profile settings', 'my profile', 'appearance', 'navigation settings'], route: '/profile', location: 'Account in the user menu',
    summary: 'Personal account and interface settings.',
    sections: ['Account/profile and password', 'Appearance and themes', 'Navigation layout', 'Notification preferences', 'Personal attendance/stat history'],
    details: 'Global search is available from the header with Command/Ctrl+K.'
  },
  {
    name: 'Docs', aliases: ['docs tab', 'documentation', 'help guide'], route: '/docs', location: 'Open /docs through search/direct navigation',
    summary: 'In-app documentation and help.',
    sections: ['User guides', 'Workflow explanations', 'Links to relevant tools'],
    details: 'Docs may not be pinned in the default navigation but remains available.'
  },
  {
    name: 'Discover', aliases: ['discover page', 'tool directory'], route: '/discover', location: 'Open /discover through search/direct navigation',
    summary: 'A directory for exploring Hub tools and pages.',
    sections: ['Browse available tools', 'Find routes outside personal navigation'],
    details: 'For a faster named lookup, use global search with Command/Ctrl+K.'
  }
];

export const HUB_NAVIGATION_OVERVIEW = [
  '*Home:* dashboard and personal work',
  '*Manufacturing:* Manufacture, Fusion AutoCAM, JProg, Files (plus optional/hidden shop tools)',
  '*Competition:* Strategy, Drive Team, Match Scouting, Pit Scouting, My Scout, Picklist, Match Rankings, Power Rankings, Robot Ratings, EPA, Vision Scouting, Prediction Market, Blue Alliance, and restricted Scouting Admin',
  '*CAD:* CAD, Build, and the shared Files browser',
  '*Purchasing:* requests, approvals, orders, budgets, and receiving',
  '*Account/Admin:* personal settings; Admin appears only for authorized users',
  'Use *Command/Ctrl+K* to find valid pages that are not pinned in your navigation.'
].join('\n');

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasAlias(question, alias) {
  const haystack = ` ${normalized(question)} `;
  const needle = ` ${normalized(alias)} `;
  return haystack.includes(needle);
}

function sectionMetadata(section) {
  const route = section.match(/\((\/[^)]+)\)/)?.[1] || null;
  const colon = section.indexOf(':');
  const parenthesis = section.indexOf(' (');
  const boundaries = [colon, parenthesis].filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : section.length;
  return { label: section.slice(0, end).trim(), route, description: colon >= 0 ? section.slice(colon + 1).trim() : section };
}

function absoluteHubUrl(route) {
  return `${HUB_ORIGIN}${route || '/'}`;
}

function formatSectionWithLink(section) {
  const metadata = sectionMetadata(section);
  if (!metadata.route || metadata.route.includes('{')) return section;
  return section.replace(
    `(${metadata.route})`,
    `(<${absoluteHubUrl(metadata.route)}|Open ${metadata.label}>)`
  );
}

function formatSubtabAnswer(feature, section) {
  const metadata = sectionMetadata(section);
  const route = metadata.route || feature.route;
  return [
    `*${metadata.label} — ${feature.name}*`,
    metadata.description,
    `*Location:* ${feature.location} → ${metadata.label}`,
    `*Open:* <${absoluteHubUrl(route)}|Open ${metadata.label}>`,
    '',
    `*Parent tab:* ${feature.summary}`
  ].join('\n');
}

export function answerHubFeatureQuestion(question) {
  const value = normalized(question);
  if (!value) return null;
  if (/\b(all|list|what|which)\b/.test(value) && /\b(tabs|pages|features|navigation)\b/.test(value)) {
    return `*Spartans Hub navigation:*\n${HUB_NAVIGATION_OVERVIEW}`;
  }
  const candidates = HUB_FEATURES
    .map((feature) => ({
      feature,
      score: feature.aliases.reduce((best, alias) => hasAlias(value, alias) ? Math.max(best, normalized(alias).length) : best, 0)
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const subtabCandidates = HUB_FEATURES.flatMap((feature) => feature.sections.map((section) => {
    const metadata = sectionMetadata(section);
    return { feature, section, metadata, matches: metadata.label.length >= 4 && hasAlias(value, metadata.label) };
  })).filter((candidate) => candidate.matches);
  const parentFeature = candidates[0]?.feature || null;
  const withinParent = parentFeature ? subtabCandidates.filter((candidate) => candidate.feature === parentFeature) : [];
  if (withinParent.length === 1) return formatSubtabAnswer(withinParent[0].feature, withinParent[0].section);
  const asksAboutSubtab = /\b(subtab|tab|section|screen|page|inside|within|find|where)\b/.test(value);
  if (!parentFeature && asksAboutSubtab && subtabCandidates.length === 1) {
    return formatSubtabAnswer(subtabCandidates[0].feature, subtabCandidates[0].section);
  }
  if (!parentFeature && asksAboutSubtab && subtabCandidates.length > 1) {
    const choices = [...new Set(subtabCandidates.map(({ feature, metadata }) => `${feature.name} → ${metadata.label}`))];
    return `That subtab name is ambiguous. Specify its parent tab: ${choices.slice(0, 6).join(', ')}.`;
  }
  if (!candidates.length) return null;
  const feature = candidates[0].feature;
  return [
    `*${feature.name}* — ${feature.location}`,
    feature.summary,
    '',
    '*What is there:*',
    ...feature.sections.map((section) => `• ${formatSectionWithLink(section)}`),
    '',
    feature.details,
    `*Open:* <${absoluteHubUrl(feature.route)}|Open ${feature.name}>`
  ].join('\n');
}
