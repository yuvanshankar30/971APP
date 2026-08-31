<script>
  import { browser } from '$app/environment';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { onMount, tick } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { hasPermission, GENERAL_ROLES } from '$lib/permissions.js';
  import { isTeam9584 } from '$lib/frcTeams.js';
  import { onShapeAPI } from '$lib/onshape.js';
  import { formatPacificDate, formatPacificDateTimeWithZone } from '$lib/timezone.js';
  import stockData from '$lib/stock.json';
  import { Users, Plus, Link, Upload, Settings, FileText, ExternalLink, Edit, Download, Trash2 } from 'lucide-svelte';
  import { goto } from '$app/navigation';  let user = null;
  const GENERAL_TASK_CATEGORIES = ['CAD', 'Mechanical', 'Electrical', 'Software', 'Other'];
  let loading = true;
  let loadingStep = 'Initializing...';
  let subsystems = [];
  let showCreateModal = false;
  let showLinkModal = false;
  let showBuildModal = false;
  let editingSubsystemId = null;
  let selectedSubsystem = null;
  let selectedRelease = null;
  let newSubsystem = { name: '', description: '', onshape_url: '' };
  let onshapeUrl = '';
  // file inputs are referenced by id per subsystem
  let loadingOnShape = false;
  let onshapeData = {};
  let builds = [];
  let stockTypes = [];
  let buildBOM = [];
  let loadingBuild = false;
  let generalTaskLoading = false;
  let generalTaskSaving = false;
  let generalTaskSelected = new Set();
  let generalTaskError = '';
  let generalTaskNote = '';
  const LAST_SUBSYSTEM_STORAGE_KEY = '971hub:lastSubsystem';

  function rememberLastSubsystem(subsystem) {
    if (!browser || !subsystem?.id) return;
    localStorage.setItem(LAST_SUBSYSTEM_STORAGE_KEY, JSON.stringify({
      id: subsystem.id,
      name: subsystem.name || '',
      updatedAt: new Date().toISOString()
    }));
  }

  $: if (selectedSubsystem && subsystems.length > 0) {
    const activeSubsystem = subsystems.find((subsystem) => subsystem.id === selectedSubsystem);
    if (activeSubsystem) rememberLastSubsystem(activeSubsystem);
  }
  onMount(async () => {
    console.time('Total CAD page load');
    try {
      // Hydrate from UUID and handle session
      loadingStep = 'Hydrating user...';
      const unsub = userStore.subscribe((v) => { user = v; });
      
      // Only fetch if user is not already loaded
      if (!user) {
        await loadUserFromUUID(supabase);
      }

      // Add timeout to getSession
      const sessionTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Session fetch timeout')), 5000)
      );
      
      let session = null;
      try {
        const sessionPromise = supabase.auth.getSession();
        const { data } = await Promise.race([sessionPromise, sessionTimeoutPromise]);
        session = data.session;
      } catch (error) {
        console.warn('Session fetch timeout or error:', error.message || error);
      }
      
      if (!session && !user) {
        loading = false;
        goto('/');
        return;
      }
      if (session?.user?.id) {
        setUserUUID(session.user.id);
        await upsertProfileIfMissing(supabase, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.user_metadata?.full_name || (session.user.email ? session.user.email.split('@')[0] : '')
        });
        await loadUserFromUUID(supabase);
      }

      // Add timeout wrapper for each loading operation
      loadingStep = 'Loading subsystems...';
      console.time('Load subsystems');
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Subsystems loading timeout')), 30000)
        );
        await Promise.race([loadSubsystems(), timeoutPromise]);
      } catch (subsystemError) {
        console.error('Subsystems loading failed or timed out:', subsystemError);
        subsystems = []; // Set empty array as fallback
      }
      console.timeEnd('Load subsystems');

      loadingStep = 'Loading builds...';
      console.time('Load builds');
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Builds loading timeout')), 30000)
        );
        await Promise.race([loadBuilds(), timeoutPromise]);
      } catch (buildsError) {
        console.error('Builds loading failed or timed out:', buildsError);
        builds = []; // Set empty array as fallback
      }
      console.timeEnd('Load builds');

      loadingStep = 'Loading stock types...';
      console.time('Load stock types');
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stock types loading timeout')), 30000)
        );
        await Promise.race([loadStockTypes(), timeoutPromise]);
      } catch (stockError) {
        console.error('Stock types loading failed or timed out:', stockError);
        stockTypes = []; // Set empty array as fallback
      }
      console.timeEnd('Load stock types');

      loadingStep = 'Loading task category signups...';
      try {
        await loadGeneralTaskSignup();
      } catch (taskSignupError) {
        console.warn('Task category signup load failed:', taskSignupError);
      }

    } catch (error) {
      console.error('Critical error in onMount:', error);
    } finally {
      loading = false; // Always set loading to false
      console.log('Loading state set to false');
      console.timeEnd('Total CAD page load');
    }
  });
  // Removed duplicated/erroneous code after ensureUserProfile
  async function loadSubsystems() {
    try {
      // First, fetch subsystems with member info
      const { data, error } = await supabase
        .from('subsystems')
        .select(`
          *,
          subsystem_members(user_id)
        `);

      if (error) throw error;
      let loadedSubsystems = data || [];

      // Get unique lead user IDs
      const leadUserIds = [...new Set(loadedSubsystems
        .map(s => s.lead_user_id)
        .filter(id => id)
      )];

      // Fetch user profiles for all leads
      let userProfiles = {};
      if (leadUserIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase
          .from('user_profiles')
          .select('id, full_name, email')
          .in('id', leadUserIds);

        if (profileError) {
          console.error('Error loading user profiles:', profileError);
        } else {
          profiles.forEach(profile => {
            userProfiles[profile.id] = profile;
          });
        }
      }

      // Fetch Project Budgets and Spending
      let budgetMap = {};
      try {
        const subIds = loadedSubsystems.map(s => s.id);
        
        // 1. Fetch budgets for these projects
        const { data: budgets, error: budgetErr } = await supabase
          .from('purchasing_budgets')
          .select('*')
          .eq('scope_type', 'project')
          .in('scope_value', subIds);
        
        if (!budgetErr && budgets) {
          // Group budgets by project_id (scope_value)
          // Taking the most recent active budget if multiple? Or sum them?
          // For simplicity, let's take the first found or sum amounts if multiple exists.
          budgets.forEach(b => {
            if (!budgetMap[b.scope_value]) {
              budgetMap[b.scope_value] = { amount: 0, spent: 0, hasBudget: true };
            }
            budgetMap[b.scope_value].amount += Number(b.amount);
          });
        }

        // 2. Fetch purchasing items for these projects to calc spent
        // Only fetch basics needed for cost
        const { data: items, error: itemsErr } = await supabase
          .from('purchasing')
          .select('project_id, price, final_price, quantity, status')
          .in('project_id', subIds);

        if (!itemsErr && items) {
          items.forEach(p => {
             // Exclude rejected items and Budget Exempt items
             if (p.status === 'rejected') return;
             if ((p.project_id || '').trim() === 'Budget Exempt') return;
             if (budgetMap[p.project_id]) {
               budgetMap[p.project_id].spent += ((p.final_price || p.price || 0) * (p.quantity || 1));
             }
          });
        }
      } catch (bErr) {
        console.warn('Failed to load budgets for subsystems', bErr);
      }

      // Add lead user info and budget info to subsystems
      subsystems = loadedSubsystems.map(subsystem => ({
        ...subsystem,
        lead_user: subsystem.lead_user_id ? userProfiles[subsystem.lead_user_id] || null : null,
        budget: budgetMap[subsystem.id] || null
      }));

      // Load OnShape doc info in the background — don't block the page render on
      // it. These are per-subsystem Onshape API round-trips; running them
      // sequentially made the CAD tab slow to appear. Fire-and-forget + parallel.
      loadOnshapeDocInfo(subsystems);
    } catch (error) {
      console.error('Error loading subsystems:', error);
    }
  }

  // Fetch Onshape document info for all linked subsystems in parallel and fill it
  // in as it arrives (reassigning onshapeData per result so Svelte re-renders).
  async function loadOnshapeDocInfo(subs) {
    const targets = (subs || []).filter((s) => s.onshape_document_id);
    await Promise.all(targets.map(async (subsystem) => {
      let entry = { docInfo: null, releases: [] };
      if (onShapeAPI.accessKey && onShapeAPI.secretKey) {
        try {
          const docInfo = await onShapeAPI.getDocumentInfo(subsystem.onshape_document_id);
          entry = { docInfo: docInfo || null, releases: [] };
        } catch (error) {
          console.error(`Error loading OnShape data for ${subsystem.name}:`, error);
        }
      }
      onshapeData = { ...onshapeData, [subsystem.id]: entry };
    }));
  }

  async function createSubsystem() {
  if (!newSubsystem.name.trim()) return;

    try {
      const insertData = {
        name: newSubsystem.name,
        description: newSubsystem.description,
        lead_user_id: user.id
      };

      if (!editingSubsystemId) {
        insertData.frc_team = user?.frc_team || null;
      }

      // If user provided an OnShape URL in the create modal, try to parse and persist it now
      if (newSubsystem.onshape_url && newSubsystem.onshape_url.trim()) {
        const parsed = onShapeAPI.parseOnShapeUrl(newSubsystem.onshape_url.trim());
        if (!parsed) {
          alert('Invalid OnShape URL format. Please paste a valid OnShape document URL or leave blank.');
          return;
        }
        insertData.onshape_url = newSubsystem.onshape_url.trim();
        insertData.onshape_document_id = parsed.documentId;
        insertData.onshape_workspace_id = parsed.workspaceId || null;
        insertData.onshape_element_id = parsed.elementId || null;
      }

      let data = null;
      let error = null;

      if (editingSubsystemId) {
        // Update existing
        const res = await supabase
          .from('subsystems')
          .update(insertData)
          .eq('id', editingSubsystemId)
          .select()
          .single();
        data = res.data;
        error = res.error;
      } else {
        const res = await supabase
          .from('subsystems')
          .insert([insertData])
          .select()
          .single();
        data = res.data;
        error = res.error;
      }

      if (error) throw error;

      // If this is a new subsystem, add creator as a member
      if (!editingSubsystemId) {
        await supabase
          .from('subsystem_members')
          .insert([{
            subsystem_id: data.id,
            user_id: user.id
          }]);
      }

      // Reset and close
      newSubsystem = { name: '', description: '', onshape_url: '' };
      editingSubsystemId = null;
      showCreateModal = false;

      // Reload subsystems so the new/updated one (and any OnShape data) appears
      await loadSubsystems();
    } catch (error) {
      console.error('Error creating subsystem:', error);
      alert('Failed to create subsystem');
    }
  }

  // Open modal to edit an existing subsystem
  function openEditModal(subsystem) {
    editingSubsystemId = subsystem.id;
    newSubsystem = {
      name: subsystem.name || '',
      description: subsystem.description || '',
      onshape_url: subsystem.onshape_url || ''
    };
    openCreateModal();
  }

  // Open the create modal and focus the name input for better UX
  async function openCreateModal() {
    showCreateModal = true;
    await tick();
    const el = document.getElementById('subsystem-name');
    if (el) el.focus();
  }

  async function joinSubsystem(subsystemId) {
    try {
      const { error } = await supabase
        .from('subsystem_members')
        .insert([{
          subsystem_id: subsystemId,
          user_id: user.id
        }]);

      if (error) throw error;
      await loadSubsystems();
    } catch (error) {
      if (error.code === '23505') {
        alert('You are already a member of this subsystem');
      } else {
        console.error('Error joining subsystem:', error);
        alert('Failed to join subsystem');
      }
    }
  }

  async function linkOnShapeDocument() {
    loadingOnShape = true;
    try {
      const parsedUrl = onShapeAPI.parseOnShapeUrl(onshapeUrl);
      if (!parsedUrl) {
        alert('Invalid OnShape URL format');
        return;
      }

      // Update subsystem with OnShape info
      let updateQuery = supabase
        .from('subsystems')
        .update({
          onshape_url: onshapeUrl,
          onshape_document_id: parsedUrl.documentId,
          onshape_workspace_id: parsedUrl.workspaceId,
          onshape_element_id: parsedUrl.elementId
        })
        .eq('id', selectedSubsystem);

      if (!isGeneralLead()) {
        updateQuery = updateQuery.eq('lead_user_id', user.id);
      }

      const { error } = await updateQuery;

      if (error) throw error;

      // Fetch OnShape data
      try {
        const [docInfo, versions, releases] = await Promise.all([
          onShapeAPI.getDocumentInfo(parsedUrl.documentId),
          onShapeAPI.getDocumentVersions(parsedUrl.documentId),
          onShapeAPI.getDocumentReleases(parsedUrl.documentId)
        ]);

        onshapeData = { docInfo, versions, releases };
      } catch (onshapeError) {
        console.error('OnShape API error:', onshapeError);
        // Still save the URL even if API fails
      }

      onshapeUrl = '';
      showLinkModal = false;
      selectedSubsystem = null;
      await loadSubsystems();
    } catch (error) {
      console.error('Error linking OnShape document:', error);
      alert('Failed to link OnShape document');
    } finally {
      loadingOnShape = false;
    }
  }

  async function handleFileUpload(subsystemId, inputEl) {
    const files = inputEl?.files;
    if (!files || files.length === 0) return;

    try {
      for (const file of files) {
        const fileName = `${Date.now()}_${file.name}`;
        const filePath = `subsystems/${subsystemId}/${fileName}`;

        // Upload file to Supabase storage
        const { error: uploadError } = await supabase.storage
          .from('cad-files')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        // Save file info to database
        const { error: dbError } = await supabase
          .from('subsystem_files')
          .insert([{
            subsystem_id: subsystemId,
            file_name: file.name,
            file_path: filePath,
            file_type: file.type,
            file_size: file.size,
            uploaded_by: user.id
          }]);

        if (dbError) throw dbError;
      }

  if (inputEl) inputEl.value = '';
      alert('Files uploaded successfully');
    } catch (error) {
      console.error('Error uploading files:', error);
      alert('Failed to upload files');
    }
  }
  async function loadBuilds() {
    try {
      console.time('Fetch builds');
      const { data, error } = await supabase
        .from('builds')
        .select(`
          *,
          subsystems(name)
        `)
        .order('created_at', { ascending: false });
      console.timeEnd('Fetch builds');

      if (error) throw error;
      builds = data || [];
    } catch (error) {
      console.error('Error loading builds:', error);
    }
  }

  async function loadStockTypes() {
    try {
      // Use local stock.json instead of querying Supabase for stock_types.
      // This avoids the external REST call since the app bundles a local copy.
      console.log('Loading stock types from local stock.json');
      stockTypes = stockData || [];
    } catch (error) {
      console.error('Error loading local stock types:', error);
      stockTypes = [];
    }
  }

  function normalizeTaskCategoryKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  async function loadGeneralTaskSignup() {
    if (!user?.id) return;
    generalTaskLoading = true;
    generalTaskError = '';
    generalTaskNote = '';
    generalTaskSelected = new Set();

    try {
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('task_general_categories')
        .eq('id', user.id)
        .single();
      if (error) throw error;
      const selected = Array.isArray(profile?.task_general_categories)
        ? profile.task_general_categories
        : [];
      generalTaskSelected = new Set(
        selected
          .map((c) => GENERAL_TASK_CATEGORIES.find((allowed) => normalizeTaskCategoryKey(allowed) === normalizeTaskCategoryKey(c)))
          .filter(Boolean)
      );
    } catch (error) {
      console.error('Failed to load general task category signup', error);
      const msg = String(error?.message || '');
      generalTaskError = msg.toLowerCase().includes('task_general_categories')
        ? 'Task category signup is not initialized yet. Apply migration 20260311_task_general_categories.sql.'
        : (msg || 'Failed to load task category signup.');
    } finally {
      generalTaskLoading = false;
    }
  }

  async function setGeneralTaskCategory(category, enabled) {
    if (!user?.id || generalTaskSaving) return;
    generalTaskSaving = true;
    generalTaskError = '';
    generalTaskNote = '';

    try {
      const next = new Set(generalTaskSelected);
      if (enabled) next.add(category);
      else next.delete(category);
      const categories = [...next].filter((c) => GENERAL_TASK_CATEGORIES.includes(c));
      const { error } = await supabase
        .from('user_profiles')
        .update({ task_general_categories: categories })
        .eq('id', user.id);
      if (error) throw error;
      generalTaskSelected = next;
      generalTaskNote = `Saved ${category}.`;
    } catch (error) {
      console.error('Failed to update task category signup', error);
      generalTaskError = error?.message || 'Failed to update category signup.';
    } finally {
      generalTaskSaving = false;
    }
  }

  function toggleGeneralTaskCategory(category) {
    const enabled = !generalTaskSelected.has(category);
    setGeneralTaskCategory(category, enabled);
  }

  async function createBuildFromRelease(subsystemId, release) {
    loadingBuild = true;
    selectedSubsystem = subsystemId;
    selectedRelease = release;
    
    try {
      const subsystem = subsystems.find(s => s.id === subsystemId);
      if (!subsystem.onshape_document_id) {
        alert('No OnShape document linked to this subsystem');
        return;
      }

      // Generate build hash using subsystem ID (not version) for rollup across versions
      const buildHash = `${subsystem.onshape_document_id}_${subsystemId}`;

      // Create build record
      const { data: buildData, error: buildError } = await supabase
        .from('builds')
        .insert([{
          subsystem_id: subsystemId,
          release_id: release.id,
          release_name: release.name,
          build_hash: buildHash,
          created_by: user.id,
          frc_team: user?.frc_team || null
        }])
        .select()
        .single();

      if (buildError) throw buildError;

      // Get BOM from OnShape
      const bom = await onShapeAPI.getAssemblyBOM(
        subsystem.onshape_document_id,
        subsystem.onshape_workspace_id,
        subsystem.onshape_element_id,
        release.versionId
      );

      // Process BOM items
      const bomItems = [];
      for (const item of bom.bomTable?.items || []) {
        const isCOTS = onShapeAPI.isCOTSPart(item.item?.name || '', item.item?.partNumber || '');
        
        let boundingBox = null;
        let material = null;
        
        if (!isCOTS && item.item?.partId) {
          try {
            const [properties, bbox] = await Promise.all([
              onShapeAPI.getPartProperties(
                subsystem.onshape_document_id,
                subsystem.onshape_workspace_id,
                subsystem.onshape_element_id,
                item.item.partId
              ),
              onShapeAPI.getPartBoundingBox(
                subsystem.onshape_document_id,
                subsystem.onshape_workspace_id,
                subsystem.onshape_element_id,
                item.item.partId
              )
            ]);
            
            material = properties?.material || 'Unknown';
            boundingBox = bbox?.lowCoordinate && bbox?.highCoordinate ? {
              x: bbox.highCoordinate[0] - bbox.lowCoordinate[0],
              y: bbox.highCoordinate[1] - bbox.lowCoordinate[1],
              z: bbox.highCoordinate[2] - bbox.lowCoordinate[2]
            } : null;
          } catch (error) {
            console.error('Error getting part details:', error);
          }
        }

        const stockAssignment = isCOTS ? null : onShapeAPI.assignStockType(material, boundingBox, stockTypes);

        bomItems.push({
          build_id: buildData.id,
          part_name: item.item?.name || 'Unknown Part',
          part_number: item.item?.partNumber || '',
          quantity: item.quantity || 1,
          part_type: isCOTS ? 'COTS' : 'manufactured',
          material: material,
          stock_assignment: stockAssignment,
          bounding_box_x: boundingBox?.x,
          bounding_box_y: boundingBox?.y,
          bounding_box_z: boundingBox?.z,
          onshape_part_id: item.item?.partId,
          status: isCOTS ? 'delivered' : 'pending'
        });
      }

      // Insert BOM items
      if (bomItems.length > 0) {
        const { error: bomError } = await supabase
          .from('build_bom')
          .insert(bomItems);

        if (bomError) throw bomError;
      }

      buildBOM = bomItems;
      showBuildModal = true;
      await loadBuilds();
    } catch (error) {
      console.error('Error creating build:', error);
      alert('Failed to create build: ' + error.message);
    } finally {
      loadingBuild = false;
    }
  }

  async function addAllCOTSToPurchasing(buildId) {
    try {
      const { error } = await supabase
        .from('build_bom')
        .update({ added_to_purchasing: true })
        .eq('build_id', buildId)
        .eq('part_type', 'COTS');

      if (error) throw error;
      alert('All COTS parts added to purchasing (placeholder)');
    } catch (error) {
      console.error('Error adding COTS to purchasing:', error);
      alert('Failed to add COTS parts to purchasing');
    }
  }

  async function addManufacturedIteration(buildId) {
    try {
      // Get current build's manufactured parts
      const { data: currentParts, error: currentError } = await supabase
        .from('build_bom')
        .select('part_name, part_number, material, stock_assignment')
        .eq('build_id', buildId)
        .eq('part_type', 'manufactured');

      if (currentError) throw currentError;

      // Get all previous builds for the same subsystem
      const { data: build, error: buildError } = await supabase
        .from('builds')
        .select('subsystem_id')
        .eq('id', buildId)
        .single();

      if (buildError) throw buildError;

      const { data: previousParts, error: previousError } = await supabase
        .from('build_bom')
        .select('part_name, part_number, material, stock_assignment')
        .in('build_id', 
          builds
            .filter(b => b.subsystem_id === build.subsystem_id && b.id !== buildId)
            .map(b => b.id)
        )
        .eq('part_type', 'manufactured');

      if (previousError) throw previousError;

      // Find parts that are not identical to previous builds
      const newParts = currentParts.filter(current => 
        !previousParts.some(previous => 
          previous.part_name === current.part_name &&
          previous.part_number === current.part_number &&
          previous.material === current.material &&
          previous.stock_assignment === current.stock_assignment
        )
      );

      // Update only new parts
      const { error: updateError } = await supabase
        .from('build_bom')
        .update({ added_to_parts_list: true })
        .eq('build_id', buildId)
        .eq('part_type', 'manufactured')
        .in('part_name', newParts.map(p => p.part_name));

      if (updateError) throw updateError;
      alert(`${newParts.length} new manufactured parts added to parts list`);
    } catch (error) {
      console.error('Error adding manufactured iteration:', error);
      alert('Failed to add manufactured parts');
    }
  }

  async function buildDuplicate(buildId) {
    try {
      const { error } = await supabase
        .from('build_bom')
        .update({ added_to_parts_list: true })
        .eq('build_id', buildId);

      if (error) throw error;
      alert('All parts added to parts list');
    } catch (error) {
      console.error('Error building duplicate:', error);
      alert('Failed to add all parts');
    }
  }

  async function addSinglePartToList(bomItemId) {
    try {
      const { error } = await supabase
        .from('build_bom')
        .update({ added_to_parts_list: true })
        .eq('id', bomItemId);

      if (error) throw error;
    } catch (error) {
      console.error('Error adding part to list:', error);
      alert('Failed to add part to list');
    }
  }

  async function markAsAssembled(buildId) {
    try {
      const { error } = await supabase
        .from('builds')
        .update({ 
          status: 'assembled',
          assembled_at: new Date().toISOString(),
          assembled_by: user.id
        })
        .eq('id', buildId);

      if (error) throw error;
      await loadBuilds();
    } catch (error) {
      console.error('Error marking as assembled:', error);
      alert('Failed to mark as assembled');
    }
  }

  function isSubsystemMember(subsystem) {
    return subsystem.subsystem_members.some(member => member.user_id === user?.id);
  }

  function isGeneralLead() {
    if (!user) return false;
    return user.general_role === GENERAL_ROLES.LEAD || user.role === 'admin';
  }

  function isSubsystemLead(subsystem) {
    if (!subsystem || !user) return false;
    return subsystem.lead_user_id === user.id || isGeneralLead();
  }

  // Check if user can delete a build (must be lead of the subsystem the build belongs to)
  function canDeleteBuild(build) {
    const subsystem = subsystems.find(s => s.id === build.subsystem_id);
    return subsystem && isSubsystemLead(subsystem);
  }

  async function deleteSubsystem(subsystemId) {
    if (!await requestConfirmation({ title: 'Delete subsystem', message: 'Delete this subsystem and all associated builds and data? This cannot be undone.', confirmLabel: 'Delete subsystem', danger: true })) {
      return;
    }

    try {
      // First delete all builds associated with this subsystem
      const { error: buildsError } = await supabase
        .from('builds')
        .delete()
        .eq('subsystem_id', subsystemId);

      if (buildsError) {
        console.warn('Error deleting builds:', buildsError);
      }

      // Delete subsystem members
      const { error: membersError } = await supabase
        .from('subsystem_members')
        .delete()
        .eq('subsystem_id', subsystemId);

      if (membersError) {
        console.warn('Error deleting subsystem members:', membersError);
      }

      // Delete the subsystem itself
      const { error } = await supabase
        .from('subsystems')
        .delete()
        .eq('id', subsystemId);

      if (error) throw error;

      // Refresh data
      await loadSubsystems();
      await loadBuilds();
      alert('Subsystem deleted successfully');
    } catch (error) {
      console.error('Error deleting subsystem:', error);
      alert('Failed to delete subsystem: ' + error.message);
    }
  }

  async function deleteBuild(buildId) {
    if (!await requestConfirmation({ title: 'Delete build', message: 'Delete this build and all BOM data? This cannot be undone.', confirmLabel: 'Delete build', danger: true })) {
      return;
    }

    try {
      // First delete build BOM entries
      const { error: bomError } = await supabase
        .from('build_bom')
        .delete()
        .eq('build_id', buildId);

      if (bomError) {
        console.warn('Error deleting build BOM:', bomError);
      }

      // Delete the build itself
      const { error } = await supabase
        .from('builds')
        .delete()
        .eq('id', buildId);

      if (error) throw error;

      // Refresh data
      await loadBuilds();
      alert('Build deleted successfully');
    } catch (error) {
      console.error('Error deleting build:', error);
      alert('Failed to delete build: ' + error.message);
    }
  }

  async function createBuildFromDocument(subsystem) {
    if (!subsystem.onshape_document_id || !subsystem.onshape_workspace_id || !subsystem.onshape_element_id) {
      alert('OnShape document information is incomplete. Please re-link the document.');
      return;
    }

    loadingBuild = true;
    try {
      // Create a build hash using subsystem ID (not version) for rollup across versions
      const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;
      
      const { data: build, error } = await supabase
        .from('builds')
        .insert([{
          subsystem_id: subsystem.id,
          release_id: 'current',
          release_name: `Current State - ${formatPacificDate(new Date())}`,
          build_hash: buildHash,
          created_by: user.id,
          status: 'pending',
          frc_team: user?.frc_team || null
        }])
        .select()
        .single();

      if (error) throw error;

      // Try to get assembly info and create BOM
      try {
        const assemblyInfo = await onShapeAPI.getAssemblyInfo(
          subsystem.onshape_document_id,
          subsystem.onshape_workspace_id,
          subsystem.onshape_element_id
        );

        // For now, create a placeholder BOM entry
        await supabase
          .from('build_bom')
          .insert([{
            build_id: build.id,
            part_name: `${subsystem.name} Assembly`,
            part_number: subsystem.onshape_document_id,
            quantity: 1,
            part_type: 'manufactured',
            material: 'Mixed',
            workflow: 'assembly',
            onshape_part_id: subsystem.onshape_element_id,
            status: 'pending'
          }]);

      } catch (apiError) {
        console.warn('Could not fetch assembly info, created build without detailed BOM:', apiError);
      }

      await loadBuilds();
      alert('Build created successfully!');
      
    } catch (error) {
      console.error('Error creating build:', error);
      alert('Failed to create build: ' + error.message);
    } finally {
      loadingBuild = false;
    }
  }

  function viewDocumentDetails(subsystem) {
    if (onshapeData[subsystem.id]?.docInfo) {
      const docInfo = onshapeData[subsystem.id].docInfo;
      const details = [
        `Name: ${docInfo.name || 'Unknown'}`,
        `Modified: ${docInfo.modifiedAt ? formatPacificDateTimeWithZone(docInfo.modifiedAt) : 'Unknown'}`,
        `Created: ${docInfo.createdAt ? formatPacificDateTimeWithZone(docInfo.createdAt) : 'Unknown'}`,
        `Owner: ${docInfo.owner || 'Unknown'}`,
        `Public: ${docInfo.public ? 'Yes' : 'No'}`
      ].join('\n');
      
      alert(`OnShape Document Details:\n\n${details}`);
    } else {
      alert('Document details not available. Try refreshing the page.');
    }
  }
