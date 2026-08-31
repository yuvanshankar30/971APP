<script>
  import { onMount } from 'svelte';
  import { supabase, getAuthHeader } from '$lib/supabase.js';
  import { fetchActiveScoutingEventKey, fetchAvailableScoutingEvents } from '$lib/scoutingEvent.js';
  import SeasonFilter from '$lib/components/SeasonFilter.svelte';

  const DRIVEBASE_OPTIONS = ['Mechanum', 'Swerve', 'Tank'];
  const SHOOTER_OPTIONS = ['Single Fixed', 'Multi Fixed', 'Wide', 'Turret', 'Double Turret'];
  const HOPPER_OPTIONS = ['Spindexer', 'Dye Rotor', 'Belted'];
  const HUMAN_PLAYER_AUTO_OPTIONS = ['0-10', '10-20', '20+'];
  const ROBOT_ARCHETYPES = ['Shooter', 'Shuttler', 'Defender', 'Climber', 'Hybrid', 'Support / Feeder', 'Unknown'];
  const NO_CLIMB_OPTION = 'No Climb';
  const CLIMB_OPTIONS = [NO_CLIMB_OPTION, 'L1 Auto', 'L1', 'L2', 'L3'];
  const MAX_AUTO_OPTIONS = 8;
  const MAX_AUTO_NAME_LENGTH = 60;
  const MAX_AUTO_DESCRIPTION_LENGTH = 220;
  const MAX_BREAKING_COMPONENT_LENGTH = 240;
  const PIT_STATUS = Object.freeze({
    pending: { label: 'Pending', className: 'status-pending', sort: 0 },
    needs_photo: { label: 'Needs photo', className: 'status-needs-photo', sort: 1 },
    completed: { label: 'Completed', className: 'status-complete', sort: 2 }
  });
  const YES_NO_OPTIONS = ['Yes', 'No'];
  const INTAKE_STYLE_OPTIONS = ['Slapdown Intake', 'Linkage Intake', 'Other'];
  const MAIN_BREAKER_OPTIONS = ['Bussmann', 'OptiFuse', 'Other'];
  const SB_CONNECTOR_OPTIONS = ['SB60', 'SB40', 'Other'];
  const WIRE_INSULATION_OPTIONS = ['Silicone', 'Other'];
  const ELECTRICAL_CONNECTOR_OPTIONS = [
    'Molex SL CAN',
    'WAGO CAN',
    'WAGO Power',
    'Anderson Power',
    'Ring Terminal Power',
    'Ring Terminal CAN',
    'Non-locking CAN',
    'WCP Powerpole Board',
    'Custom Powerpole Board',
    'Custom PCBs',
    'Other'
  ];
  const BATTERY_OPTIONS = ['Energizer', 'Duracell', 'MK Battery', 'Other'];
  const MOTOR_CONTROLLER_OPTIONS = ['Talon FX', 'Victor SPX', 'Spark MAX', 'Redux', 'Thrifty'];
  const MOTOR_TYPE_OPTIONS = ['X60', 'X44', '550', 'Vortex', 'Thrifty', 'CIM'];
  const AUTO_TOOL_OPTIONS = ['Bline', 'PathPlanner', 'Choreo', 'Custom'];
  const VISION_OPTIONS = ['PhotonVision', 'Limelight', 'Custom'];
  const COPROCESSOR_OPTIONS = ['Orin', 'Limelight', 'Orange Pi', 'Raspberry Pi', 'Mac Mini', 'Other'];
  const PROGRAMMING_LANGUAGE_OPTIONS = ['Java', 'C++', 'Python'];
  const GRIP_TAPE_OPTIONS = ['Cat Tongue', 'Silicone', 'Other'];
  const SWERVE_MODULE_OPTIONS = [
    'MK5n',
    'MK5i',
    'MK4i',
    'MK4n',
    'MK4',
    'WCP X2i',
    'X2t',
    'X2c',
    'X2',
    'ThriftySwerve',
    'Other'
  ];
  const HOPPER_WALL_OPTIONS = ['Reinforced Corners', 'Polycarbonate Flanges', 'Other'];
  const BUMPER_FOAM_OPTIONS = ['Pool Noodle', 'EVA', 'XPE', 'Other'];
  const HARDWARE_STANDARD_OPTIONS = ['E-clip', 'Metric Fasteners', 'Metric Bearings'];
  const ENCODER_TYPE_OPTIONS = ['PWM', 'CAN Through Bore', 'Other'];
  const TECHNICAL_MULTI_FIELD_OPTIONS = {
    electrical_connectors: ELECTRICAL_CONNECTOR_OPTIONS,
    motor_controllers: MOTOR_CONTROLLER_OPTIONS,
    motor_types: MOTOR_TYPE_OPTIONS,
    auto_tools: AUTO_TOOL_OPTIONS,
    vision: VISION_OPTIONS,
    programming_language: PROGRAMMING_LANGUAGE_OPTIONS,
    hardware_standards: HARDWARE_STANDARD_OPTIONS,
    encoder_types: ENCODER_TYPE_OPTIONS
  };
  const TECHNICAL_SINGLE_FIELD_OPTIONS = {
    use_net: YES_NO_OPTIONS,
    intake_style: INTAKE_STYLE_OPTIONS,
    main_breaker_brand: MAIN_BREAKER_OPTIONS,
    sb_connector: SB_CONNECTOR_OPTIONS,
    main_breaker_shroud: YES_NO_OPTIONS,
    wire_insulation: WIRE_INSULATION_OPTIONS,
    battery_type: BATTERY_OPTIONS,
    ground_intake_kicker: YES_NO_OPTIONS,
    uses_canivore: YES_NO_OPTIONS,
    coprocessor: COPROCESSOR_OPTIONS,
    uses_wpilib: YES_NO_OPTIONS,
    grip_tape: GRIP_TAPE_OPTIONS,
    swerve_module: SWERVE_MODULE_OPTIONS,
    hopper_wall_reinforcement: HOPPER_WALL_OPTIONS,
    fits_under_trench: YES_NO_OPTIONS,
    drives_over_mound: YES_NO_OPTIONS,
    bumper_foam: BUMPER_FOAM_OPTIONS,
    printed_roller_hubs: YES_NO_OPTIONS
  };
  const DEFAULT_TECHNICAL_DETAILS = Object.freeze({
    use_net: '',
    intake_style: '',
    ground_roller_motor_count: undefined,
    bumper_length: undefined,
    bumper_width: undefined,
    bumper_height: undefined,
    main_breaker_brand: '',
    sb_connector: '',
    main_breaker_shroud: '',
    mostly_used_wire_gauge: '',
    wire_insulation: '',
    electrical_connectors: [],
    battery_type: '',
    ground_intake_kicker: '',
    motor_controllers: [],
    motor_types: [],
    uses_canivore: '',
    can_bus_count: undefined,
    auto_tools: [],
    vision: [],
    coprocessor: '',
    programming_language: [],
    uses_wpilib: '',
    software_other: '',
    grip_tape: '',
    swerve_module: '',
    hopper_wall_reinforcement: '',
    fits_under_trench: '',
    drives_over_mound: '',
    drivebase_tube_thickness: '',
    drivetrain_length: undefined,
    drivetrain_width: undefined,
    drivetrain_height: undefined,
    bumper_foam: '',
    hardware_standards: [],
    encoder_types: [],
    printed_roller_hubs: '',
    roller_hub_material: '',
    electrical_rating: undefined,
    drivebase_rating: undefined,
    overall_reliability_rating: undefined
  });

  let eventKey = ''; // globally active scouting event - writes always target this
  let selectedEventKey = null; // event being browsed for reading, if different from active
  let availableEvents = [];
  let lastLoadedEventKeyForTeams = null;

  // Reads (team roster, pit entries) use this so a lead can browse a past
  // event's pit data. Saves intentionally keep targeting the active eventKey
  // below, not this - see saveEntry().
  $: resolvedEventKey = selectedEventKey || eventKey;
  $: isViewingPastEvent = !!selectedEventKey && selectedEventKey !== eventKey;

  let loading = false;
  let saving = false;
  let uploading = false;
  let apiNote = '';
  let activeView = 'teams';
  let problems = [];
  let problemsError = '';
  let problemLoading = false;
  let problemSaving = false;
  let problemDraft = { team_key: '', summary: '', detail: '', severity: 'watch' };

  let teams = [];
  let entriesByTeam = {};
  let selectedTeam = '';
  let teamSearch = '';
  let pitContacts = [];
  let scout_name = '';

  let drivebase_type = '';
  let shooter_type = '';
  let hopper_type = '';
  let human_player_balls_in_auto = '';
  let pitSchema = {
    scout_name: true,
    robot_archetype: true,
    additional_notes: true,
    likely_breaking_component: true,
    estimated_bps: true,
    climb_options: true,
    auto_options: true,
    technical_details: true
  };
  let schemaWarning = '';
  let robot_archetype = '';
  let additional_notes = '';
  let likely_breaking_component = '';
  let estimated_bps = undefined;
  let climb_options = [];
  let autoOptions = [];
  let technical_details = createDefaultTechnicalDetails();
  let editablePhotoPaths = [];
  let pendingFiles = [];
  // Pit scouting is done standing in a noisy pit with a phone in one hand,
  // talking to a team that volunteers information in whatever order it likes.
  // A single 600-line scroll of ~40 selects is the wrong shape for that: you
  // cannot tell what is still missing, and you cannot jump to the thing the
  // team just mentioned. Topics are answered one at a time, jumpable in any
  // order, with the remaining count always visible so a scout knows when they
  // can walk away.
  const TOPICS = [
    { id: 'basics', label: 'Basics' },
    { id: 'mechanisms', label: 'Mechanisms' },
    { id: 'electrical', label: 'Electrical' },
    { id: 'controls', label: 'Controls' },
    { id: 'structure', label: 'Structure' },
    { id: 'ratings', label: 'Ratings' },
    { id: 'photos', label: 'Photos' }
  ];

  // Which answers belong to which topic, for the per-topic counts. Kept
  // explicit rather than derived from the markup so a field moving between
  // topics is a deliberate edit, not a silent change in what "complete" means.
  const TOPIC_FIELDS = {
    mechanisms: ['use_net', 'intake_style', 'ground_roller_motor_count'],
    electrical: ['main_breaker_brand', 'sb_connector', 'main_breaker_shroud'],
    controls: ['uses_canivore', 'can_bus_count', 'coprocessor', 'uses_wpilib', 'software_other'],
    structure: ['swerve_module', 'drivetrain_length', 'drivetrain_width', 'drivetrain_height', 'bumper_width', 'bumper_height', 'bumper_length', 'bumper_foam', 'fits_under_trench', 'drives_over_mound', 'printed_roller_hubs', 'roller_hub_material'],
    ratings: ['drivebase_rating', 'electrical_rating', 'overall_reliability_rating']
  };

  let activeTopic = 'basics';

  const answered = (value) =>
    Array.isArray(value) ? value.length > 0 : value !== '' && value !== null && value !== undefined;

  function topicProgress(topicId, details, core, climb, autos, photos, pending) {
    if (topicId === 'basics') {
      const values = [core.scout_name, core.drivebase_type, core.shooter_type, core.hopper_type, core.human_player_balls_in_auto, climb, autos];
      return { done: values.filter(answered).length, total: values.length };
    }
    if (topicId === 'photos') {
      return { done: photos.length + pending.length ? 1 : 0, total: 1 };
    }
    if (topicId === 'ratings') {
      const keys = TOPIC_FIELDS.ratings;
      const values = [...keys.map((key) => details[key]), core.estimated_bps, core.likely_breaking_component];
      return { done: values.filter(answered).length, total: values.length };
    }
    const keys = TOPIC_FIELDS[topicId] || [];
    return { done: keys.filter((key) => answered(details[key])).length, total: keys.length };
  }

  $: coreAnswers = {
    scout_name,
    drivebase_type, shooter_type, hopper_type, human_player_balls_in_auto,
    estimated_bps, likely_breaking_component
  };
  $: topicStates = TOPICS.map((topic) => ({
    ...topic,
    ...topicProgress(topic.id, technical_details, coreAnswers, climb_options, autoOptions, editablePhotoPaths, pendingFiles)
  }));
  $: answeredTotal = topicStates.reduce((sum, topic) => sum + topic.done, 0);
  $: questionTotal = topicStates.reduce((sum, topic) => sum + topic.total, 0);
  $: remaining = Math.max(0, questionTotal - answeredTotal);

  let photoInputKey = 0;
  let photoInput;
  let prefersCameraCapture = false;

  function normalizeAutoOptions(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, MAX_AUTO_OPTIONS).map((option) => ({
      name: String(option?.name || '').trim().slice(0, MAX_AUTO_NAME_LENGTH),
      description: String(option?.description || '').trim().slice(0, MAX_AUTO_DESCRIPTION_LENGTH)
    }));
  }

  function getFilledAutoOptions(input) {
    return normalizeAutoOptions(input).filter((option) => option.name || option.description);
  }

  function normalizeClimbOptions(input) {
    if (!Array.isArray(input)) return [];
    const selected = new Set(
      input
        .map((option) => String(option || '').trim())
        .filter((option) => CLIMB_OPTIONS.includes(option))
    );
    if (selected.has(NO_CLIMB_OPTION)) return [NO_CLIMB_OPTION];
    return CLIMB_OPTIONS.filter((option) => option !== NO_CLIMB_OPTION && selected.has(option));
  }

  function createDefaultTechnicalDetails() {
    return Object.fromEntries(
      Object.entries(DEFAULT_TECHNICAL_DETAILS).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
    );
  }

  function normalizeTechnicalNumber(value, { min = 0, max = null, integer = false } = {}) {
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || (max !== null && parsed > max)) return undefined;
    return integer ? Math.round(parsed) : Math.round(parsed * 1000) / 1000;
  }

  function normalizeTechnicalDetails(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const normalized = createDefaultTechnicalDetails();

    for (const [field, options] of Object.entries(TECHNICAL_SINGLE_FIELD_OPTIONS)) {
      const value = String(source[field] || '').trim();
      normalized[field] = options.includes(value) ? value : '';
    }

    for (const [field, options] of Object.entries(TECHNICAL_MULTI_FIELD_OPTIONS)) {
      const selected = new Set(Array.isArray(source[field]) ? source[field].map((value) => String(value || '').trim()) : []);
      normalized[field] = options.filter((option) => selected.has(option));
    }

    normalized.mostly_used_wire_gauge = String(source.mostly_used_wire_gauge || '').trim().slice(0, 80);
    normalized.drivebase_tube_thickness = String(source.drivebase_tube_thickness || '').trim().slice(0, 80);
    normalized.roller_hub_material = String(source.roller_hub_material || '').trim().slice(0, 80);
    normalized.software_other = String(source.software_other || '').trim().slice(0, 240);

    normalized.ground_roller_motor_count = normalizeTechnicalNumber(source.ground_roller_motor_count, { integer: true });
    normalized.bumper_length = normalizeTechnicalNumber(source.bumper_length);
    normalized.bumper_width = normalizeTechnicalNumber(source.bumper_width);
    normalized.bumper_height = normalizeTechnicalNumber(source.bumper_height);
    normalized.drivetrain_length = normalizeTechnicalNumber(source.drivetrain_length);
    normalized.drivetrain_width = normalizeTechnicalNumber(source.drivetrain_width);
    normalized.drivetrain_height = normalizeTechnicalNumber(source.drivetrain_height);
    normalized.can_bus_count = normalizeTechnicalNumber(source.can_bus_count, { integer: true });
    normalized.electrical_rating = normalizeTechnicalNumber(source.electrical_rating, { min: 1, max: 10, integer: true });
    normalized.drivebase_rating = normalizeTechnicalNumber(source.drivebase_rating, { min: 1, max: 10, integer: true });
    normalized.overall_reliability_rating = normalizeTechnicalNumber(source.overall_reliability_rating, {
      min: 1,
      max: 10,
      integer: true
    });

    return normalized;
  }

  function setClimbOption(option, checked) {
    if (option === NO_CLIMB_OPTION) {
      climb_options = checked ? [NO_CLIMB_OPTION] : [];
      return;
    }

    const selected = new Set(normalizeClimbOptions(climb_options));
    selected.delete(NO_CLIMB_OPTION);
    if (checked) selected.add(option);
    else selected.delete(option);
    climb_options = CLIMB_OPTIONS.filter((value) => value !== NO_CLIMB_OPTION && selected.has(value));
  }

  function setTechnicalMulti(field, option, checked) {
    const allowed = TECHNICAL_MULTI_FIELD_OPTIONS[field] || [];
    const selected = new Set(Array.isArray(technical_details[field]) ? technical_details[field] : []);
    if (checked) selected.add(option);
    else selected.delete(option);
    technical_details = {
      ...technical_details,
      [field]: allowed.filter((value) => selected.has(value))
    };
  }

  function hasTechnicalMulti(field, option) {
    return Array.isArray(technical_details[field]) && technical_details[field].includes(option);
  }

  function normalizeLikelyBreakingComponent(value) {
    return String(value || '').trim().slice(0, MAX_BREAKING_COMPONENT_LENGTH);
  }

  function hasEstimatedBps(value) {
    return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function displayTeam(teamKey) {
    return teamKey ? String(teamKey).replace(/^frc/i, '') : '';
  }

  function teamSort(a, b) {
    const an = Number(displayTeam(a));
    const bn = Number(displayTeam(b));
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return String(a).localeCompare(String(b));
  }

  function teamListSort(a, b) {
    const aStatus = getPitScoutStatus(entriesByTeam[a]);
    const bStatus = getPitScoutStatus(entriesByTeam[b]);
    if (aStatus !== bStatus) return PIT_STATUS[aStatus].sort - PIT_STATUS[bStatus].sort;
    return teamSort(a, b);
  }

  function hasAnyPitData(entry) {
    if (!entry) return false;
    const technicalDetails = entry.technical_details && typeof entry.technical_details === 'object'
      ? entry.technical_details
      : {};
    return Boolean(
      entry.drivebase_type &&
      String(entry.drivebase_type).trim() ||
      entry.shooter_type &&
      String(entry.shooter_type).trim() ||
      entry.hopper_type &&
      String(entry.hopper_type).trim() ||
      entry.human_player_balls_in_auto &&
      String(entry.human_player_balls_in_auto).trim() ||
      String(entry.robot_archetype || '').trim() ||
      String(entry.additional_notes || '').trim() ||
      normalizeLikelyBreakingComponent(entry.likely_breaking_component) ||
      hasEstimatedBps(entry.estimated_bps) ||
      normalizeClimbOptions(entry.climb_options).length ||
      getFilledAutoOptions(entry.auto_options).length ||
      Object.values(technicalDetails).some((value) => (
        Array.isArray(value)
          ? value.filter(Boolean).length
          : value !== '' && value !== null && value !== undefined
      ))
    );
  }

  function getPitScoutStatus(entry) {
    if (!hasAnyPitData(entry)) return 'pending';
    const photoPaths = Array.isArray(entry?.photo_paths) ? entry.photo_paths.filter(Boolean) : [];
    return photoPaths.length ? 'completed' : 'needs_photo';
  }

  function getPitScoutStatusLabel(entry) {
    return PIT_STATUS[getPitScoutStatus(entry)].label;
  }

  function getPitScoutStatusClass(entry) {
    return PIT_STATUS[getPitScoutStatus(entry)].className;
  }

  function photoUrl(path) {
    if (!path) return '';
    return supabase.storage.from('pit-scout-photos').getPublicUrl(path)?.data?.publicUrl || '';
  }

  function applyTeamEntry(teamKey) {
    const entry = entriesByTeam[teamKey] || null;
    scout_name = entry?.scout_name || '';
    drivebase_type = entry?.drivebase_type || '';
    shooter_type = entry?.shooter_type || '';
    hopper_type = entry?.hopper_type || '';
    human_player_balls_in_auto = entry?.human_player_balls_in_auto || '';
    robot_archetype = ROBOT_ARCHETYPES.includes(entry?.robot_archetype) ? entry.robot_archetype : '';
    additional_notes = String(entry?.additional_notes || '');
    likely_breaking_component = entry?.likely_breaking_component || '';
    estimated_bps = hasEstimatedBps(entry?.estimated_bps) ? Number(entry.estimated_bps) : undefined;
    climb_options = normalizeClimbOptions(entry?.climb_options || []);
    autoOptions = normalizeAutoOptions(entry?.auto_options || []);
    technical_details = normalizeTechnicalDetails(entry?.technical_details || {});
    editablePhotoPaths = [...(entry?.photo_paths || [])];
    pendingFiles = [];
    photoInputKey += 1;
  }

  function syncSelectedTeam() {
    if (!teams.length) {
      selectedTeam = '';
      return;
    }

    if (selectedTeam && teams.includes(selectedTeam)) {
      applyTeamEntry(selectedTeam);
      return;
    }

    selectedTeam = '';
  }

  async function authFetch(url, options = {}) {
    const headers = {
      ...(options.headers || {}),
      ...(await getAuthHeader())
    };
    return fetch(url, { ...options, headers });
  }

  async function loadTeams() {
    if (!resolvedEventKey) {
      return [];
    }

    const [eventTeamsRes, eventMatchesRes] = await Promise.all([
      fetch(`/api/tba/event-teams?event_key=${encodeURIComponent(resolvedEventKey)}`).catch(() => null),
      fetch(`/api/tba/event-matches?event_key=${encodeURIComponent(resolvedEventKey)}&comp_level=qm`).catch(() => null)
    ]);

    const [eventTeamsData, eventMatchesData] = await Promise.all([
      eventTeamsRes?.json().catch(() => null),
      eventMatchesRes?.json().catch(() => null)
    ]);

    const set = new Set();

    for (const row of eventTeamsData?.success ? eventTeamsData.data || [] : []) {
      if (row?.key) set.add(row.key);
    }

    for (const match of eventMatchesData?.success ? eventMatchesData.data || [] : []) {
      for (const teamKey of match?.alliances?.red?.team_keys || []) set.add(teamKey);
      for (const teamKey of match?.alliances?.blue?.team_keys || []) set.add(teamKey);
    }

    if (!set.size && !eventTeamsData?.success && !eventMatchesData?.success) {
      const error = eventTeamsData?.error || eventMatchesData?.error || 'Failed to load event teams.';
      throw new Error(error);
    }

    return [...set].sort(teamSort);
  }

  async function loadEntries() {
    if (!resolvedEventKey) {
      entriesByTeam = {};
      return {};
    }

    const res = await authFetch(`/pitscout?event_key=${encodeURIComponent(resolvedEventKey)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `Failed to load pit entries (${res.status})`);
    }

    pitSchema = {
      ...pitSchema,
      ...(data?.meta?.schema || {})
    };
    schemaWarning = data?.meta?.warning || '';

    const next = {};
    for (const row of data.data || []) {
      if (row?.team_key) next[row.team_key] = row;
    }
    entriesByTeam = next;
    return next;
  }

  async function loadPitContacts() {
    const res = await authFetch('/pitscout?resource=pit-contacts');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return [];
    pitContacts = data.data || [];
    return pitContacts;
  }

  async function loadProblems() {
    if (!resolvedEventKey) {
      problems = [];
      return [];
    }
    problemLoading = true;
    problemsError = '';
    try {
      const res = await authFetch(`/api/matchscout?resource=pit-problems&event_key=${encodeURIComponent(resolvedEventKey)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || `Failed to load pit problems (${res.status})`);
      problems = data.data || [];
      return problems;
    } catch (e) {
      problems = [];
      problemsError = e.message || 'Failed to load pit problems';
      return [];
    } finally {
      problemLoading = false;
    }
  }

  async function createProblem() {
    if (!eventKey || !problemDraft.team_key || !problemDraft.summary.trim() || isViewingPastEvent) return;
    problemSaving = true;
    apiNote = '';
    try {
      const res = await authFetch('/api/matchscout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'report-pit-problem',
          event_key: eventKey,
          team_key: problemDraft.team_key,
          source: 'Pit scout',
          summary: problemDraft.summary,
          detail: problemDraft.detail,
          severity: problemDraft.severity
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || `Problem save failed (${res.status})`);
      problemDraft = { team_key: '', summary: '', detail: '', severity: 'watch' };
      await loadProblems();
      apiNote = 'Pit problem added to the shared queue.';
    } catch (e) {
      apiNote = e.message || 'Problem save failed';
    } finally {
      problemSaving = false;
    }
  }

  async function setProblemResolved(problem, resolved) {
    problemSaving = true;
    apiNote = '';
    try {
      const res = await authFetch('/api/matchscout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resolve-pit-problem', id: problem.id, resolved })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || `Problem update failed (${res.status})`);
      problems = problems.map((row) => row.id === problem.id ? data.data : row);
    } catch (e) {
      apiNote = e.message || 'Problem update failed';
    } finally {
      problemSaving = false;
    }
  }

  async function loadEventOptions() {
    eventKey = (await fetchActiveScoutingEventKey()) || '';
    availableEvents = await fetchAvailableScoutingEvents();
  }

  async function loadAll() {
    loading = true;
    apiNote = '';

    try {
      if (!resolvedEventKey) {
        teams = [];
        entriesByTeam = {};
        selectedTeam = '';
        schemaWarning = '';
        apiNote = 'No event configured.';
        return;
      }

      const [loadedTeams, loadedEntries] = await Promise.all([loadTeams(), loadEntries(), loadProblems(), loadPitContacts()]);
      teams = [...new Set([...loadedTeams, ...Object.keys(loadedEntries)])].sort(teamSort);
      syncSelectedTeam();
    } catch (e) {
      apiNote = e.message || 'Load error';
    } finally {
      loading = false;
    }
  }

  function scrollToTop() {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function openEntry(teamKey) {
    if (!teamKey) return;
    selectedTeam = teamKey;
    teamSearch = '';
    applyTeamEntry(teamKey);
    scrollToTop();
  }

  function goToTeamPicker() {
    selectedTeam = '';
    teamSearch = '';
    scrollToTop();
  }

  function handleTeamSearchInput(event) {
    const digitsOnly = String(event.currentTarget?.value || '').replace(/\D/g, '').slice(0, 6);
    teamSearch = digitsOnly;

    if (!digitsOnly) return;

    const exactMatch = teams.find((teamKey) => displayTeam(teamKey) === digitsOnly);
    if (exactMatch) openEntry(exactMatch);
  }

  function sanitizeFileName(name) {
    return String(name || 'photo').replace(/[^A-Za-z0-9._-]/g, '_');
  }

  function openPhotoPicker() {
    if (!photoSlotsRemaining) return;
    photoInput?.click();
  }

  function onFilesSelected(event) {
    const files = Array.from(event.currentTarget?.files || []);
    const slotsRemaining = Math.max(0, 3 - editablePhotoPaths.length - pendingFiles.length);

    if (!files.length || !slotsRemaining) {
      photoInputKey += 1;
      return;
    }

    pendingFiles = [...pendingFiles, ...files.slice(0, slotsRemaining)];
    photoInputKey += 1;
  }

  function removeExistingPhoto(path) {
    editablePhotoPaths = editablePhotoPaths.filter((photoPath) => photoPath !== path);
  }

  function removePendingPhoto(idx) {
    pendingFiles = pendingFiles.filter((_, i) => i !== idx);
  }

  function addAutoOption() {
    if (autoOptions.length >= MAX_AUTO_OPTIONS) return;
    autoOptions = [...autoOptions, { name: '', description: '' }];
  }

  function updateAutoOption(idx, field, value) {
    autoOptions = autoOptions.map((option, i) => (
      i === idx
        ? {
            ...option,
            [field]: String(value || '').slice(
              0,
              field === 'name' ? MAX_AUTO_NAME_LENGTH : MAX_AUTO_DESCRIPTION_LENGTH
            )
          }
        : option
    ));
  }

  function removeAutoOption(idx) {
    autoOptions = autoOptions.filter((_, i) => i !== idx);
  }

  async function uploadPendingPhotos(teamKey) {
    if (!pendingFiles.length) return [];

    uploading = true;
    const uploadedPaths = [];

    try {
      for (let i = 0; i < pendingFiles.length; i += 1) {
        const file = pendingFiles[i];
        const fileName = `${Date.now()}-${i}-${sanitizeFileName(file.name)}`;
        const path = `${eventKey}/${teamKey}/${fileName}`;

        const { error } = await supabase.storage
          .from('pit-scout-photos')
          .upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' });

        if (error) throw new Error(error.message || 'Upload failed');
        uploadedPaths.push(path);
      }

      return uploadedPaths;
    } finally {
      uploading = false;
    }
  }

  async function saveEntry() {
    if (!selectedTeam || !eventKey) return;

    const normalizedLikelyBreakingComponent = normalizeLikelyBreakingComponent(likely_breaking_component);
    const normalizedEstimatedBps = hasEstimatedBps(estimated_bps) ? Math.round(Number(estimated_bps) * 100) / 100 : null;
    const normalizedClimbOptions = normalizeClimbOptions(climb_options);
    const normalizedTechnicalDetails = normalizeTechnicalDetails(technical_details);

    const normalizedAutoOptions = getFilledAutoOptions(autoOptions);
    if (normalizedAutoOptions.some((option) => !option.name || !option.description)) {
      alert('Each auto option needs both a name and description.');
      return;
    }

    if (editablePhotoPaths.length + pendingFiles.length > 3) {
      alert('You can only save up to 3 photos.');
      return;
    }

    saving = true;
    apiNote = '';

    try {
      const uploadedPaths = await uploadPendingPhotos(selectedTeam);
      const photo_paths = [...editablePhotoPaths, ...uploadedPaths].slice(0, 3);
      const payload = {
        action: 'save-entry',
        event_key: eventKey,
        team_key: selectedTeam,
        ...(pitSchema.scout_name ? { scout_name: String(scout_name || '').trim() } : {}),
        drivebase_type,
        shooter_type,
        hopper_type,
        human_player_balls_in_auto,
        ...(pitSchema.robot_archetype ? { robot_archetype } : {}),
        ...(pitSchema.additional_notes ? { additional_notes } : {}),
        ...(pitSchema.likely_breaking_component
          ? { likely_breaking_component: normalizedLikelyBreakingComponent }
          : {}),
        ...(pitSchema.estimated_bps ? { estimated_bps: normalizedEstimatedBps } : {}),
        ...(pitSchema.climb_options ? { climb_options: normalizedClimbOptions } : {}),
        ...(pitSchema.auto_options ? { auto_options: normalizedAutoOptions } : {}),
        ...(pitSchema.technical_details ? { technical_details: normalizedTechnicalDetails } : {}),
        photo_paths
      };

      const res = await authFetch('/pitscout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Save failed (${res.status})`);
      }

      pitSchema = {
        ...pitSchema,
        ...(data?.meta?.schema || {})
      };
      schemaWarning = data?.meta?.warning || schemaWarning;
      entriesByTeam[selectedTeam] = data.data;
      entriesByTeam = { ...entriesByTeam };
      apiNote = `Saved pit data for Team ${displayTeam(selectedTeam)}.`;
      goToTeamPicker();
    } catch (e) {
      apiNote = e.message || 'Save failed';
    } finally {
      saving = false;
    }
  }

  function detectCameraCapturePreference() {
    if (typeof navigator === 'undefined') return false;
    const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent || ''
    );
    return Boolean(navigator.userAgentData?.mobile || mobileUserAgent);
  }

  $: pitStatusCounts = teams.reduce(
    (counts, teamKey) => {
      const status = getPitScoutStatus(entriesByTeam[teamKey]);
      counts[status] += 1;
      return counts;
    },
    { pending: 0, needs_photo: 0, completed: 0 }
  );
  $: pendingCount = pitStatusCounts.pending;
  $: needsPhotoCount = pitStatusCounts.needs_photo;
  $: completeCount = pitStatusCounts.completed;
  $: filteredTeams = teams
    .filter((teamKey) => !teamSearch || displayTeam(teamKey).includes(teamSearch))
    .sort(teamListSort);
  $: selectedEntry = selectedTeam ? entriesByTeam[selectedTeam] || null : null;
  $: photoSlotsRemaining = Math.max(0, 3 - editablePhotoPaths.length - pendingFiles.length);
  $: photoButtonLabel = prefersCameraCapture ? 'Take Photo' : 'Add Photos';
  $: openProblems = problems.filter((problem) => !problem.resolved);
  $: resolvedProblems = problems.filter((problem) => problem.resolved);
  $: problemsByTeam = openProblems.reduce((map, report) => {
    (map[report.team_key] ||= []).push(report);
    return map;
  }, {});
  $: selectedTeamProblems = selectedTeam ? (problemsByTeam[selectedTeam] || []) : [];

  onMount(() => {
    prefersCameraCapture = detectCameraCapturePreference();
    loadEventOptions();
  });

  // Re-fetch teams/entries whenever the resolved (browsed) event changes -
  // covers both the initial async load of the active event key and the user
  // switching the event dropdown afterward.
  $: {
    if (resolvedEventKey !== lastLoadedEventKeyForTeams) {
      lastLoadedEventKeyForTeams = resolvedEventKey;
      loadAll();
    }
  }