</script>

<svelte:head>
  <title>CAD Subsystems - Spartans Hub</title>
</svelte:head>

{#if loading}
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <p>{loadingStep}</p>
    <small>If this takes more than 30 seconds, there may be an issue with the OnShape API.</small>
  </div>
{:else if user}
  <div class="cad-container">
    <div class="page-header">
      <div class="header-content">
        <Settings size={32} />
        <div>
          <h1>CAD Subsystems</h1>
          <p>Manage robot subsystems with OnShape integration</p>
        </div>
      </div>
  {#if hasPermission(user, 'CREATE_SUBSYSTEMS')}
  <button class="btn btn-primary btn-sm" on:click={openCreateModal}>
        <Plus size={16} />
        Create Subsystem
      </button>
  {/if}
    </div>

    <section class="general-task-signup">
      <h2>General Task Categories</h2>
      <p class="muted">Sign up here so you show up in the Tasks assignee dropdown for non-subsystem tasks.</p>
      {#if generalTaskLoading}
        <p class="muted">Loading category signup...</p>
      {:else if generalTaskError}
        <p class="error-message">{generalTaskError}</p>
      {:else}
        <div class="category-grid">
          {#each GENERAL_TASK_CATEGORIES as category}
            <button
              type="button"
              class="category-pill"
              class:selected={generalTaskSelected.has(category)}
              disabled={generalTaskSaving}
              aria-pressed={generalTaskSelected.has(category)}
              on:click={() => toggleGeneralTaskCategory(category)}
            >
              {category}
            </button>
          {/each}
        </div>
        {#if generalTaskNote}
          <p class="muted">{generalTaskNote}</p>
        {/if}
      {/if}
    </section>

    <div class="subsystems-grid">
      {#each subsystems as subsystem}
        <div 
          class="subsystem-card" 
          class:clickable={subsystem.onshape_url}
          on:click={() => subsystem.onshape_url && goto(`/cad/${subsystem.id}`)}
          role="button"
          tabindex="0"
          on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && subsystem.onshape_url && goto(`/cad/${subsystem.id}`)}
        >
          <div class="subsystem-header">
            <div class="subsystem-title">
              <h3>{subsystem.name}</h3>
              {#if isTeam9584(subsystem.frc_team)}
                <span class="tag team-tag tag-9584" title="Team 9584">9584</span>
              {/if}
            </div>
            <div class="subsystem-toolbar">
              {#if isSubsystemLead(subsystem)}
                <button
                  class="btn btn-outline btn-small"
                  on:click|stopPropagation={() => openEditModal(subsystem)}
                  aria-label="Edit subsystem"
                >
                  <Edit size={14} />
                </button>
              {/if}
              <div class="subsystem-badges">
              {#if isSubsystemLead(subsystem)}
                <span class="badge badge-lead">Lead</span>
              {/if}
              {#if isSubsystemMember(subsystem)}
                <span class="badge badge-member">Member</span>
              {/if}
            </div>
            </div>
          </div>
          
          {#if subsystem.description}
            <p class="subsystem-description">{subsystem.description}</p>
          {/if}

          <div class="subsystem-info">
            <div class="info-item">
              <Users size={16} />
              <span>{subsystem.subsystem_members.length} member{subsystem.subsystem_members.length !== 1 ? 's' : ''}</span>
            </div>
            {#if subsystem.lead_user}
              <div class="info-item">
                <span class="lead-label">Lead:</span>
                <span>{subsystem.lead_user?.full_name?.split(' ')[0] || subsystem.lead_user?.email || 'Unknown'}</span>
              </div>
            {/if}
          </div>

          {#if subsystem.budget}
            <div class="subsystem-budget">
              <div class="budget-label">
                <div class="budget-title">Budget</div>
                <div class="budget-values" class:over-budget={subsystem.budget.spent > subsystem.budget.amount}>
                   ${subsystem.budget.spent.toLocaleString()} / ${subsystem.budget.amount.toLocaleString()}
                </div>
              </div>
              <div class="budget-progress-track">
                <div 
                   class="budget-progress-fill"
                   class:near={subsystem.budget.spent <= subsystem.budget.amount && subsystem.budget.spent / subsystem.budget.amount >= 0.8}
                   class:over={subsystem.budget.spent > subsystem.budget.amount}
                   style="width: {Math.min((subsystem.budget.spent / subsystem.budget.amount) * 100, 100)}%"
                ></div>
              </div>
            </div>
          {/if}

          {#if subsystem.onshape_url}
            <div class="onshape-section">
              <div class="onshape-header">
                <Link size={16} />
                <span>OnShape Document</span>
                <a 
                  href={subsystem.onshape_url} 
                  target="_blank" 
                  class="external-link"
                  on:click|stopPropagation
                >
                  <ExternalLink size={14} />
                </a>
              </div>
                <div class="onshape-info">
                {#if onshapeData[subsystem.id]?.docInfo}
                  <div class="document-info">
                    <span class="doc-name">{onshapeData[subsystem.id].docInfo.name || 'Document'}</span>
                  </div>
                {/if}
                <div class="click-hint">
                  <span>Click to view timeline and create builds</span>
                </div>
              </div>
            </div>
          {/if}

          <div class="subsystem-actions">
            {#if isSubsystemLead(subsystem)}
              {#if !subsystem.onshape_url}
                <button 
                  class="btn btn-secondary btn-sm" 
                  on:click|stopPropagation={() => { selectedSubsystem = subsystem.id; showLinkModal = true; }}
                >
                  <Link size={16} />
                  Link OnShape
                </button>
              {/if}
              <input 
                id={`file-input-${subsystem.id}`}
                type="file" 
                multiple 
                on:change={(e) => handleFileUpload(subsystem.id, e.currentTarget)}
                style="display: none;"
              />
              <button type="button" class="btn btn-secondary btn-sm" on:click|stopPropagation={() => document.getElementById(`file-input-${subsystem.id}`)?.click()}>
                <Upload size={16} />
                Upload Files
              </button>
            {:else if isSubsystemMember(subsystem)}
              <input 
                id={`file-input-${subsystem.id}`}
                type="file" 
                multiple 
                on:change={(e) => handleFileUpload(subsystem.id, e.currentTarget)}
                style="display: none;"
              />
              <button type="button" class="btn btn-secondary btn-sm" on:click|stopPropagation={() => document.getElementById(`file-input-${subsystem.id}`)?.click()}>
                <Upload size={16} />
                Upload Files
              </button>
            {:else}
              <button 
                class="btn btn-primary btn-sm" 
                on:click|stopPropagation={() => joinSubsystem(subsystem.id)}
              >
                <Edit size={16} />
                Join Subsystem
              </button>
            {/if}
          </div>

          <!-- Builds for this subsystem -->
          {#if builds.filter(b => b.subsystem_id === subsystem.id).length > 0}
            {@const subsystemBuilds = builds.filter(b => b.subsystem_id === subsystem.id)}
            <div class="subsystem-builds">
              <div class="builds-header">
                <FileText size={14} />
                <span>Builds ({subsystemBuilds.length})</span>
              </div>
              <div class="builds-list">
                {#each subsystemBuilds.slice(0, 5) as build}
                  <a 
                    href="/cad/build/{build.id}" 
                    class="build-link"
                    on:click|stopPropagation
                  >
                    <span class="build-name">{build.release_name || 'Build'}</span>
                    <span class="build-status-dot status-{build.status}"></span>
                  </a>
                {/each}
                {#if subsystemBuilds.length > 5}
                  <a 
                    href="/cad/build" 
                    class="build-link more"
                    on:click|stopPropagation
                  >
                    +{subsystemBuilds.length - 5} more builds
                  </a>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if subsystems.length === 0}
        <div class="empty-state">
          <Settings size={48} />
          <h3>No Subsystems Yet</h3>
          <p>Create your first subsystem to get started with CAD management</p>
          <button class="btn btn-primary btn-sm" on:click={openCreateModal}>
            <Plus size={16} />
            Create First Subsystem
          </button>
        </div>      {/if}
    </div>

    <!-- Builds Overview -->
    {#if builds.length > 0}
      <div class="builds-section">
        <h2>All Builds</h2>
        <div class="builds-grid">
          {#each builds as build}
            <div 
              class="surface-card build-card-clickable"
              on:click={() => goto(`/cad/build/${build.id}`)}
              on:keydown={(e) => e.key === 'Enter' && goto(`/cad/build/${build.id}`)}
              role="button"
              tabindex="0"
            >
              <div class="build-header">
                <div class="build-title">
                  <h3>{build.subsystems?.name || 'Unknown'} - {build.release_name}</h3>
                  {#if isTeam9584(build.frc_team)}
                    <span class="tag team-tag tag-9584" title="Team 9584">9584</span>
                  {/if}
                </div>
                <span class="build-status status-{build.status}">
                  {build.status.replace('_', ' ')}
                </span>
              </div>
              <div class="build-info">
                <div class="info-item">
                  <span>Build Hash:</span>
                  <code>{build.build_hash}</code>
                </div>
                <div class="info-item">
                  <span>Created:</span>
                  <span>{formatPacificDate(build.created_at)}</span>
                </div>
                {#if build.creator}
                  <div class="info-item">
                    <span>By:</span>
                    <span>{build.creator.email}</span>
                  </div>
                {/if}
                {#if build.assembled_at}
                  <div class="info-item">
                    <span>Assembled:</span>
                    <span>{formatPacificDate(build.assembled_at)}</span>
                  </div>
                {/if}
              </div>
              <div class="build-actions">
                {#if build.status === 'ready_to_assemble'}
                  <button class="btn btn-primary btn-sm" on:click|stopPropagation={() => markAsAssembled(build.id)}>
                    Mark as Assembled
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Create Subsystem Modal -->
  {#if showCreateModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close subsystem dialog"
      on:click|self={() => { showCreateModal = false; editingSubsystemId = null; }}
      on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showCreateModal = false; editingSubsystemId = null; } }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showCreateModal = false; editingSubsystemId = null; } }}
      >
        <div class="modal-header">
          <h2>{editingSubsystemId ? 'Edit Subsystem' : 'Create New Subsystem'}</h2>
          <button type="button" class="modal-close-button" aria-label="Close subsystem dialog" on:click={() => { showCreateModal = false; editingSubsystemId = null; }}>×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="subsystem-name">Name</label>
            <input 
              id="subsystem-name"
              type="text" 
              bind:value={newSubsystem.name}
              placeholder="e.g., Drivetrain, Arm, Intake"
              required
            />
          </div>
          <div class="form-group">
            <label for="subsystem-description">Description (optional)</label>
            <textarea 
              id="subsystem-description"
              bind:value={newSubsystem.description}
              placeholder="Brief description of the subsystem"
              rows="3"
            ></textarea>
          </div>
          <div class="form-group">
            <label for="subsystem-onshape">OnShape Document URL (optional)</label>
            <input
              id="subsystem-onshape"
              type="url"
              bind:value={newSubsystem.onshape_url}
              placeholder="https://cad.onshape.com/documents/..."
            />
            <small>Paste the OnShape assembly document URL to link it now (you can also link later).</small>
          </div>
        </div>
        <div class="modal-footer">
          {#if editingSubsystemId}
            <button class="btn btn-outline-danger btn-sm" on:click={() => { deleteSubsystem(editingSubsystemId); showCreateModal = false; editingSubsystemId = null; }}>
              <Trash2 size={16} />
              Delete Subsystem
            </button>
          {/if}
          <div class="modal-footer-right">
            <button class="btn btn-secondary btn-sm" on:click={() => { showCreateModal = false; editingSubsystemId = null; }}>
              Cancel
            </button>
            <button class="btn btn-primary btn-sm" on:click={createSubsystem}>
              <Plus size={16} />
              {editingSubsystemId ? 'Update Subsystem' : 'Create Subsystem'}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Link OnShape Modal -->
  {#if showLinkModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close OnShape dialog"
      on:click|self={() => showLinkModal = false}
      on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showLinkModal = false; } }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showLinkModal = false; } }}
      >
        <div class="modal-header">
          <h2>Link OnShape Document</h2>
          <button type="button" class="modal-close-button" aria-label="Close OnShape dialog" on:click={() => showLinkModal = false}>×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="onshape-url">OnShape Assembly URL</label>
            <input 
              id="onshape-url"
              type="url" 
              bind:value={onshapeUrl}
              placeholder="https://cad.onshape.com/documents/..."
              required
            />
            <small>Paste the URL of your OnShape assembly document</small>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" on:click={() => showLinkModal = false}>Cancel</button>
          <button 
            class="btn btn-primary btn-sm" 
            on:click={linkOnShapeDocument}
            disabled={loadingOnShape}
          >
            {#if loadingOnShape}
              <div class="spinner-small"></div>
            {:else}
              <Link size={16} />
            {/if}
            Link Document
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Build BOM Modal -->
  {#if showBuildModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close build BOM dialog"
      on:click|self={() => showBuildModal = false}
      on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showBuildModal = false; } }}
    >
      <div
        class="modal modal-large"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        style="--modal-width: 1050px;"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showBuildModal = false; } }}
      >
        <div class="modal-header">
          <h2>Build BOM - {selectedRelease?.name}</h2>
          <button type="button" class="modal-close-button" aria-label="Close build BOM dialog" on:click={() => showBuildModal = false}>×</button>
        </div>
        <div class="modal-body">
          <div class="bom-actions">
            <button 
              class="btn btn-primary btn-sm" 
              on:click={() => addAllCOTSToPurchasing(builds.find(b => b.release_id === selectedRelease?.id)?.id)}
            >
              Add All COTS to Purchasing
            </button>
            <button 
              class="btn btn-secondary btn-sm" 
              on:click={() => addManufacturedIteration(builds.find(b => b.release_id === selectedRelease?.id)?.id)}
            >
              Manufacture Iteration
            </button>
            <button 
              class="btn btn-secondary btn-sm" 
              on:click={() => buildDuplicate(builds.find(b => b.release_id === selectedRelease?.id)?.id)}
            >
              Build Duplicate
            </button>
          </div>

          <div class="bom-table">
            <table>
              <thead>
                <tr>
                  <th>Part Name</th>
                  <th>Part Number</th>
                  <th>Qty</th>
                  <th>Type</th>
                  <th>Stock</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each buildBOM as item, index}
                  <tr>
                    <td>{item.part_name}</td>
                    <td>{item.part_number || '-'}</td>
                    <td>{item.quantity}</td>
                    <td>
                      <span class="type-badge type-{item.part_type.toLowerCase()}">
                        {item.part_type}
                      </span>
                    </td>
                    <td>{item.stock_assignment || '-'}</td>
                    <td>
                      <span class="status-badge status-{item.status}">
                        {item.status}
                      </span>
                    </td>
                    <td>
                      <button 
                        class="btn btn-sm" 
                        on:click={() => addSinglePartToList(item.id)}
                        disabled={item.added_to_parts_list}
                      >
                        {item.added_to_parts_list ? 'Added' : 'Add'}
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary btn-sm" on:click={() => showBuildModal = false}>Close</button>
        </div>
      </div>
    </div>
  {/if}
{:else}
  <div class="error-container">
    <p>Please log in to access CAD Subsystems.</p>
  </div>
{/if}

<style>
  .cad-container { max-width: 1200px; margin: var(--space-7) auto; padding: 0 var(--space-4); }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--gap-4); flex-wrap: wrap; margin-bottom: var(--space-7); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border); }
  .header-content { display: flex; align-items: center; gap: var(--gap-3); color: var(--accent-strong); }
  .header-content h1 { font-size: var(--font-2xl); margin: 0; color: var(--text); letter-spacing: -0.01em; }
  .header-content p { margin: var(--space-1) 0 0 0; font-size: var(--font-md); color: var(--text-muted); }

  .general-task-signup {
    margin-bottom: var(--space-4);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: grid;
    gap: var(--gap-3);
    box-shadow: var(--shadow-sm);
  }
  .general-task-signup h2 {
    margin: 0;
    font-size: var(--font-md);
    color: var(--text);
  }
  .general-task-signup .muted {
    color: var(--text-muted);
    margin: 0;
  }
  .category-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }
  .category-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--control-height-sm);
    padding: var(--control-padding-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text);
    font-weight: 500;
    cursor: pointer;
    font-size: var(--font-xs);
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease, box-shadow 120ms ease;
  }
  .category-pill:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .category-pill.selected {
    border-color: var(--accent);
    background: var(--accent-subtle);
    color: var(--accent-strong);
    font-weight: 600;
  }
  .category-pill:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--btn-focus-ring);
  }
  .category-pill:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
  .subsystems-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: var(--gap-6); }
  .subsystem-card { background: var(--surface-1); border-radius: var(--radius-lg); border: 1px solid var(--border); padding: var(--space-6); margin-bottom: var(--space-4); box-shadow: var(--shadow-sm); transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; }
  .subsystem-card.clickable { cursor: pointer; }
  .subsystem-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--accent); }
  .subsystem-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-4); gap: var(--gap-2); flex-wrap: wrap; }
  .subsystem-title, .build-title { display: flex; align-items: center; gap: var(--gap-1); flex: 1; min-width: 0; }
  .subsystem-toolbar { display: flex; align-items: center; gap: var(--gap-2); flex-shrink: 0; flex-wrap: wrap; }
  .subsystem-header h3 { margin: 0; color: var(--secondary); font-size: 1.3rem; line-height: 24px; }
  .subsystem-badges { display: flex; align-items: center; gap: var(--gap-1); flex-wrap: wrap; }
  .badge { display: inline-flex; align-items: center; justify-content: center; height: var(--control-height) !important; padding: 0 var(--space-2) !important; border-radius: var(--radius-sm); font-size: var(--font-xs); font-weight: 600; text-transform: uppercase; line-height: 1; box-sizing: border-box; white-space: nowrap; }
  .subsystem-header .btn-outline.btn-small { display: inline-flex; align-items: center; justify-content: center; height: var(--control-height) !important; width: var(--control-height) !important; padding: 0 !important; font-size: var(--font-xs); border-radius: var(--radius-sm); box-sizing: border-box; }
  .badge-lead { background: var(--accent); color: var(--color-white); }
  .badge-member { background: var(--green-base); color: var(--color-white); }
  .subsystem-description { color: var(--neutral-500); margin-bottom: var(--space-4); line-height: 1.5; }
  .subsystem-info { display: flex; flex-direction: column; gap: var(--gap-2); margin-bottom: var(--space-4); }
  .lead-label { font-weight: 500; color: var(--secondary); }

  /* Budget bar (desktop) */
  .subsystem-budget { margin-bottom: var(--space-4); }
  .budget-label { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--font-xs); font-weight: 600; margin-bottom: var(--space-2); }
  .budget-title { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .budget-values { color: var(--text); font-variant-numeric: tabular-nums; }
  .budget-progress-track { height: 8px; background: var(--surface-2); border-radius: var(--radius-sm); overflow: hidden; }
  .budget-progress-fill { height: 100%; background: var(--green-base); border-radius: var(--radius-sm); transition: width 0.3s ease, background 0.3s ease; }
  .budget-progress-fill.near { background: var(--brand-gold-base); }
  .budget-progress-fill.over { background: var(--red-strong); }
  .budget-values.over-budget { color: var(--red-strong); }
  .onshape-section { background: var(--surface-2); border-radius: var(--radius-sm); border: 1px solid transparent; padding: var(--space-4); margin-bottom: var(--space-4); }
  .onshape-header { display: flex; align-items: center; gap: var(--gap-2); color: var(--secondary); font-weight: 500; }
  .external-link { color: var(--accent); text-decoration: none; margin-left: auto; }
  .external-link:hover { color: var(--secondary); }
  .btn-small { font-size: var(--font-xs); padding: 0 var(--space-2); height: 24px; line-height: 1; }

  /* Subsystem builds list */
  .subsystem-builds { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border); }
  .subsystem-builds .builds-header { display: flex; align-items: center; gap: var(--gap-2); color: var(--neutral-500); font-size: var(--font-xs); font-weight: 600; margin-bottom: var(--space-2); text-transform: uppercase; }
  .subsystem-builds .builds-list { display: flex; flex-direction: column; gap: var(--gap-1); }
  .subsystem-builds .build-link { display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); text-decoration: none; color: var(--text); font-size: var(--font-sm); transition: background 0.15s ease; }
  .subsystem-builds .build-link:hover { background: var(--surface-3); }
  .subsystem-builds .build-link.more { color: var(--accent); font-weight: 500; justify-content: center; }
  .subsystem-builds .build-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subsystem-builds .build-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .subsystem-builds .build-status-dot.status-pending { background: var(--brand-gold-strong); }
  .subsystem-builds .build-status-dot.status-manufacturing { background: var(--blue-base); }
  .subsystem-builds .build-status-dot.status-ready_to_assemble { background: var(--green-strong); }
  .subsystem-builds .build-status-dot.status-assembled { background: var(--green-strong); }

  .builds-section { margin-top: var(--space-7); background: var(--primary); border-radius: var(--radius-lg); border: 1px solid var(--border); padding: var(--space-6); margin-bottom: var(--space-4); }
  .builds-section h2 { margin: 0 0 var(--space-6) 0; color: var(--secondary); font-size: var(--font-xl); }
  .builds-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: var(--gap-6); }
  .build-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-4); }
  .build-header h3 { margin: 0; color: var(--secondary); font-size: var(--font-md); }
  .build-status { display: inline-flex; align-items: center; height: var(--control-height); padding: 0 var(--space-3); border-radius: var(--radius-sm); font-size: var(--font-xs); font-weight: 600; text-transform: capitalize; }
  .build-card-clickable { cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
  .build-card-clickable:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); border-color: var(--accent); }
  .build-info { display: flex; flex-direction: column; gap: var(--gap-2); margin-bottom: var(--space-4); }
  .build-info .info-item { display: flex; justify-content: space-between; align-items: center; font-size: var(--font-xs); }
  .build-info .info-item span:first-child { font-weight: 500; color: var(--secondary); }
  .build-info code { background: var(--primary); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font-family: monospace; font-size: var(--font-xs); }
  .build-actions { display: flex; gap: var(--gap-3); }
  .document-info { display: flex; flex-direction: column; gap: var(--gap-1); padding: var(--space-3) 0 0 0; }
  .doc-name { font-weight: 500; color: var(--text); font-size: var(--font-xs); }
  .click-hint { margin-top: var(--space-2); }
  .click-hint span { font-size: var(--font-xs); color: var(--secondary); font-style: italic; }

  /* Subsystem actions buttons */
  .subsystem-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    margin-top: var(--space-4);
  }

  /* Mobile Responsive Styles */
  @media (max-width: 768px) {
    .cad-container {
      margin: var(--space-4) auto;
      padding: 0 var(--space-3);
    }
    
    .header-content h1 {
      font-size: var(--font-xl);
    }
    
    .header-content p {
      font-size: var(--font-xs);
    }
    
    .subsystems-grid {
      grid-template-columns: 1fr;
      gap: var(--gap-4);
    }
    
    .subsystem-card {
      padding: var(--space-4);
    }
    
    .subsystem-header {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--gap-2);
    }
    
    .subsystem-header h3 {
      font-size: 1.1rem;
    }
    
    .subsystem-toolbar {
      width: 100%;
      justify-content: space-between;
    }
    
    .subsystem-actions {
      flex-direction: column;
    }
    
    .subsystem-actions .btn {
      width: 100%;
      justify-content: center;
    }
    
    .builds-section {
      padding: var(--space-4);
      margin-top: var(--space-4);
    }
    
    .builds-section h2 {
      font-size: var(--font-md);
    }
    
    .builds-grid {
      grid-template-columns: 1fr;
    }
    
    .build-header {
      flex-direction: column;
      gap: var(--gap-2);
    }
    
    .build-header h3 {
      font-size: var(--font-base);
    }
    
    .build-actions {
      flex-direction: column;
    }
    
    .build-actions .btn {
      width: 100%;
    }
  }

  @media (max-width: 480px) {
    .cad-container {
      padding: 0 var(--space-2);
    }
    
    .subsystem-card {
      padding: var(--space-3);
    }
    
    .subsystem-header h3 {
      font-size: 1rem;
    }
    
    .subsystem-description {
      font-size: var(--font-xs);
    }
    
    .onshape-section {
      padding: var(--space-3);
    }
    
    .build-info .info-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }
    
    .build-info code {
      word-break: break-all;
      max-width: 100%;
    }
    .subsystem-budget {
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: 1px solid var(--border);
    }
    .budget-label {
      display: flex;
      justify-content: space-between;
      font-size: var(--font-xs);
      font-weight: 600;
      margin-bottom: var(--space-2);
    }
  }
</style>