</script>

<div class="page-header card">
  <div>
    <h2 style="margin:0">Pit Scouting</h2>
    {#if resolvedEventKey}
      <div class="form-label" style="margin-top:0.25rem">Event: {resolvedEventKey}</div>
    {/if}
    {#if apiNote}
      <div class="note" style="margin-top:0.5rem">{apiNote}</div>
    {/if}
    {#if schemaWarning}
      <div class="note" style="margin-top:0.5rem">{schemaWarning}</div>
    {/if}
  </div>

  <div class="page-summary">
    <SeasonFilter
      options={availableEvents}
      bind:value={selectedEventKey}
      allLabel={`Current Event (${eventKey || 'none set'})`}
    />
    <div class="summary-pill">
      <span>Pending</span>
      <strong>{pendingCount}</strong>
    </div>
    <div class="summary-pill">
      <span>Needs photo</span>
      <strong>{needsPhotoCount}</strong>
    </div>
    <div class="summary-pill">
      <span>Completed</span>
      <strong>{completeCount}</strong>
    </div>
    <button class="btn btn-secondary" type="button" on:click={loadAll} disabled={loading}>
      Refresh
    </button>
  </div>
</div>

<div class="view-tabs" aria-label="Pit Scouting sections">
  <button class:active={activeView === 'teams'} type="button" on:click={() => activeView = 'teams'}>Team profiles</button>
  <button class:active={activeView === 'problems'} type="button" on:click={() => activeView = 'problems'}>
    Problems {#if openProblems.length}<span>{openProblems.length}</span>{/if}
  </button>
</div>

{#if activeView === 'problems'}
  <div class="problems-layout">
    <section class="card problem-queue">
      <div class="problem-heading">
        <div><h3>Shared repair queue</h3><p>Problems reported by match and pit scouts for {resolvedEventKey || 'the active event'}.</p></div>
        <button class="btn btn-secondary" type="button" on:click={loadProblems} disabled={problemLoading}>Refresh</button>
      </div>

      {#if problemLoading}
        <div class="empty">Loading problems...</div>
      {:else if !problems.length}
        <div class="empty">No pit problems reported for this event.</div>
      {:else if !openProblems.length}
        <div class="empty">No open pit problems for this event.</div>
      {:else}
        <div class="problem-list">
          {#each openProblems as problem (problem.id)}
            <article class="problem-card" class:urgent={problem.severity === 'urgent'}>
              <div class="problem-meta">
                <strong>Team {displayTeam(problem.team_key)}</strong>
                <span class="severity">{problem.severity}</span>
                <span>{problem.source || 'Scout'}</span>
                {#if problem.match_key}<span>{problem.match_key}</span>{/if}
              </div>
              <h4>{problem.summary}</h4>
              {#if problem.detail}<p>{problem.detail}</p>{/if}
              <button class="btn btn-primary" type="button" disabled={problemSaving} on:click={() => setProblemResolved(problem, true)}>Mark resolved</button>
            </article>
          {/each}
        </div>
      {/if}

      {#if resolvedProblems.length}
        <details class="resolved-problems">
          <summary>Resolved problems ({resolvedProblems.length})</summary>
          {#each resolvedProblems as problem (problem.id)}
            <div class="resolved-row">
              <span>Team {displayTeam(problem.team_key)} · {problem.summary}</span>
              <button class="btn btn-outline" type="button" disabled={problemSaving} on:click={() => setProblemResolved(problem, false)}>Reopen</button>
            </div>
          {/each}
        </details>
      {/if}
    </section>

    <form class="card problem-form" on:submit|preventDefault={createProblem}>
      <h3>Add a pit report</h3>
      {#if isViewingPastEvent}<div class="note">Switch to the current event before adding a problem.</div>{/if}
      <div class="form-group">
        <label class="form-label" for="problemTeam">Team</label>
        <select id="problemTeam" class="form-select" bind:value={problemDraft.team_key} disabled={isViewingPastEvent}>
          <option value="">-- Select --</option>
          {#each teams as teamKey}<option value={teamKey}>Team {displayTeam(teamKey)}</option>{/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="problemSummary">Problem</label>
        <input id="problemSummary" class="form-input" maxlength="300" bind:value={problemDraft.summary} placeholder="Example: intake belt slipping" disabled={isViewingPastEvent} />
      </div>
      <div class="form-group">
        <label class="form-label" for="problemSeverity">Severity</label>
        <select id="problemSeverity" class="form-select" bind:value={problemDraft.severity} disabled={isViewingPastEvent}>
          <option value="watch">Watch</option><option value="urgent">Urgent</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="problemDetail">Details</label>
        <textarea id="problemDetail" class="form-input" rows="5" bind:value={problemDraft.detail} placeholder="What failed and what should be checked?" disabled={isViewingPastEvent}></textarea>
      </div>
      <button class="btn btn-primary" type="submit" disabled={problemSaving || isViewingPastEvent || !problemDraft.team_key || !problemDraft.summary.trim()}>
        {problemSaving ? 'Saving...' : 'Add problem'}
      </button>
    </form>
  </div>
{:else if !selectedTeam}
  <div class="card picker-card">
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label" for="teamSearch">Team</label>
      <input
        id="teamSearch"
        class="form-input team-search"
        type="text"
        inputmode="numeric"
        pattern="[0-9]*"
        autocomplete="off"
        enterkeyhint="go"
        placeholder="Type team number"
        value={teamSearch}
        on:input={handleTeamSearchInput}
      />
    </div>

    {#if loading}
      <div class="empty">Loading teams...</div>
    {:else if !teams.length}
      <div class="empty">No teams loaded for this event.</div>
    {:else if !filteredTeams.length}
      <div class="empty">No teams match Team {teamSearch}.</div>
    {:else}
      <div class="team-list">
        {#each filteredTeams as teamKey}
          <button class="team-row" type="button" on:click={() => openEntry(teamKey)}>
            <span class="team-row-main">Team {displayTeam(teamKey)}</span>
            {#if (problemsByTeam[teamKey] || []).length}
              <span
                class="problem-flag"
                class:urgent={problemsByTeam[teamKey].some((report) => report.severity === 'urgent')}
              >
                {problemsByTeam[teamKey].length} to inspect
              </span>
            {/if}
            <span class={getPitScoutStatusClass(entriesByTeam[teamKey])}>{getPitScoutStatusLabel(entriesByTeam[teamKey])}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <form class="card entry-card" on:submit|preventDefault={saveEntry}>
    <div class="entry-header">
      <button class="btn btn-secondary" type="button" on:click={goToTeamPicker}>Back</button>

      <div>
        <h3 style="margin:0">Team {displayTeam(selectedTeam)}</h3>
        <div class="entry-subtitle">
          {#if selectedEntry}
            Existing pit entry loaded. Submitting again will update it.
          {:else}
            New pit entry.
          {/if}
        </div>
      </div>
      <button
        class="btn btn-outline entry-photo-action"
        type="button"
        on:click={() => (activeTopic = 'photos')}
      >
        {editablePhotoPaths.length + pendingFiles.length ? 'Manage photos' : 'Add photos'}
      </button>
    </div>

    {#if isViewingPastEvent}
      <div class="note">
        Viewing past event {selectedEventKey}. This form shows that event's pit data, but submitting will
        save under the active event ({eventKey || 'none set'}) instead — switch back to "Current Event" to
        edit this team's live pit entry.
      </div>
    {/if}

    {#if problemsError}
      <div class="note">{problemsError}</div>
    {/if}

    {#if selectedTeamProblems.length}
      <section class="problem-queue" aria-label="Open problems flagged by match scouts">
        <h4>Flagged by match scouts</h4>
        {#each selectedTeamProblems as report}
          <article class="problem-item" class:urgent={report.severity === 'urgent'}>
            <div class="problem-body">
              <p class="problem-summary">{report.summary}</p>
              {#if report.detail}<p class="problem-detail">{report.detail}</p>{/if}
              <p class="problem-meta">
                {report.source}{report.match_key ? ` · match ${report.match_key}` : ''}
                {report.severity === 'urgent' ? ' · urgent' : ''}
              </p>
            </div>
            <button class="btn btn-outline btn-sm" type="button" on:click={() => setProblemResolved(report, true)}>
              Mark inspected
            </button>
          </article>
        {/each}
      </section>
    {/if}

    <nav class="topic-rail" aria-label="Pit scouting topics">
      {#each topicStates as topic}
        <button
          type="button"
          class="topic-tab"
          class:active={activeTopic === topic.id}
          class:done={topic.done === topic.total}
          on:click={() => (activeTopic = topic.id)}
        >
          <span class="topic-name">{topic.label}</span>
          <span class="topic-count">{topic.done}/{topic.total}</span>
        </button>
      {/each}
    </nav>

    <div class="topic-progress">
      <div class="topic-progress-bar">
        <div class="topic-progress-fill" style={`width:${questionTotal ? (answeredTotal / questionTotal) * 100 : 0}%`}></div>
      </div>
      <span class="topic-progress-text">
        {#if remaining}
          {remaining} question{remaining === 1 ? '' : 's'} left
        {:else}
          Everything answered - ready to submit
        {/if}
      </span>
    </div>

{#if activeTopic === 'basics'}
    {#if pitSchema.scout_name}
      <div class="form-group">
        <label class="form-label" for="scoutNameInput">Pit contact name</label>
        <input
          id="scoutNameInput"
          class="form-input"
          type="text"
          maxlength="120"
          list="pitContacts"
          autocomplete="off"
          placeholder="Start typing the person you spoke with"
          bind:value={scout_name}
        />
        <datalist id="pitContacts">
          {#each pitContacts as contact}<option value={contact}></option>{/each}
        </datalist>
        <small class="form-help">Suggestions appear as you type from previous pit contacts. You can always enter someone new for follow-up questions.</small>
      </div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="drivebaseSelect">Drivebase Type</label>
      <select id="drivebaseSelect" class="form-select" bind:value={drivebase_type}>
        <option value="">-- Select --</option>
        {#each DRIVEBASE_OPTIONS as option}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label" for="shooterSelect">Shooter Type</label>
      <select id="shooterSelect" class="form-select" bind:value={shooter_type}>
        <option value="">-- Select --</option>
        {#each SHOOTER_OPTIONS as option}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label" for="hopperSelect">Hopper Type</label>
      <select id="hopperSelect" class="form-select" bind:value={hopper_type}>
        <option value="">-- Select --</option>
        {#each HOPPER_OPTIONS as option}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label" for="humanPlayerBallsSelect">Human Player Balls In Auto</label>
      <select id="humanPlayerBallsSelect" class="form-select" bind:value={human_player_balls_in_auto}>
        <option value="">-- Select --</option>
        {#each HUMAN_PLAYER_AUTO_OPTIONS as option}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </div>
{/if}

    {#if pitSchema.robot_archetype}
      <div class="form-group">
        <label class="form-label" for="robotArchetypeSelect">Robot Archetype</label>
        <select id="robotArchetypeSelect" class="form-select" bind:value={robot_archetype}>
          <option value="">-- Select --</option>
          {#each ROBOT_ARCHETYPES as option}<option value={option}>{option}</option>{/each}
        </select>
      </div>
    {/if}

    {#if pitSchema.additional_notes}
      <div class="form-group">
        <label class="form-label" for="additionalNotesInput">Additional Notes</label>
        <textarea id="additionalNotesInput" class="form-input additional-notes-input" rows="5" maxlength="4000" bind:value={additional_notes} placeholder="Strategy observations, pit conversations, repair history, or follow-up questions"></textarea>
        <small class="form-help">Saved for human review. Structured pit capabilities and unresolved problems affect Power Rankings.</small>
      </div>
    {/if}

    {#if pitSchema.technical_details}
{#if activeTopic === 'mechanisms'}
      <section class="question-section">
        <h4>Robot and Mechanisms</h4>

        <div class="field-grid">
          <div class="form-group">
            <label class="form-label" for="useNetSelect">Do they use a net?</label>
            <select id="useNetSelect" class="form-select" bind:value={technical_details.use_net}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="intakeStyleSelect">Ground intake style</label>
            <select id="intakeStyleSelect" class="form-select" bind:value={technical_details.intake_style}>
              <option value="">-- Select --</option>
              {#each INTAKE_STYLE_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="groundRollerMotorCountInput">Motors powering ground roller</label>
            <input
              id="groundRollerMotorCountInput"
              class="form-input"
              type="number"
              min="0"
              step="1"
              bind:value={technical_details.ground_roller_motor_count}
            />
          </div>

        </div>

        <div class="form-group">
          <label class="form-label">Motor controllers used</label>
          <div class="option-grid compact">
            {#each MOTOR_CONTROLLER_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('motor_controllers', option)}
                  on:change={(event) => setTechnicalMulti('motor_controllers', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Motor types used</label>
          <div class="option-grid compact">
            {#each MOTOR_TYPE_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('motor_types', option)}
                  on:change={(event) => setTechnicalMulti('motor_types', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>
      </section>
{/if}

{#if activeTopic === 'electrical'}
      <section class="question-section">
        <h4>Electrical</h4>

        <div class="field-grid">
          <div class="form-group">
            <label class="form-label" for="mainBreakerBrandSelect">Main breaker brand</label>
            <select id="mainBreakerBrandSelect" class="form-select" bind:value={technical_details.main_breaker_brand}>
              <option value="">-- Select --</option>
              {#each MAIN_BREAKER_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="sbConnectorSelect">SB connector</label>
            <select id="sbConnectorSelect" class="form-select" bind:value={technical_details.sb_connector}>
              <option value="">-- Select --</option>
              {#each SB_CONNECTOR_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="mainBreakerShroudSelect">Main breaker shroud?</label>
            <select id="mainBreakerShroudSelect" class="form-select" bind:value={technical_details.main_breaker_shroud}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

        </div>
      </section>
{/if}

{#if activeTopic === 'controls'}
      <section class="question-section">
        <h4>Controls and Software</h4>

        <div class="field-grid">
          <div class="form-group">
            <label class="form-label" for="usesCanivoreSelect">Uses CANivore?</label>
            <select id="usesCanivoreSelect" class="form-select" bind:value={technical_details.uses_canivore}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="canBusCountInput">Number of CAN buses</label>
            <input
              id="canBusCountInput"
              class="form-input"
              type="number"
              min="0"
              step="1"
              bind:value={technical_details.can_bus_count}
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="coprocessorSelect">Coprocessor</label>
            <select id="coprocessorSelect" class="form-select" bind:value={technical_details.coprocessor}>
              <option value="">-- Select --</option>
              {#each COPROCESSOR_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="usesWpilibSelect">Uses WPILib?</label>
            <select id="usesWpilibSelect" class="form-select" bind:value={technical_details.uses_wpilib}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Auto tools used</label>
          <div class="option-grid compact">
            {#each AUTO_TOOL_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('auto_tools', option)}
                  on:change={(event) => setTechnicalMulti('auto_tools', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Vision used</label>
          <div class="option-grid compact">
            {#each VISION_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('vision', option)}
                  on:change={(event) => setTechnicalMulti('vision', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Programming language</label>
          <div class="option-grid compact">
            {#each PROGRAMMING_LANGUAGE_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('programming_language', option)}
                  on:change={(event) => setTechnicalMulti('programming_language', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="softwareOtherInput">Other software or controls</label>
          <input id="softwareOtherInput" class="form-input" maxlength="240" placeholder="Anything not listed above" bind:value={technical_details.software_other} />
        </div>
      </section>
{/if}

{#if activeTopic === 'structure'}
      <section class="question-section">
        <h4>Drivebase and Structure</h4>

        <div class="field-grid">
          <div class="form-group">
            <label class="form-label" for="swerveModuleSelect">Swerve module</label>
            <select id="swerveModuleSelect" class="form-select" bind:value={technical_details.swerve_module}>
              <option value="">-- Select --</option>
              {#each SWERVE_MODULE_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="fitsUnderTrenchSelect">Can fit under the trench?</label>
            <select id="fitsUnderTrenchSelect" class="form-select" bind:value={technical_details.fits_under_trench}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="drivesOverMoundSelect">Can drive over the mound?</label>
            <select id="drivesOverMoundSelect" class="form-select" bind:value={technical_details.drives_over_mound}>
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="bumperFoamSelect">Bumper foam</label>
            <select id="bumperFoamSelect" class="form-select" bind:value={technical_details.bumper_foam}>
              <option value="">-- Select --</option>
              {#each BUMPER_FOAM_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="dimension-grid">
          <div class="form-group"><label class="form-label" for="drivetrainLengthInput">Drivetrain length (in)</label><input id="drivetrainLengthInput" class="form-input" type="number" min="0" step="0.01" bind:value={technical_details.drivetrain_length} /></div>
          <div class="form-group"><label class="form-label" for="drivetrainWidthInput">Drivetrain width (in)</label><input id="drivetrainWidthInput" class="form-input" type="number" min="0" step="0.01" bind:value={technical_details.drivetrain_width} /></div>
          <div class="form-group"><label class="form-label" for="drivetrainHeightInput">Drivetrain height (in)</label><input id="drivetrainHeightInput" class="form-input" type="number" min="0" step="0.01" bind:value={technical_details.drivetrain_height} /></div>
        </div>

        <div class="dimension-grid">
          <div class="form-group">
            <label class="form-label" for="bumperLengthInput">Bumper length</label>
            <input
              id="bumperLengthInput"
              class="form-input"
              type="number"
              min="0"
              step="0.01"
              bind:value={technical_details.bumper_length}
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="bumperWidthInput">Bumper width</label>
            <input
              id="bumperWidthInput"
              class="form-input"
              type="number"
              min="0"
              step="0.01"
              bind:value={technical_details.bumper_width}
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="bumperHeightInput">Bumper height</label>
            <input
              id="bumperHeightInput"
              class="form-input"
              type="number"
              min="0"
              step="0.01"
              bind:value={technical_details.bumper_height}
            />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Encoder types used</label>
          <div class="option-grid compact">
            {#each ENCODER_TYPE_OPTIONS as option}
              <label class="form-checkbox option-tile">
                <input
                  type="checkbox"
                  checked={hasTechnicalMulti('encoder_types', option)}
                  on:change={(event) => setTechnicalMulti('encoder_types', option, event.currentTarget.checked)}
                />
                <span>{option}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="field-grid">
          <div class="form-group">
            <label class="form-label" for="printedRollerHubsSelect">3D printed roller hubs?</label>
            <select
              id="printedRollerHubsSelect"
              class="form-select"
              bind:value={technical_details.printed_roller_hubs}
            >
              <option value="">-- Select --</option>
              {#each YES_NO_OPTIONS as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="rollerHubMaterialInput">Roller hub print material</label>
            <input
              id="rollerHubMaterialInput"
              class="form-input"
              type="text"
              maxlength="80"
              placeholder="e.g. PLA, PETG, Onyx"
              bind:value={technical_details.roller_hub_material}
            />
          </div>
        </div>
      </section>
{/if}

{#if activeTopic === 'ratings'}
      <section class="question-section">
        <h4>Subjective Ratings</h4>
        <div class="rating-grid">
          <div class="form-group">
            <label class="form-label" for="electricalRatingInput">Electrical rating (1-10)</label>
            <input
              id="electricalRatingInput"
              class="form-input"
              type="number"
              min="1"
              max="10"
              step="1"
              bind:value={technical_details.electrical_rating}
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="drivebaseRatingInput">Drivebase rating (1-10)</label>
            <input
              id="drivebaseRatingInput"
              class="form-input"
              type="number"
              min="1"
              max="10"
              step="1"
              bind:value={technical_details.drivebase_rating}
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="overallReliabilityRatingInput">Overall reliability rating (1-10)</label>
            <input
              id="overallReliabilityRatingInput"
              class="form-input"
              type="number"
              min="1"
              max="10"
              step="1"
              bind:value={technical_details.overall_reliability_rating}
            />
          </div>
        </div>
      </section>
    {/if}

    {#if pitSchema.estimated_bps}
      <div class="form-group">
        <label class="form-label" for="estimatedBpsInput">Estimated BPS</label>
        <input
          id="estimatedBpsInput"
          class="form-input"
          type="number"
          min="0"
          step="0.1"
          bind:value={estimated_bps}
          placeholder="e.g. 2.4"
        />
      </div>
    {/if}

    {#if pitSchema.likely_breaking_component}
      <div class="form-group">
        <label class="form-label" for="likelyBreakingComponentInput">What is most likely to break on the robot?</label>
        <textarea
          id="likelyBreakingComponentInput"
          class="form-input break-risk-input"
          rows="3"
          maxlength={MAX_BREAKING_COMPONENT_LENGTH}
          bind:value={likely_breaking_component}
          placeholder="Describe the most likely failure point"
        />
      </div>
    {/if}

{/if}
{#if activeTopic === 'basics'}
    {#if pitSchema.climb_options}
      <div class="form-group">
        <label class="form-label">Climb Options</label>
        <div class="climb-options-grid">
          {#each CLIMB_OPTIONS as option}
            <label class="form-checkbox climb-option">
              <input
                type="checkbox"
                checked={climb_options.includes(option)}
                disabled={option !== NO_CLIMB_OPTION && climb_options.includes(NO_CLIMB_OPTION)}
                on:change={(event) => setClimbOption(option, event.currentTarget.checked)}
              />
              <span>{option}</span>
            </label>
          {/each}
        </div>
        <small class="form-help">{climb_options.length}/{CLIMB_OPTIONS.length} selected</small>
      </div>
    {/if}

    {#if pitSchema.auto_options}
      <div class="form-group">
        <div class="auto-options-header">
          <label class="form-label">Auto Options</label>
          <button
            class="btn btn-outline"
            type="button"
            on:click={addAutoOption}
            disabled={autoOptions.length >= MAX_AUTO_OPTIONS}
          >
            Add Auto
          </button>
        </div>
        <small class="form-help">{autoOptions.length}/{MAX_AUTO_OPTIONS} autos listed</small>

        {#if !autoOptions.length}
          <div class="auto-options-empty">No named auto options added.</div>
        {:else}
          <div class="auto-option-editor-list">
            {#each autoOptions as option, idx}
              <div class="card auto-option-editor">
                <div class="auto-option-editor-header">
                  <strong>Auto {idx + 1}</strong>
                  <button class="btn btn-outline" type="button" on:click={() => removeAutoOption(idx)}>
                    Remove
                  </button>
                </div>

                <input
                  class="form-input"
                  type="text"
                  maxlength={MAX_AUTO_NAME_LENGTH}
                  placeholder="Auto name"
                  value={option.name}
                  on:input={(event) => updateAutoOption(idx, 'name', event.currentTarget.value)}
                />

                <textarea
                  class="form-input auto-option-description"
                  rows="3"
                  maxlength={MAX_AUTO_DESCRIPTION_LENGTH}
                  placeholder="Short description of the path, starting spot, and scoring plan"
                  value={option.description}
                  on:input={(event) => updateAutoOption(idx, 'description', event.currentTarget.value)}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
{/if}

{#if activeTopic === 'photos'}
    <div class="form-group">
      <div class="photo-header">
        <label class="form-label" for="photoUpload">Pit Photos (up to 3)</label>
        <button
          class="btn btn-outline"
          type="button"
          on:click={openPhotoPicker}
          disabled={!photoSlotsRemaining || saving || uploading}
        >
          {photoButtonLabel}
        </button>
      </div>

      {#key photoInputKey}
        <input
          bind:this={photoInput}
          id="photoUpload"
          type="file"
          class="visually-hidden"
          accept="image/*"
          multiple={!prefersCameraCapture}
          capture={prefersCameraCapture ? 'environment' : undefined}
          disabled={!photoSlotsRemaining}
          on:change={onFilesSelected}
        />
      {/key}

      <small class="form-help">{editablePhotoPaths.length + pendingFiles.length}/3 selected</small>
      {#if prefersCameraCapture && photoSlotsRemaining > 0}
        <small class="form-help">Tap the button again to add the next photo.</small>
      {/if}
    </div>

    {#if editablePhotoPaths.length || pendingFiles.length}
      <div class="photo-grid">
        {#each editablePhotoPaths as path}
          <div class="photo-item">
            <img src={photoUrl(path)} alt="Pit robot" />
            <button class="btn btn-outline" type="button" on:click={() => removeExistingPhoto(path)}>
              Remove
            </button>
          </div>
        {/each}

        {#each pendingFiles as file, idx}
          <div class="pending-file-card">
            <div class="form-label">Ready to upload</div>
            <div class="pending-file-name">{file.name || `Photo ${idx + 1}`}</div>
            <button class="btn btn-outline" type="button" on:click={() => removePendingPhoto(idx)}>
              Remove
            </button>
          </div>
        {/each}
      </div>
    {/if}

{/if}
    <div class="submit-row">
      <button class="btn btn-primary submit-btn" type="submit" disabled={saving || uploading}>
        {#if uploading}
          Uploading...
        {:else if saving}
          Submitting...
        {:else}
          Submit Pit Entry
        {/if}
      </button>
    </div>
  </form>
{/if}

<style>
  .view-tabs {
    display: flex;
    gap: 0.5rem;
    max-width: 760px;
    margin: 0 auto 1rem;
  }

  .view-tabs button {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: var(--control-height);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
  }

  .view-tabs button.active {
    border-color: var(--brand-gold-strong);
    background: var(--brand-gold-soft);
    color: var(--text);
    font-weight: 700;
  }

  .view-tabs button span {
    min-width: 1.35rem;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: white;
    font-size: 0.72rem;
    text-align: center;
  }

  .problems-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.75fr);
    gap: 1rem;
    max-width: 1100px;
    margin: 0 auto;
  }

  .problem-heading,
  .problem-meta,
  .resolved-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .problem-heading h3,
  .problem-heading p,
  .problem-form h3,
  .problem-card h4,
  .problem-card p {
    margin-top: 0;
  }

  .problem-heading p,
  .problem-card p {
    color: var(--text-muted);
  }

  .problem-list {
    display: grid;
    gap: 0.75rem;
  }

  .problem-card {
    padding: 1rem;
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-sm);
  }

  .problem-card.urgent { border-left-color: var(--danger); }
  .problem-meta { justify-content: flex-start; flex-wrap: wrap; color: var(--text-muted); font-size: 0.8rem; }
  .severity { text-transform: uppercase; font-weight: 700; }
  .resolved-problems { margin-top: 1rem; }
  .resolved-row { padding: 0.65rem 0; border-bottom: 1px solid var(--border); }
  .problem-form { align-self: start; }
  .additional-notes-input { min-height: 120px; resize: vertical; }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .page-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  .summary-pill {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
  }

  .summary-pill strong {
    font-size: 1.1rem;
  }

  .picker-card,
  .entry-card {
    display: grid;
    gap: 1rem;
    max-width: 760px;
    margin: 0 auto;
  }

  .team-search {
    font-size: 1.05rem;
  }

  .team-list {
    display: grid;
    gap: 0.45rem;
    max-height: 70vh;
    overflow: auto;
  }

  .team-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 0.7rem 0.8rem;
    cursor: pointer;
  }

  .team-row-main {
    font-weight: 600;
  }

  .status-pending {
    color: var(--danger);
    font-weight: 600;
    font-size: 0.85rem;
  }

  .status-needs-photo {
    color: var(--warning);
    font-weight: 600;
    font-size: 0.85rem;
  }

  .status-complete {
    color: var(--success);
    font-weight: 600;
    font-size: 0.85rem;
  }

  .entry-header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }

  .entry-header > div { flex: 1; }
  .entry-photo-action { margin-left: auto; white-space: nowrap; }

  .entry-subtitle {
    margin-top: 0.3rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  /* A flagged problem is time-critical - "inspect before the next match" - so
     it gets colour where the rest of the row does not. Urgent (the robot died
     or was disabled) is the only thing that escalates past the warning tone. */
  .problem-flag {
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    white-space: nowrap;
    background: var(--status-risk-bg);
    color: var(--status-risk-text);
  }
  .problem-flag.urgent { font-weight: 700; }

  .problem-queue {
    display: grid;
    gap: var(--gap-2);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .problem-queue h4 { margin: 0; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  .problem-item { display: flex; gap: var(--gap-3); align-items: flex-start; justify-content: space-between; }
  .problem-item + .problem-item { border-top: 1px solid var(--border); padding-top: var(--space-2); }
  .problem-body { min-width: 0; }
  .problem-summary { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .problem-item.urgent .problem-summary { color: var(--danger); }
  .problem-detail { margin: 2px 0 0; color: var(--text-muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .problem-meta { margin: 2px 0 0; color: var(--text-muted); font-size: 0.75rem; }

  /* Topic rail: horizontal on a phone (thumb-reachable, scrolls), a fixed
     column on a laptop. Deliberately not cards - it is a wayfinding control,
     and the count is the whole point of it. */
  .topic-rail {
    display: flex;
    gap: var(--gap-1);
    overflow-x: auto;
    scrollbar-width: none;
    margin-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .topic-rail::-webkit-scrollbar { display: none; }
  .topic-tab {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    flex: 0 0 auto;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    min-height: 2.75rem;
  }
  .topic-tab:hover { color: var(--text); }
  .topic-tab.active {
    color: var(--text);
    border-bottom-color: var(--brand-gold-base, #d9a413);
  }
  .topic-name { font-weight: 600; font-size: 0.92rem; }
  .topic-count {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  /* A finished topic is the one thing worth colouring - it is what tells a
     scout they can stop asking about it. */
  .topic-tab.done .topic-count { color: var(--green-strong); }

  .topic-progress {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    margin-bottom: var(--space-4);
  }
  .topic-progress-bar {
    flex: 1;
    height: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .topic-progress-fill {
    height: 100%;
    background: var(--brand-gold-base, #d9a413);
    transition: width 160ms ease-out;
  }
  .topic-progress-text {
    font-size: 0.8rem;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  @media (min-width: 900px) {
    /* Room for a persistent column, so the remaining topics stay visible
       while answering one of them. */
    .entry-card {
      grid-template-columns: 12rem minmax(0, 1fr);
      column-gap: var(--space-5);
      align-items: start;
      /* The rail costs 12rem, so give the answer column back the width it
         had rather than squeezing every select into two thirds of it. */
      max-width: 1040px;
    }
    .entry-card > *:not(.topic-rail) { grid-column: 2; }
    .entry-card > .entry-header, .entry-card > .note { grid-column: 1 / -1; }
    .topic-rail {
      grid-column: 1;
      grid-row: 2 / 100;
      position: sticky;
      top: var(--space-4);
      flex-direction: column;
      overflow-x: visible;
      border-bottom: 0;
      border-right: 1px solid var(--border);
    }
    .topic-tab {
      justify-content: space-between;
      border-bottom: 0;
      border-right: 2px solid transparent;
      text-align: left;
    }
    .topic-tab.active { border-right-color: var(--brand-gold-base, #d9a413); background: var(--surface-2); }
  }

  .question-section {
    display: grid;
    gap: 0.85rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }

  .question-section h4 {
    margin: 0;
    font-size: 1rem;
  }

  .field-grid,
  .dimension-grid,
  .rating-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 0.75rem;
  }

  .option-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.55rem;
    margin-top: 0.5rem;
  }

  .option-grid.compact {
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  }

  .option-tile {
    min-height: 44px;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
  }

  .auto-options-header,
  .auto-option-editor-header,
  .photo-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }

  .auto-options-empty {
    margin-top: 0.5rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.8rem;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--surface) 90%, transparent);
  }

  .auto-option-editor-list {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.55rem;
  }

  .auto-option-editor {
    display: grid;
    gap: 0.6rem;
    padding: 0.75rem;
  }

  .auto-option-description {
    min-height: 88px;
    resize: vertical;
  }

  .break-risk-input {
    min-height: 88px;
    resize: vertical;
  }

  .climb-options-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.6rem;
    margin-top: 0.5rem;
  }

  .climb-option {
    min-height: 48px;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.6rem;
  }

  .photo-item,
  .pending-file-card {
    display: grid;
    gap: 0.45rem;
  }

  .photo-item img {
    width: 100%;
    height: 140px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
  }

  .pending-file-card {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
  }

  .pending-file-name {
    word-break: break-word;
    font-size: 0.92rem;
  }

  .submit-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }

  .submit-btn {
    min-width: 190px;
  }

  @media (max-width: 768px) {
    .page-header,
    .entry-header,
    .auto-options-header,
    .auto-option-editor-header,
    .photo-header {
      flex-direction: column;
      align-items: stretch;
    }

    .entry-photo-action { width: 100%; margin-left: 0; }

    .page-summary {
      width: 100%;
      justify-content: flex-start;
    }

    .summary-pill {
      flex: 1 1 140px;
      justify-content: space-between;
    }

    .team-list {
      max-height: none;
    }

    .photo-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .submit-row {
      justify-content: stretch;
    }

    .submit-btn {
      width: 100%;
    }

    .problems-layout { grid-template-columns: 1fr; }
  }

  @media (max-width: 480px) {
    .team-row {
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .photo-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
