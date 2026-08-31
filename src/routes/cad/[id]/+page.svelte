<script>
  import { browser } from '$app/environment';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { hasPermission, GENERAL_ROLES } from '$lib/permissions.js';
  import { onShapeAPI } from '$lib/onshape.js';  
  import { partClassificationService } from '$lib/bom_classify.js';
  import { detectVendorFromString, buildVendorSearchUrl } from '$lib/vendor_detect.js';
  import { formatPacificDate } from '$lib/timezone.js';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Triangle, Circle, Download, Settings, Plus, ShoppingCart, Zap, Copy, Trash2, Users } from 'lucide-svelte';
  import stockData from '$lib/stock.json';

  // Slack bot base URL for purchase notifications (defaults to in-app endpoint)
  const BOT_BASE_URL = import.meta.env?.VITE_BOT_BASE_URL || '/api/971bot';
  async function notifyPurchaseBot(payload) {
    try {
      const res = await fetch(`${BOT_BASE_URL}/notify/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) console.warn('Bot notify failed', await res.text());
    } catch (e) {
      console.warn('Bot notify error', e);
    }
  }

  // Same helper/endpoint as manufacture/+page.svelte's sendNotification -
  // notifies workflow leads (e.g. 3D print leads) that a new request came in.
  async function sendNotification(type, payload = {}) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      await fetch('/api/notifications', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ type, ...payload })
      });
    } catch (err) {
      console.warn('Notification request failed', err);
    }
  }

  let subsystemId = $page.params.id;
  let user = null;
  let loading = true;
  let subsystem = null;
  let timeline = [];
  let selectedVersion = null;
  let showBuildModal = false;
  let buildBOM = [];
  let stockTypes = [];
  let loadingBOM = false;
  // Purchase modal (when auto-detect fails)
  let showPurchaseModal = false;
  let purchaseModalItem = null;
  let purchaseModalUrl = '';
  let purchaseModalPrice = '';
  let loadingBuild = false;  let loadingStep = 'Initializing...';
  
  // Track which parts have been added to the parts table
  let addedPartsSet = new Set();
  
  // Member management state
  let showMemberModal = false;
  let showTransferModal = false;
  let subsystemMembers = [];
  let allUsers = [];
  let memberSearchQuery = '';
  let transferTargetUserId = null;
  let loadingMembers = false;
  const LAST_SUBSYSTEM_STORAGE_KEY = '971hub:lastSubsystem';

  function rememberLastSubsystem(subsystemData) {
    if (!browser || !subsystemData?.id) return;
    localStorage.setItem(LAST_SUBSYSTEM_STORAGE_KEY, JSON.stringify({
      id: subsystemData.id,
      name: subsystemData.name || '',
      updatedAt: new Date().toISOString()
    }));
  }

  onMount(async () => {
    try {
      loadingStep = 'Checking authentication...';
      // Hydrate from UUID first and keep local var in sync
      const unsub = userStore.subscribe((v) => { user = v; });
      await loadUserFromUUID(supabase);

      // Check authentication
      const { data: { session } } = await supabase.auth.getSession();
      if (!session && !user) {
        goto('/');
        return;
      }

      // Persist UUID and hydrate profile from user_profiles
      try {
        setUserUUID(session.user.id);
        await upsertProfileIfMissing(supabase, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.user_metadata?.name || session.user.user_metadata?.full_name || null
        });
        await loadUserFromUUID(supabase);
      } catch (e) {
        console.error('Error handling sign-in:', e);
      }

      loadingStep = 'Loading subsystem data...';
      await loadSubsystem();
      await loadStockTypes();
      
      // Load member details if user is subsystem lead
      if (isSubsystemLead()) {
        await loadSubsystemMembers();
      }
    } catch (error) {
      console.error('Error in onMount:', error);
      goto('/');
    }
  });async function loadSubsystem() {
    try {
      console.log('Loading subsystem with ID:', subsystemId);
      loadingStep = 'Loading subsystem details...';
      
      const { data, error } = await supabase
        .from('subsystems')
        .select(`
          *,
          subsystem_members(user_id)
        `)
        .eq('id', subsystemId)
        .single();

      if (error) throw error;
      subsystem = data;
      rememberLastSubsystem(subsystem);
      
      // Additional logging for debugging membership issues
      console.log('Loaded subsystem:', {
        id: subsystem.id,
        name: subsystem.name,
        members: subsystem.subsystem_members,
        currentUser: user?.id
      });

      if (subsystem.onshape_document_id) {
        console.log('Loading timeline for OnShape document:', subsystem.onshape_document_id);
        loadingStep = 'Loading OnShape timeline...';
        // Add timeout wrapper for timeline loading
        try {
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeline loading timeout')), 45000)
          );
          
          await Promise.race([loadTimeline(), timeoutPromise]);
        } catch (timelineError) {
          console.error('Timeline loading failed or timed out:', timelineError);
          // Continue loading the page even if timeline fails
          timeline = [];
          loadingStep = 'Timeline loading failed, continuing...';
        }
      } else {
        console.log('No OnShape document linked to this subsystem');
      }
    } catch (error) {      console.error('Error loading subsystem:', error);
      // Don't redirect immediately on error, give user chance to see what's happening
      alert('Failed to load subsystem: ' + error.message);
    } finally {
      // Ensure loading is always set to false
      loading = false;
      console.log('Loading state set to false');
    }
  }

  // Local helper to determine whether the current user is a member of a subsystem.
  // Some sibling components expose a similarly-named helper; the child route must
  // provide its own implementation to avoid ReferenceError at runtime.
  function isSubsystemMember(subsystemParam = subsystem) {
    try {
      if (!user || !subsystemParam) return false;
      const members = subsystemParam.subsystem_members || subsystemParam.subsystem_memberships || [];
      // subsystem_members rows contain a user_id field
      return Array.isArray(members) && members.some(m => m && (m.user_id === user.id || m.id === user.id));
    } catch (e) {
      console.warn('isSubsystemMember check failed:', e);
      return false;
    }
  }

  function isGeneralLead() {
    if (!user) return false;
    return user.general_role === GENERAL_ROLES.LEAD || user.role === 'admin';
  }

  // Check if current user is the lead of this subsystem
  function isSubsystemLead(subsystemParam = subsystem) {
    if (!user || !subsystemParam) return false;
    return subsystemParam.lead_user_id === user.id || isGeneralLead();
  }

  async function deleteSubsystem() {
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

      alert('Subsystem deleted successfully');
      goto('/cad');
    } catch (error) {
      console.error('Error deleting subsystem:', error);
      alert('Failed to delete subsystem: ' + error.message);
    }
  }

  // ========================================
  // Member Management Functions
  // ========================================
  
  async function loadSubsystemMembers() {
    loadingMembers = true;
    try {
      // Load current members with their profile info
      const { data: members, error: membersError } = await supabase
        .from('subsystem_members')
        .select('id, user_id, joined_at')
        .eq('subsystem_id', subsystemId);

      if (membersError) throw membersError;

      // Get user profiles for members
      const memberUserIds = members.map(m => m.user_id).filter(id => id);
      let memberProfiles = {};
      
      if (memberUserIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('user_profiles')
          .select('id, full_name, email')
          .in('id', memberUserIds);

        if (!profilesError && profiles) {
          profiles.forEach(p => { memberProfiles[p.id] = p; });
        }
      }

      // Combine member data with profiles
      subsystemMembers = members.map(m => ({
        ...m,
        profile: memberProfiles[m.user_id] || { full_name: 'Unknown', email: '' }
      }));

      console.log('Loaded subsystem members:', subsystemMembers);
    } catch (error) {
      console.error('Error loading subsystem members:', error);
    } finally {
      loadingMembers = false;
    }
  }

  async function loadAllUsers() {
    try {
      const { data: users, error } = await supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .order('full_name');

      if (error) throw error;
      allUsers = users || [];
    } catch (error) {
      console.error('Error loading all users:', error);
      allUsers = [];
    }
  }

  function openMemberModal() {
    loadAllUsers();
    loadSubsystemMembers();
    showMemberModal = true;
  }

  function closeMemberModal() {
    showMemberModal = false;
    memberSearchQuery = '';
  }

  // Filter users for adding - exclude current members
  $: filteredUsersToAdd = allUsers.filter(u => {
    // Exclude users who are already members
    const isMember = subsystemMembers.some(m => m.user_id === u.id);
    if (isMember) return false;
    
    // Filter by search query
    if (!memberSearchQuery) return true;
    const searchLower = memberSearchQuery.toLowerCase();
    return (u.full_name?.toLowerCase().includes(searchLower) || u.email?.toLowerCase().includes(searchLower));
  });

  async function addMemberToSubsystem(userId) {
    try {
      const { error } = await supabase
        .from('subsystem_members')
        .insert({
          subsystem_id: subsystemId,
          user_id: userId
        });

      if (error) {
        if (error.code === '23505') {
          alert('This user is already a member of this subsystem');
        } else {
          throw error;
        }
      } else {
        await loadSubsystemMembers();
        await loadSubsystem(); // Refresh subsystem data
      }
    } catch (error) {
      console.error('Error adding member:', error);
      alert('Failed to add member: ' + error.message);
    }
  }

  async function removeMemberFromSubsystem(memberId, userId) {
    // Don't allow removing the lead
    if (userId === subsystem.lead_user_id) {
      alert('Cannot remove the subsystem lead. Transfer leadership first.');
      return;
    }

    if (!await requestConfirmation({ message: 'Remove this member from the subsystem?', confirmLabel: 'Remove member', danger: true })) {
      return;
    }

    try {
      const { error } = await supabase
        .from('subsystem_members')
        .delete()
        .eq('id', memberId);

      if (error) throw error;
      
      await loadSubsystemMembers();
      await loadSubsystem(); // Refresh subsystem data
    } catch (error) {
      console.error('Error removing member:', error);
      alert('Failed to remove member: ' + error.message);
    }
  }

  function openTransferModal() {
    loadSubsystemMembers();
    transferTargetUserId = null;
    showTransferModal = true;
  }

  function closeTransferModal() {
    showTransferModal = false;
    transferTargetUserId = null;
  }

  // Get eligible users for leadership transfer (current members excluding current lead)
  $: transferEligibleMembers = subsystemMembers.filter(m => m.user_id !== subsystem?.lead_user_id);

  async function transferLeadership() {
    if (!transferTargetUserId) {
      alert('Please select a user to transfer leadership to.');
      return;
    }

    if (!await requestConfirmation({ title: 'Transfer subsystem leadership', message: 'Transfer subsystem leadership? This cannot be undone.', confirmLabel: 'Transfer leadership', danger: true })) {
      return;
    }

    try {
      // Update the subsystem's lead_user_id
      const { error } = await supabase
        .from('subsystems')
        .update({ lead_user_id: transferTargetUserId })
        .eq('id', subsystemId);

      if (error) throw error;

      // Make sure the new lead is a member (in case they weren't)
      const existingMember = subsystemMembers.find(m => m.user_id === transferTargetUserId);
      if (!existingMember) {
        await supabase
          .from('subsystem_members')
          .insert({
            subsystem_id: subsystemId,
            user_id: transferTargetUserId
          });
      }

      alert('Leadership transferred successfully!');
      closeTransferModal();
      closeMemberModal();
      
      // Reload subsystem to reflect changes
      await loadSubsystem();
      await loadSubsystemMembers();
    } catch (error) {
      console.error('Error transferring leadership:', error);
      alert('Failed to transfer leadership: ' + error.message);
    }
  }

  async function loadTimeline() {
    try {
      console.log('Starting timeline load for document:', subsystem.onshape_document_id);
      
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeline loading timeout after 30 seconds')), 30000)
      );
      
      const versionsPromise = onShapeAPI.getDocumentVersions(subsystem.onshape_document_id);
      
      // Race between the API call and timeout
      const allVersions = await Promise.race([versionsPromise, timeoutPromise]);
      console.log('OnShape all versions response:', allVersions);
      
      // Validate response
      if (!Array.isArray(allVersions)) {
        console.warn('Invalid versions response, setting empty timeline');
        timeline = [];
        return;
      }
      
      // Take the last 15 versions (newest first)
      // Sort by creation date descending and take first 15
      const sortedVersions = allVersions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const recentVersions = sortedVersions.slice(0, 15);
      console.log('Recent 15 versions (newest first):', recentVersions);

      // Process all versions - treat them all as buildable
      const timelineItems = recentVersions.map(version => ({
        ...version,
        type: 'version', // All versions are buildable now
        date: new Date(version.createdAt)
      }));

      timeline = timelineItems;
      
      console.log('Final timeline items:', timeline);
    } catch (error) {
      console.error('Error loading timeline:', error);
      // Show user-friendly message for timeouts
      if (error.message.includes('timeout')) {
        console.warn('Timeline loading timed out - OnShape API may be slow');
      }
      timeline = [];
    }
  }

  async function loadStockTypes() {
    try {
      // Always use bundled stock.json to avoid external REST calls to Supabase stock_types.
      stockTypes = stockData || {};
      console.log('Loaded stock types from local stock.json');
      return;

    } catch (error) {
  console.error('Error loading stock types from Supabase, falling back to bundled stock.json:', error?.message || error);
  // Use bundled JSON as a reliable fallback so the UI still functions offline
  stockTypes = stockData || {};
    }
  }

  // Stock selection helpers: allow choosing an existing stock or "Other" and typing custom text.
  function updateStockChoice(index, choice) {
    const item = buildBOM[index];
    if (!item) return;
    item._stock_choice = choice;
    if (choice && choice !== '__other__') {
      item.stock_assignment = choice;
      item.stock_assignment_custom = null;
    } else if (choice === '__other__') {
      item.stock_assignment = '';
      item.stock_assignment_custom = '';
    } else {
      item.stock_assignment = '';
      item.stock_assignment_custom = null;
    }
    buildBOM = [...buildBOM];
  }

  function updateCustomStock(index, value) {
    const item = buildBOM[index];
    if (!item) return;
    item.stock_assignment_custom = value;
    item.stock_assignment = value;
    item._stock_choice = '__other__';
    buildBOM = [...buildBOM];
  }

  async function createBuildFromRelease(release) {
    selectedVersion = release;
    loadingBOM = true;
    showBuildModal = true;

    // Clear previous added parts set for new build
    addedPartsSet = new Set();

    try {
      console.log('Creating build from release:', release);
      console.log('Subsystem data:', subsystem);
      console.log('Workspace ID:', subsystem.onshape_workspace_id);

      // Get BOM from OnShape using the specific version ID
      const bom = await onShapeAPI.getAssemblyBOM(
        subsystem.onshape_document_id,
        subsystem.onshape_workspace_id,
        subsystem.onshape_element_id,
        release.id // Pass the version ID to get BOM from that specific version
      );

      console.log('BOM response:', bom);

      // Analyze BOM and auto-assign stock where appropriate
      buildBOM = await onShapeAPI.analyzeBOM(bom, subsystem.onshape_workspace_id);
      console.log('analyzeBOM returned:', buildBOM);

      if (Array.isArray(buildBOM)) {
        buildBOM.forEach((part, index) => {
          if (part.part_type === 'manufactured') {
            autoAssignStock(index);
          }
        });
      } else {
        console.warn('analyzeBOM did not return an array', buildBOM);
      }
    } catch (error) {
      console.error('Error loading BOM:', error);
      alert('Failed to load BOM: ' + (error?.message || error));
      showBuildModal = false;
    } finally {
      loadingBOM = false;
    }
  }

  async function analyzeBOM(bom) {
    console.log('Analyzing BOM with manual classification rules...');
    
    try {
      // Use the enhanced OnShape API with manual classification
      const analyzedParts = await onShapeAPI.analyzeBOM(bom);
      console.log('Manual classification BOM analysis completed:', analyzedParts);
      
      // Auto-assign stock for all parts
      analyzedParts.forEach((part, index) => {
        if (part.part_type === 'manufactured') {
          autoAssignStock(index);
        }
      });
      
      return analyzedParts;
    } catch (error) {
      console.error('Error with manual classification BOM analysis:', error);
      
      // Fallback to original logic if classification fails
      console.log('Falling back to original BOM analysis logic...');
      const fallbackParts = await fallbackAnalyzeBOM(bom);
      
      // Auto-assign stock for fallback parts too
      fallbackParts.forEach((part, index) => {
        if (part.part_type === 'manufactured') {
          autoAssignStock(index);
        }
      });
      
      return fallbackParts;
    }
  }

  // Fallback BOM analysis (original logic)
  async function fallbackAnalyzeBOM(bom) {
    const analyzedParts = [];
    
    console.log('Analyzing BOM structure:', bom);
    
    // Create a mapping from property names to header IDs for flexible lookup
    const propertyToHeaderId = {};
    bom.headers?.forEach(header => {
      const propName = header.propertyName || header.name?.toLowerCase();
      if (propName) {
        propertyToHeaderId[propName] = header.id;
      }
    });
    
    console.log('Property to Header ID mapping:', propertyToHeaderId);
    
    // Helper function to get value from row by property name
    function getValue(row, propertyName) {
      const headerId = propertyToHeaderId[propertyName];
      return headerId ? row.headerIdToValue?.[headerId] : null;
    }
    
    // Process each row in the BOM
    for (const row of bom.rows || []) {
      let partType = 'manufactured';
      let material = '';
      let workflow = '';
      
      // Extract data using property names (fallback to hardcoded IDs for known structure)
      const headerValues = row.headerIdToValue || {};
      
      // Try to get values using property names first, then fallback to known IDs
      const partName = getValue(row, 'name') || 
                      headerValues['57f3fb8efa3416c06701d60d'] || 
                      'Unknown Part';
      
      const partNumber = getValue(row, 'partNumber') || 
                        headerValues['57f3fb8efa3416c06701d60f'] || 
                        '';
      
      const quantity = getValue(row, 'quantity') || 
                      headerValues['5ace84d3c046ad611c65a0dd'] || 
                      1;
      
      const description = getValue(row, 'description') || 
                         headerValues['57f3fb8efa3416c06701d60e'] || 
                         '';
        const materialData = getValue(row, 'material') || 
                          headerValues['57f3fb8efa3416c06701d615'] || 
                          '';
      
      const vendor = getValue(row, 'vendor') || 
                    headerValues['57f3fb8efa3416c06701d612'] || 
                    '';
      // Attempt vendor detection from part name/number/vendor string
      const detected = detectVendorFromString((vendor || getValue(row, 'name') || getValue(row, 'partNumber') || '').toString());
      if (detected && detected.vendor) {
        // If detection found a vendor and no explicit vendor string, treat as COTS
        if (!vendor || vendor.trim() === '') {
          partType = 'COTS';
        }
      }
      
      console.log('Extracted data for row:', {
        partName,
        partNumber,
        quantity,
        description,
        materialData,
        vendor,
        isStandardContent: row.itemSource?.isStandardContent
      });
      
      // Extract material information
      if (materialData && typeof materialData === 'object') {
        material = materialData.displayName || materialData.name || '';
      } else if (typeof materialData === 'string') {
        material = materialData;
      }
      
      // Enhanced part categorization logic
      const partNameLower = partName.toLowerCase();
      const descriptionLower = description.toLowerCase();
      
      // Rule 1: If vendor is specified, it's COTS (overrides everything)
      if (vendor && vendor.trim() !== '') {
        partType = 'COTS';
      }
      // Rule 2: If part name contains "wcp", it's COTS
      else if (partNameLower.includes('wcp')) {
        partType = 'COTS';
      }
      // Rule 3: If part number starts with capital P, it's manufactured
      else if (partNumber && partNumber.match(/^P/)) {
        partType = 'manufactured';
      }
      // Rule 4: Standard OnShape content is COTS
      else if (row.itemSource?.isStandardContent === true) {
        partType = 'COTS';
      }
      // Rule 5: Common hardware/components (existing logic)
      else if (partNameLower.includes('screw') || partNameLower.includes('bolt') || 
          partNameLower.includes('nut') || partNameLower.includes('washer') ||
          partNameLower.includes('bearing') || partNameLower.includes('motor') ||
          partNameLower.includes('sensor') || partNameLower.includes('wire') ||
          partNameLower.includes('socket') || partNameLower.includes('cap screw') ||
          partNameLower.includes('button head') || partNameLower.includes('standoff') ||
          descriptionLower.includes('purchased') || descriptionLower.includes('cots')) {
        partType = 'COTS';
      } else {
        // Default to manufactured
        partType = 'manufactured';
      }      // Get bounding box for manufactured parts and determine workflow
      let boundingBox = { x: null, y: null, z: null };
      if (partType === 'manufactured' && row.itemSource?.partId && row.itemSource?.elementId) {
        try {
          const wvm = selectedVersion ? 'v' : 'w';
          const wvmId = selectedVersion ? selectedVersion.id : subsystem.onshape_workspace_id;

          // Prefer part-specific elementId/partId when available, otherwise fall back to assembly element
          const partElementId = row.itemSource?.elementId || subsystem.onshape_element_id;
          const partId = row.itemSource?.partId;

          const bbox = await onShapeAPI.getPartBoundingBox(
            subsystem.onshape_document_id,
            wvm,
            wvmId,
            partElementId,
            partId
          );

          if (bbox && (bbox.x != null || bbox.y != null || bbox.z != null)) {
            // Normalize bounding box values
            boundingBox = {
              x: Number(bbox.x || bbox.width || bbox[0] || 0) || 0,
              y: Number(bbox.y || bbox.height || bbox[1] || 0) || 0,
              z: Number(bbox.z || bbox.depth || bbox[2] || 0) || 0
            };

            const dimensions = [boundingBox.x, boundingBox.y, boundingBox.z].sort((a, b) => a - b);
            const [smallest, middle, largest] = dimensions;

            // Convert from meters to inches for easier comparison (OnShape returns meters)
            const smallestInches = smallest * 39.3701;
            const middleInches = middle * 39.3701;
            const largestInches = largest * 39.3701;

            // Rule 1: Plates under 0.5" thick -> laser (except metals)
            if (smallestInches < 0.5) {
              const materialLower = (material || '').toLowerCase();
              if (materialLower.includes('aluminum') || materialLower.includes('steel') ||
                  materialLower.includes('stainless') || materialLower.includes('titanium') ||
                  materialLower.includes('brass') || materialLower.includes('copper')) {
                workflow = 'mill'; // Metals can't be laser cut
              } else if (materialLower.includes('polycarbonate') || materialLower.includes('acrylic') ||
                         materialLower.includes('delrin') || materialLower.includes('lexan') ||
                         materialLower.includes('plexiglass') || materialLower.includes('pmma') ||
                         materialLower.includes('wood') || materialLower.includes('mdf') ||
                         materialLower.includes('plywood') || materialLower.includes('plastic')) {
                workflow = 'laser-cut';
              } else {
                workflow = 'laser-cut';
              }
            }
            // Rule 2: Long shaft-like parts -> lathe
            else if (largestInches > 4 * middleInches && largestInches > 4 * smallestInches) {
              workflow = 'lathe';
            }
            // Rule 3: Default to mill
            else {
              workflow = 'mill';
            }

            console.log(`Part "${partName}" dimensions: ${smallestInches.toFixed(2)}" x ${middleInches.toFixed(2)}" x ${largestInches.toFixed(2)}" -> ${workflow}`);
          }
        } catch (error) {
          console.warn(`Failed to get bounding box for part "${partName}" (${partNumber}):`, error?.message || error);
          // Don't let bounding box errors break the entire BOM processing - fall back to material rules below
        }
      } else if (partType === 'manufactured') {
        // For manufactured parts without bounding box, use material-based workflow
        if (material) {
          const materialLower = material.toLowerCase();
          if (materialLower.includes('aluminum') || materialLower.includes('steel') || 
              materialLower.includes('stainless') || materialLower.includes('titanium') ||
              materialLower.includes('brass') || materialLower.includes('copper')) {
            workflow = 'mill';
          } else if (materialLower.includes('polycarbonate') || materialLower.includes('acrylic') ||
                    materialLower.includes('delrin') || materialLower.includes('lexan') ||
                    materialLower.includes('plexiglass') || materialLower.includes('pmma') ||
                    materialLower.includes('wood') || materialLower.includes('mdf') ||
                    materialLower.includes('plywood')) {
            workflow = 'laser-cut';
          } else if (materialLower.includes('plastic') || materialLower.includes('pla') ||
                     materialLower.includes('abs') || materialLower.includes('petg') ||
                     materialLower.includes('nylon')) {
            workflow = '3d-print';
          } else {
            workflow = 'mill'; // default
          }
        } else {
          workflow = 'mill'; // default
        }
      }
      
      analyzedParts.push({
        part_name: partName,
        part_number: partNumber,
        quantity: quantity,
        part_type: partType,
        material: material,
        workflow: workflow,
        onshape_part_id: row.itemSource?.partId || row.rowId || '',
        bounding_box_x: boundingBox.x,
        bounding_box_y: boundingBox.y,
        bounding_box_z: boundingBox.z,
        stock_assignment: '',
        status: 'pending'
      });
    }
    
    console.log('Analyzed parts (fallback):', analyzedParts);
    return analyzedParts;
  }
  // Function to auto-assign stock based on part properties (updated version)
  function autoAssignStock(index) {
    const part = buildBOM[index];
    if (!part || part.part_type === 'COTS') return;
    
    const workflow = part.workflow;
    const material = (part.material || '').toLowerCase();
    const dimX = part.bounding_box_x * 39.3701; // Convert to inches
    const dimY = part.bounding_box_y * 39.3701;
    const dimZ = part.bounding_box_z * 39.3701;
    const dimensions = [dimX, dimY, dimZ].sort((a, b) => a - b);
    const [minDim, midDim, maxDim] = dimensions;
    
    const workflowStocks = stockData[workflow] || [];
    let bestMatch = null;
    
    // Find best matching stock
    for (const stock of workflowStocks) {
      if (material.includes(stock.material.toLowerCase())) {
        if (workflow === 'laser-cut') {
          // Match by thickness for sheet materials
          if (stock.thickness && Math.abs(minDim - stock.thickness) < 0.1) {
            bestMatch = stock;
            break;
          }
        } else if (workflow === 'lathe') {
          // Match by diameter for round stock
          if (stock.diameter && Math.abs(maxDim - stock.diameter) < 0.1) {
            bestMatch = stock;
            break;
          } else if (stock.diameter_max && maxDim < stock.diameter_max) {
            bestMatch = stock;
          } else if (stock.diameter_min && maxDim > stock.diameter_min) {
            bestMatch = stock;
          } else if (stock.hex_size) {
            // ThunderHex matching
            if (Math.abs(maxDim - stock.hex_size) < 0.1 && midDim < stock.length_max) {
              bestMatch = stock;
              break;
            }
          }
        } else if (workflow === 'router') {
          // Match tube stock
          if (stock.outer_width && stock.outer_height) {
            if ((Math.abs(dimX - stock.outer_width) < 0.1 && Math.abs(dimY - stock.outer_height) < 0.1) ||
                (Math.abs(dimX - stock.outer_height) < 0.1 && Math.abs(dimY - stock.outer_width) < 0.1)) {
              bestMatch = stock;
              break;
            }
          }
        } else {
          // Default material match for mill and 3d-print
          bestMatch = stock;
          break;
        }
      }
    }
    
    // Fallback to first material match if no exact match
    if (!bestMatch) {
      bestMatch = workflowStocks.find(stock => 
        material.includes(stock.material.toLowerCase())
      );
    }
    
    if (bestMatch) {
      part.stock_assignment = bestMatch.description;
    }
  }

  async function confirmBuild() {
    loadingBuild = true;
    try {
      // Use subsystem ID in build hash (not version) so builds can be rolled up across versions
      const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;
      
      const { data: build, error } = await supabase
        .from('builds')
        .insert([{
          subsystem_id: subsystem.id,
          release_id: selectedVersion.id,
          release_name: selectedVersion.name,
          build_hash: buildHash,
          created_by: user.id,
          status: 'pending',
          frc_team: user?.frc_team || null
        }])
        .select()
        .single();

      if (error) throw error;

      // Insert BOM items: save entire BOM as 'other' so they don't affect progress sliders yet
      // First, check if we've already inserted 'other' rows for this build to avoid duplicates
      const { count: existingOtherCount, error: existingOtherErr } = await supabase
        .from('build_bom')
        .select('id', { count: 'exact', head: true })
        .eq('build_id', build.id)
        .eq('part_type', 'other');

      if (existingOtherErr) {
        console.warn('Warning checking existing BOM rows:', existingOtherErr.message);
      }

      const bomItems = buildBOM.map(item => {
        // try to preserve useful metadata for later promotion to manufacturing/purchasing
        const wvm = 'v';
        const wvmid = selectedVersion.id;
        const file_format = 'step';
        return {
          build_id: build.id,
          part_name: item.part_name || item.part_number || 'Unknown Part',
          part_number: item.part_number || null,
          quantity: item.quantity || 1,
          part_type: 'other',
          material: item.material || null,
          stock_assignment: item.stock_assignment || null,
          workflow: item.workflow || item.manufacturing_process || null,
          bounding_box_x: item.bounding_box_x || null,
          bounding_box_y: item.bounding_box_y || null,
          bounding_box_z: item.bounding_box_z || null,
          onshape_part_id: item.onshape_part_id || null,
          onshape_document_id: item.onshape_document_id || subsystem.onshape_document_id || null,
          onshape_wvm: item.onshape_wvm || wvm,
          onshape_wvmid: item.onshape_wvmid || wvmid,
          onshape_element_id: item.onshape_element_id || item.onshape_part_studio_element_id || subsystem.onshape_element_id || null,
          file_format,
          is_onshape_part: !!item.onshape_part_id,
          status: 'pending',
          added_to_parts_list: false,
          added_to_purchasing: false,
          file_url: null
        };
      });

      if (!existingOtherCount || existingOtherCount === 0) {
        const { error: bomError } = await supabase
          .from('build_bom')
          .insert(bomItems);

        if (bomError) throw bomError;
      } else {
        console.log(`Skipped inserting initial BOM: ${existingOtherCount} 'other' rows already exist for this build.`);
      }

      alert('Build created successfully!');
      showBuildModal = false;
      
    } catch (error) {
      console.error('Error creating build:', error);
      alert('Failed to create build: ' + error.message);
    } finally {
      loadingBuild = false;
    }
  }

  async function addAllCOTSToPurchasing() {
    const cotsItems = buildBOM.filter(item => item.part_type === 'COTS');
    // Placeholder for now
    alert(`Would add ${cotsItems.length} COTS items to purchasing`);
  }

  async function confirmAddToPurchasingFromModal() {
    if (!purchaseModalItem) return;
    showPurchaseModal = false;
    try {
      const buildId = purchaseModalItem._buildId || null;
      const queued = {
        name: purchaseModalItem.part_name || purchaseModalItem.part_number || 'Unnamed Part',
        requester: user.full_name || user.email,
        project_id: `${subsystem.name}-${selectedVersion.name}`,
        quantity: purchaseModalItem.quantity || 1,
        material: purchaseModalItem.material || '',
        status: 'pending',
        vendor: null,
        url: purchaseModalUrl && purchaseModalUrl.trim() !== '' ? purchaseModalUrl.trim() : null,
        price: purchaseModalPrice && purchaseModalPrice !== '' ? Number(purchaseModalPrice) : null,
        workflow: 'purchase',
        purchaser: user.id,
        frc_team: user?.frc_team || null
      };
      const { data, error } = await supabase.from('purchasing').insert([queued]).select();
      if (error) throw error;
      const inserted = data?.[0];
      if (inserted) {
        notifyPurchaseBot({
          requester: inserted.requester || queued.requester || 'Unknown',
          item_name: inserted.name,
          project_id: inserted.project_id || '',
          purchase_id: inserted.id
        });
      }

      // insert into build_bom
      const { error: bomError } = await supabase.from('build_bom').insert([{
        build_id: buildId,
        part_name: queued.name,
        part_number: purchaseModalItem.part_number || null,
        quantity: queued.quantity,
        part_type: 'COTS',
        material: queued.material || null,
        workflow: 'purchase',
        stock_assignment: null,
        added_to_purchasing: true,
        status: 'pending'
      }]);
      if (bomError) throw bomError;

      addedPartsSet = new Set([...addedPartsSet, purchaseModalItem.part_number || purchaseModalItem.part_name]);
      purchaseModalItem = null;
      purchaseModalUrl = '';
      purchaseModalPrice = '';
      alert('Added to purchasing');
    } catch (e) {
      console.error('Failed to add from purchase modal:', e);
      alert('Failed to add to purchasing: ' + (e?.message || e));
    }
  }


  async function manufactureIteration() {
    // Check for duplicate parts from previous builds of same subsystem
    try {
      const { data: previousBuilds, error } = await supabase
        .from('builds')
        .select(`
          id,
          build_bom(part_name, part_number, material, workflow)
        `)
        .eq('subsystem_id', subsystem.id)
        .neq('status', 'pending');

      if (error) throw error;

      const existingParts = new Set();
      previousBuilds.forEach(build => {
        build.build_bom.forEach(item => {
          existingParts.add(`${item.part_name}_${item.part_number}_${item.material}_${item.workflow}`);
        });
      });

      const newParts = buildBOM.filter(item => 
        item.part_type === 'manufactured' &&
        !existingParts.has(`${item.part_name}_${item.part_number}_${item.material}_${item.workflow}`)
      );

      alert(`Would add ${newParts.length} new manufactured parts to parts list`);
    } catch (error) {
      console.error('Error checking for duplicates:', error);
      alert('Error checking for duplicate parts');
    }
  }
  async function buildDuplicate() {
    const manufacturedItems = buildBOM.filter(item => item.part_type === 'manufactured');
    alert(`Would add all ${manufacturedItems.length} manufactured parts to parts list`);
  }
  // Download part file (STL or STEP)
  async function downloadPartFile(item, fileType) {
    if (!item.onshape_part_id) {
      alert('No OnShape part ID available for this part');
      return;
    }

    try {
      console.log(`Downloading ${fileType} for part:`, {
        partName: item.part_name,
        partId: item.onshape_part_id,
        documentId: subsystem.onshape_document_id,
        versionId: selectedVersion.id,
        elementId: subsystem.onshape_element_id
      });

      // Determine the action based on file type
      const action = fileType === 'stl' ? 'download-stl' : 'download-step';
      
      // Build the API URL
      const params = new URLSearchParams({
        action: action,
        documentId: subsystem.onshape_document_id,
        elementId: subsystem.onshape_element_id,
        partId: item.onshape_part_id,
        wvm: 'v', // version mode
        wvmId: selectedVersion.id
      });
      
      console.log('API parameters:', Object.fromEntries(params.entries()));
      
      const response = await fetch(`/api/onshape?${params}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('API Error Response:', errorData);
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }
      
      // Create blob and download
      const blob = await response.blob();
      const fileExt = fileType === 'stl' ? 'stl' : 'step';
      const fileName = `${item.part_name || item.part_number || 'part'}.${fileExt}`;
      
      // Trigger download in browser
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      console.log(`${fileType.toUpperCase()} download completed for ${item.part_name}`);
      
    } catch (error) {
      console.error(`${fileType.toUpperCase()} download failed:`, error);
      alert(`Failed to download ${fileType.toUpperCase()}: ${error.message}`);
    }
  }

  // Debug function to test BOM data extraction
  async function debugBOMStructure() {
    if (buildBOM.length > 0) {
      console.log('=== BOM DEBUG INFO ===');
      console.log('Total parts:', buildBOM.length);
      
      buildBOM.slice(0, 3).forEach((part, index) => {
        console.log(`\nPart ${index + 1}:`);
        console.log('  Name:', part.part_name);
        console.log('  Number:', part.part_number);
        console.log('  Material:', part.material);
        console.log('  Type:', part.part_type);
        console.log('  Workflow:', part.workflow);
        console.log('  Vendor:', part.vendor);
        console.log('  Description:', part.description);
        console.log('  Bounding Box:', part.bounding_box_x ? `${(part.bounding_box_x*1000).toFixed(1)}x${(part.bounding_box_y*1000).toFixed(1)}x${(part.bounding_box_z*1000).toFixed(1)}mm` : 'Not available');
      });
      
      const cotsCount = buildBOM.filter(p => p.part_type === 'COTS').length;
      const manufacturedCount = buildBOM.filter(p => p.part_type === 'manufactured').length;
      console.log(`\nCOTS parts: ${cotsCount}`);
      console.log(`Manufactured parts: ${manufacturedCount}`);
      
      const workflowCounts = {};
      buildBOM.forEach(part => {
        if (part.workflow) {
          workflowCounts[part.workflow] = (workflowCounts[part.workflow] || 0) + 1;
        }
      });
      console.log('Workflow distribution:', workflowCounts);
    }
  }
  
  // Function to update part type (COTS vs Manufactured)
  function updatePartType(index, newType) {
    if (buildBOM[index]) {
      buildBOM[index].part_type = newType;
        // Automatically update workflow when changing to COTS
      if (newType === 'COTS') {
        buildBOM[index].workflow = 'purchase';
        buildBOM[index].manufacturing_process = null;
      } else {
        // If changing to manufactured, set default workflow
        buildBOM[index].workflow = buildBOM[index].manufacturing_process || 'mill';
      }
      
      // Auto-assign stock based on part dimensions and workflow
      autoAssignStock(index);
      
      // Force reactivity
      buildBOM = [...buildBOM];
    }
  }
  
  // Function to update workflow/manufacturing process
  function updateWorkflow(index, newWorkflow) {
    if (buildBOM[index]) {
      buildBOM[index].workflow = newWorkflow;      buildBOM[index].manufacturing_process = newWorkflow === 'purchase' ? null : newWorkflow;
      
      // Auto-assign stock when workflow changes
      autoAssignStock(index);
      
      // Force reactivity
      buildBOM = [...buildBOM];
    }
  }
  
  // Get all available stocks for a workflow
  function getStocksForWorkflow(workflow) {
    // Prefer stockTypes loaded from Supabase (if it's an object), but fall back
    // to the bundled stockData. stockTypes may be an array of rows from the DB,
    // so normalize that shape into a map by workflow when needed.
    if (stockTypes) {
      if (!Array.isArray(stockTypes) && typeof stockTypes === 'object') {
        return stockTypes[workflow] || stockData[workflow] || [];
      }

      if (Array.isArray(stockTypes)) {
        const map = {};
        stockTypes.forEach(row => {
          const wk = row.workflow || row.process || 'other';
          if (!map[wk]) map[wk] = [];
          map[wk].push(row);
        });
        return map[workflow] || stockData[workflow] || [];
      }
    }

    return stockData[workflow] || [];
  }  // Add a single item to build and build_bom immediately
  async function addSingleToBuild(item) {
    if (!user || !selectedVersion) {
      alert('User or version not available');
      return;
    }

    // Check if already added
    const partKey = item.part_number || item.part_name || `${item.part_name}_${Date.now()}`;
    if (addedPartsSet.has(partKey)) {
      alert('Part already added to manufacturing queue');
      return;
    }

    loadingBuild = true;
    try {
      // Handle COTS (purchase) items: attempt auto-detect, otherwise prompt modal
      if (item.part_type === 'COTS') {
        try {
          const detection = detectVendorFromString(item.vendor || item.part_name || item.part_number || '');

          // Ensure a build exists (create or find)
          // Use subsystem ID in build hash (not version) so builds can be rolled up across versions
          let buildId = null;
          const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;
          const { data: existingBuild, error: buildQueryError } = await supabase
            .from('builds')
            .select('id')
            .eq('build_hash', buildHash)
            .single();

          if (buildQueryError && buildQueryError.code !== 'PGRST116') {
            throw buildQueryError;
          }
          if (existingBuild) {
            buildId = existingBuild.id;
          } else {
            const { data: newBuild, error: buildError } = await supabase
              .from('builds')
              .insert([{
                subsystem_id: subsystem.id,
                release_id: selectedVersion.id,
                release_name: selectedVersion.name,
                build_hash: buildHash,
                status: 'pending',
                created_by: user.id,
                frc_team: user?.frc_team || null
              }])
              .select()
              .single();
            if (buildError) throw buildError;
            buildId = newBuild.id;
          }

          const vendor = detection?.vendor || item.vendor || null;
          const rawUrl = buildVendorSearchUrl(detection);
          
          // Check if we have a valid, useful URL (not null and not ending with '=' which indicates no search term)
          const hasValidUrl = rawUrl && rawUrl.trim() !== '' && !rawUrl.endsWith('=');

          // Require a valid URL before inserting into purchasing; prompt when URL cannot be determined
          if (!hasValidUrl) {
            purchaseModalItem = { ...item, _buildId: buildId };
            purchaseModalUrl = '';
            purchaseModalPrice = '';
            showPurchaseModal = true;
            loadingBuild = false;
            return;
          }

          // Insert into purchasing
          const purchasingInsertData = {
            name: item.part_name || item.part_number || 'Unnamed Part',
            requester: user.full_name || user.email,
            project_id: subsystem.name,
            quantity: item.quantity || 1,
            material: item.material || '',
            status: 'pending',
            vendor: vendor || null,
            url: rawUrl || null,
            price: null,
            workflow: 'purchase',
            purchaser: user.id,
            frc_team: user?.frc_team || null
          };
          const { data: purchasingData, error: purchasingError } = await supabase.from('purchasing').insert([purchasingInsertData]).select();
          if (purchasingError) throw purchasingError;

          // Insert into build_bom
          const { error: bomError } = await supabase.from('build_bom').insert([{
            build_id: buildId,
            part_name: item.part_name,
            part_number: item.part_number || null,
            quantity: item.quantity || 1,
            part_type: 'COTS',
            material: item.material || null,
            stock_assignment: item.stock_assignment || null,
            workflow: 'purchase',
            bounding_box_x: item.bounding_box_x || null,
            bounding_box_y: item.bounding_box_y || null,
            bounding_box_z: item.bounding_box_z || null,
            onshape_part_id: item.onshape_part_id || null,
            part_id: null,
            status: 'pending',
            added_to_purchasing: true
          }]);
          if (bomError) throw bomError;

          // Mark as added in UI
          addedPartsSet = new Set([...addedPartsSet, item.part_number || item.part_name || `${item.part_name}_${Date.now()}`]);
          loadingBuild = false;
          alert('COTS item added to Purchasing');
          return;
        } catch (err) {
          console.error('Error adding COTS item to purchasing:', err);
          alert('Failed to add COTS item: ' + (err?.message || err));
          loadingBuild = false;
          return;
        }
      }

      // Determine file_url for different workflows
      let file_url = null;
      let file_name = item.part_name || item.part_number || "Part";
      const workflow = item.workflow || item.manufacturing_process;
        // Get OnShape element and part IDs from the BOM row data
      // The onshape_part_id should come from the BOM analysis
      const partId = item.onshape_part_id;
      
      // For element ID, we typically use the assembly element unless we have part-specific data
      const elementId = subsystem.onshape_element_id;
      const wvm = 'v'; // Always use version since we're creating from a specific release
      const wvmid = selectedVersion.id;      // Generate file URLs based on workflow requirements
      if (workflow === 'router' && partId && elementId) {
        file_url = `/parts/d/${subsystem.onshape_document_id}/${wvm}/${wvmid}/e/${elementId}/partid/${partId}/step`;
        file_name = `${item.part_name || item.part_number || "Part"}.step`;
      } else if (workflow === '3d-print' && partId && elementId) {
        file_url = `/parts/d/${subsystem.onshape_document_id}/${wvm}/${wvmid}/e/${elementId}/partid/${partId}/step`;
        file_name = `${item.part_name || item.part_number || "Part"}.step`;
      } else if ((workflow === 'laser-cut' || workflow === 'lathe' || workflow === 'mill') && partId && elementId) {
        // For now, use step files for other workflows as mentioned in requirements
        file_url = `/parts/d/${subsystem.onshape_document_id}/${wvm}/${wvmid}/e/${elementId}/partid/${partId}/step`;
        file_name = `${item.part_name || item.part_number || "Part"}.step`;
      }

      // Project ID format: {subsystem name} (version-independent for rollup)
      const project_id = subsystem.name;
        // Insert into parts table (main manufacturing queue)
      const { data: partData, error: partsError } = await supabase
        .from('parts')
        .insert([{
          name: item.part_name || item.part_number || "Unnamed Part",
          requester: user.full_name || user.email,
          project_id,
          workflow,
          status: 'pending',
          file_name,
          file_url: file_url || '', // OnShape URL or empty if not available
          file_format: workflow === '3d-print' ? 'step' : (workflow === 'laser-cut' || workflow === 'lathe' || workflow === 'mill' || workflow === 'router') ? 'step' : 'step',
          quantity: item.quantity || 1,
          material: item.material || '',
          frc_team: user?.frc_team || null
        }])
        .select();

      if (partsError) throw partsError;

      console.log('Part added to manufacturing queue:', partData);

  const createdPart = Array.isArray(partData) ? partData[0] : partData;
  if (createdPart?.id) {
    sendNotification('manufacturing-request', { part_id: createdPart.id });
  }

      // Create or find existing build for this subsystem (version-independent for rollup)
      let buildId = null;
      const buildHash = `${subsystem.onshape_document_id}_${subsystem.id}`;
      
      // Check if build already exists
      const { data: existingBuild, error: buildQueryError } = await supabase
        .from('builds')
        .select('id')
        .eq('build_hash', buildHash)
        .single();

      if (buildQueryError && buildQueryError.code !== 'PGRST116') { // PGRST116 is "not found"
        throw buildQueryError;
      }

      if (existingBuild) {
        buildId = existingBuild.id;
      } else {
        // Create new build
        const { data: newBuild, error: buildError } = await supabase
          .from('builds')
          .insert([{
            subsystem_id: subsystem.id,
            release_id: selectedVersion.id,
            release_name: selectedVersion.name,
            build_hash: buildHash,
            status: 'pending',
            created_by: user.id,
            frc_team: user?.frc_team || null
          }])
          .select()
          .single();

        if (buildError) throw buildError;
        buildId = newBuild.id;
      }      // Add to build_bom for tracking
      const { error: bomError } = await supabase
        .from('build_bom')
        .insert([{
          build_id: buildId,
          part_name: item.part_name,
          part_number: item.part_number,
          quantity: item.quantity || 1,
          part_type: item.part_type,
          material: item.material,
          stock_assignment: item.stock_assignment,
          workflow: workflow,
          bounding_box_x: item.bounding_box_x,
          bounding_box_y: item.bounding_box_y,
          bounding_box_z: item.bounding_box_z,
          onshape_part_id: partId,
          part_id: createdPart?.id || null,
          file_url: file_url, // Add file URL to build_bom for tracking
          status: 'pending',
          added_to_parts_list: true
        }]);

      if (bomError) throw bomError;

      // Mark as added in UI
      const partKey = item.part_number || item.part_name || `${item.part_name}_${Date.now()}`;
      addedPartsSet = new Set([...addedPartsSet, partKey]);

      // Append created part id to builds.part_ids so build views load it
      if (createdPart && createdPart.id) {
        try {
          const { data: buildRow, error: updErr } = await supabase
            .from('builds')
            .select('part_ids')
            .eq('id', buildId)
            .single();

          if (updErr && updErr.code !== 'PGRST116') throw updErr;

          const currentIds = buildRow?.part_ids || [];
          const newIds = currentIds.includes(createdPart.id) ? currentIds : [...currentIds, createdPart.id];
          if (!currentIds.includes(createdPart.id)) {
            const { error: appendErr } = await supabase
              .from('builds')
              .update({ part_ids: newIds })
              .eq('id', buildId);
            if (appendErr) console.warn('Failed to append part id to build.part_ids', appendErr.message || appendErr);
          }
        } catch (e) {
          console.warn('Error updating build.part_ids:', e?.message || e);
        }
      }

      // Force reactivity update
      buildBOM = [...buildBOM];

      console.log('Part successfully added to manufacturing queue and build tracking');
      
    } catch (error) {
      console.error('Error adding part to manufacturing queue:', error);
      alert('Failed to add part: ' + error.message);
    } finally {
      loadingBuild = false;
    }
  }

  async function joinSubsystem() {
    if (!user || !subsystem) return;
    
    try {
      const { error } = await supabase
        .from('subsystem_members')
        .insert({
          subsystem_id: subsystem.id,
          user_id: user.id
        });

      if (error) {
        if (error.code === '23505') { // unique_violation
          alert('You are already a member of this subsystem');
        } else {
          throw error;
        }
      } else {
        alert('Successfully joined subsystem!');
        // Reload subsystem data to update membership
        await loadSubsystem();
      }
    } catch (error) {
      console.error('Error joining subsystem:', error);
      alert('Failed to join subsystem: ' + error.message);
    }
  }
</script>

<svelte:head>
  <title>{subsystem?.name || 'Subsystem'} Timeline - Spartans Hub</title>
</svelte:head>

{#if loading}
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <p>{loadingStep}</p>
    <small>If this takes more than 30 seconds, there may be an issue with the OnShape API.</small>
  </div>
{:else if subsystem}
  <main class="main-content">
    <header class="page-header">
      <div class="header-content">
        <button class="back-button" on:click={() => goto('/cad')}>
          <ArrowLeft size={20} />
          Back to CAD
        </button>
        <div class="header-info">
          <h1>{subsystem.name}</h1>
          {#if subsystem.description}
            <p class="subsystem-description">{subsystem.description}</p>
          {/if}
        </div>
        {#if isSubsystemLead()}
          <div class="header-actions">
            <button class="btn btn-secondary" on:click={openMemberModal}>
              <Users size={16} />
              Manage Members
            </button>
          </div>
        {/if}
      </div>
    </header>

    <!-- Member Management Section for Subsystem Leads -->
    {#if isSubsystemLead()}
      <section class="member-section">
        <div class="member-section-header">
          <h3>
            <Users size={18} />
            Subsystem Members ({subsystemMembers.length})
          </h3>
          <div class="member-actions">
            <button class="btn btn-sm btn-secondary" on:click={openMemberModal}>
              <Plus size={14} />
              Add Member
            </button>
            <button class="btn btn-sm btn-warning" on:click={openTransferModal}>
              Transfer Leadership
            </button>
          </div>
        </div>
        <div class="member-list-preview">
          {#each subsystemMembers.slice(0, 5) as member}
            <div class="member-chip" class:is-lead={member.user_id === subsystem.lead_user_id}>
              <span class="member-name">{member.profile?.full_name || member.profile?.email || 'Unknown'}</span>
              {#if member.user_id === subsystem.lead_user_id}
                <span class="lead-badge">Lead</span>
              {/if}
            </div>
          {/each}
          {#if subsystemMembers.length > 5}
            <button class="member-chip more-chip" on:click={openMemberModal}>
              +{subsystemMembers.length - 5} more
            </button>
          {/if}
          {#if subsystemMembers.length === 0}
            <p class="no-members">No members yet. Click "Add Member" to add team members.</p>
          {/if}
        </div>
      </section>
    {/if}

    {#if subsystem.onshape_document_id}
      <section class="timeline-section">
        <h2>OnShape Timeline</h2>
        <div class="timeline-container">
          <div class="timeline">            {#each timeline as item}
              <div class="timeline-item" class:release={item.type === 'release'}>
                <div class="timeline-marker">
                  {#if item.type === 'release'}
                    <Triangle size={12} />
                  {:else}
                    <Circle size={8} />
                  {/if}
                </div>
                <div class="timeline-content">
                  <div class="timeline-header">
                    <span class="timeline-name">{item.name}</span>
                    <span class="timeline-date">{formatPacificDate(item.date)}</span>
                  </div>
                  {#if item.description}
                    <p class="timeline-description">{item.description}</p>
                  {/if}
                  {#if isSubsystemMember() && hasPermission(user, 'CREATE_BUILDS')}
                    <button 
                      class="btn btn-primary btn-sm"
                      on:click={() => goto(`/cad/bom?subsystem=${subsystem.id}&version=${item.id}`)}
                    >
                      <Settings size={14} />
                      Create Build
                    </button>
                  {:else if isSubsystemMember()}
                    <p style="color: #666; font-size: 11px; font-style: italic;">You do not have permission to create builds.</p>
                  {:else}
                    <!-- Show join button if user is loaded but not a member -->
                    {#if user && subsystem}
                      <button 
                        class="btn btn-secondary btn-sm"
                        on:click={joinSubsystem}
                        title="Join this subsystem to create builds"
                      >
                        <Plus size={14} />
                        Join to Create Builds
                      </button>
                    {:else if !user}
                      <p style="color: #666; font-size: 11px; font-style: italic;">
                        Please log in to create builds
                      </p>
                    {/if}
                  {/if}
                </div>
              </div>
            {:else}
              <div class="empty-timeline">
                <p>No timeline items available.</p>
                {#if !loading}
                  <p style="font-size: 12px; color: #666;">
                    Failed to load timeline from OnShape. Please try refreshing the page.
                  </p>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </section>
    {:else}
      <div class="no-onshape">
        <p>This subsystem is not linked to an OnShape document.</p>
      </div>
    {/if}
  </main>

  <!-- Build Modal -->
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
        style="--modal-width: 1200px;"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showBuildModal = false; } }}
      >
        <div class="modal-header">
          <h2>Build BOM - {selectedVersion?.name}</h2>
          <button type="button" class="modal-close-button" aria-label="Close build BOM dialog" on:click={() => showBuildModal = false}>×</button>
        </div>

        <div class="modal-content">
          {#if loadingBOM}
            <div class="loading-container">
              <div class="loading-spinner"></div>
              <p>Loading BOM...</p>
            </div>
          {:else}            <div class="bom-actions">
              <button class="btn btn-warning" on:click={addAllCOTSToPurchasing}>
                <ShoppingCart size={16} />
                Add All COTS to Purchasing
              </button>
              <button class="btn btn-primary" on:click={manufactureIteration}>
                <Zap size={16} />
                Manufacture Iteration
              </button>              <button class="btn btn-secondary" on:click={buildDuplicate}>
                <Copy size={16} />
                Build Duplicate
              </button>
            </div><div class="bom-table-container">
              <table class="bom-table">
                <thead>
                  <tr>
                    <th>Part Name</th>
                    <th>Part Number</th>
                    <th>Qty</th>
                    <th>Type</th>
                    <th>Workflow</th>
                    <th>Bounding Box</th>
                    <th>Stock Assignment</th>
                    <th>Action</th>
                    <th>Downloads</th>
                  </tr>
                </thead>
                <tbody>
                  {#each buildBOM as item, index}
                    <tr>
                      <td>
                        <div class="part-name">
                          {item.part_name}
                          {#if item.description}
                            <div class="part-description">{item.description}</div>
                          {/if}
                        </div>
                      </td>
                      <td>{item.part_number || '-'}</td>
                      <td>{item.quantity}</td>                      <td>
                        <select
                          class="workflow-dropdown {item.part_type === 'COTS' ? 'type-cots' : 'type-manufactured'}"
                          value={item.part_type}
                          on:change={(e) => updatePartType(index, e.target.value)}
                          style="background: {item.part_type === 'COTS' ? '#fff8e1' : '#e1f5fe'}; color: {item.part_type === 'COTS' ? '#f57f17' : '#0277bd'}; border: 1px solid {item.part_type === 'COTS' ? '#ffcc02' : '#81d4fa'}"
                        >
                          <option value="COTS" class="type-cots">COTS</option>
                          <option value="manufactured" class="type-manufactured">Manufactured</option>
                        </select>
                      </td>                      <td>
                        {#if item.part_type === 'COTS'}
                          <span class="tag workflow-tag tag-workflow-purchase">
                            Purchase
                          </span>
                        {:else}
                          <select 
                            class="workflow-dropdown workflow-{item.workflow || item.manufacturing_process || 'mill'}" 
                            value={item.workflow || item.manufacturing_process || 'mill'} 
                            on:change={(e) => updateWorkflow(index, e.target.value)}
                          >
                            <option value="3d-print">3D Print</option>
                            <option value="laser-cut">Laser Cut</option>
                            <option value="lathe">Lathe</option>
                            <option value="mill">Mill</option>
                            <option value="router">Router</option>
                          </select>
                        {/if}
                      </td>
                      <td>
                        {#if item.bounding_box_x && item.bounding_box_y && item.bounding_box_z}
                          <div class="bounding-box">
                            {(item.bounding_box_x * 1000).toFixed(1)} × {(item.bounding_box_y * 1000).toFixed(1)} × {(item.bounding_box_z * 1000).toFixed(1)} mm
                          </div>
                        {:else}
                          <span class="no-data">No dimensions</span>
                        {/if}
                      </td>
                      <td>
                        {#if item.part_type !== 'COTS'}
                          <div class="stock-select">
                            <select on:change={(e) => updateStockChoice(index, e.target.value)} value={item._stock_choice || item.stock_assignment}>
                              <option value="">Select Stock</option>
                              {#each getStocksForWorkflow(item.workflow || 'mill') as stock}
                                <option value={stock.description}>{stock.description}</option>
                              {/each}
                              <option value="__other__">Other...</option>
                            </select>

                            {#if (item._stock_choice === '__other__' || (!item._stock_choice && item.stock_assignment_custom !== null))}
                              <input type="text" class="form-input" placeholder="Type custom stock" bind:value={item.stock_assignment_custom} on:input={(e) => updateCustomStock(index, e.target.value)} />
                            {/if}
                          </div>
                        {:else}
                          <span class="no-stock">-</span>
                        {/if}
                      </td>
                      <td>
                        <button
                          class="btn btn-sm btn-add-part"
                          on:click={() => addSingleToBuild(item)}
                        >
                          <Plus size={14} />
                          Add                        </button>
                      </td>
                      <td>
                        {#if item.onshape_part_id && item.part_type === 'manufactured'}
                          <div class="download-buttons">
                            <button
                              class="btn btn-sm btn-download"
                              on:click={() => downloadPartFile(item, 'step')}
                              title="Download STEP for 3D printing"
                            >
                              <Download size={12} />
                              STEP
                            </button>
                            <button
                              class="btn btn-sm btn-download"                              on:click={() => downloadPartFile(item, 'step')}
                              title="Download STEP for CAM"
                            >
                              <Download size={12} />
                              X_T
                            </button>
                          </div>
                        {:else if !item.onshape_part_id}
                          <span class="no-data">No part ID</span>
                        {:else}
                          <span class="no-data">COTS item</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <!-- Removed modal-actions and Create Build button as per requirements -->
          {/if}
        </div>
      </div>
    </div>
  {/if}
  <!-- Purchase Link/Price Modal (queue-only) -->
  {#if showPurchaseModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close purchase dialog"
      on:click|self={() => { showPurchaseModal = false; purchaseModalItem = null; }}
      on:keydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPurchaseModal = false; purchaseModalItem = null; } }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        style="--modal-width: 560px;"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); showPurchaseModal = false; purchaseModalItem = null; } }}
      >
        <div class="modal-header">
          <h3>Provide vendor link and unit price</h3>
          <button type="button" class="modal-close-button" aria-label="Close purchase dialog" on:click={() => { showPurchaseModal = false; purchaseModalItem = null; }}>×</button>
        </div>
        <div class="modal-content">
          <p>Please supply a vendor URL and unit price for <strong>{purchaseModalItem?.part_name || purchaseModalItem?.part_number || 'this part'}</strong></p>
          <div style="display:flex; flex-direction:column; gap:0.5rem;">
            <label for="purchase-url">Vendor link</label>
            <input id="purchase-url" class="form-input" type="text" bind:value={purchaseModalUrl} placeholder="https://..." />
            <label for="purchase-price">Unit price</label>
            <input id="purchase-price" class="form-input" type="number" min="0" step="0.01" bind:value={purchaseModalPrice} />
          </div>
          <div class="modal-actions">
            <button class="btn" on:click={() => { showPurchaseModal = false; purchaseModalItem = null; }}>Cancel</button>
            <button class="btn btn-yellow" on:click={confirmAddToPurchasingFromModal}>Add to Purchasing</button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Member Management Modal -->
  {#if showMemberModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close member management dialog"
      on:click|self={closeMemberModal}
      on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeMemberModal(); } }}
    >
      <div
        class="modal modal-medium"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMemberModal(); } }}
      >
        <div class="modal-header">
          <h3>Manage Subsystem Members</h3>
          <button type="button" class="modal-close-button" aria-label="Close member management dialog" on:click={closeMemberModal}>×</button>
        </div>
        <div class="modal-content">
          <!-- Add New Member Section -->
          <div class="member-add-section">
            <h4>Add Member</h4>
            <input 
              type="text" 
              class="form-input" 
              placeholder="Search users by name or email..." 
              bind:value={memberSearchQuery}
            />
            <div class="user-search-results">
              {#if filteredUsersToAdd.length === 0}
                <p class="no-results">
                  {#if memberSearchQuery}
                    No users found matching "{memberSearchQuery}"
                  {:else}
                    All users are already members
                  {/if}
                </p>
              {:else}
                {#each filteredUsersToAdd.slice(0, 10) as userToAdd}
                  <div class="user-search-item">
                    <div class="user-info">
                      <span class="user-name">{userToAdd.full_name || 'No name'}</span>
                      <span class="user-email">{userToAdd.email}</span>
                    </div>
                    <button 
                      class="btn btn-sm btn-primary" 
                      on:click={() => addMemberToSubsystem(userToAdd.id)}
                    >
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
                {/each}
                {#if filteredUsersToAdd.length > 10}
                  <p class="more-results">Showing 10 of {filteredUsersToAdd.length} results. Refine your search.</p>
                {/if}
              {/if}
            </div>
          </div>

          <!-- Current Members Section -->
          <div class="member-list-section">
            <h4>Current Members ({subsystemMembers.length})</h4>
            {#if loadingMembers}
              <div class="loading-small">Loading members...</div>
            {:else if subsystemMembers.length === 0}
              <p class="no-members">No members in this subsystem yet.</p>
            {:else}
              <div class="member-list">
                {#each subsystemMembers as member}
                  <div class="member-item" class:is-lead={member.user_id === subsystem.lead_user_id}>
                    <div class="member-info">
                      <span class="member-name">{member.profile?.full_name || 'Unknown'}</span>
                      <span class="member-email">{member.profile?.email || ''}</span>
                      {#if member.user_id === subsystem.lead_user_id}
                        <span class="lead-badge">Lead</span>
                      {/if}
                    </div>
                    {#if member.user_id !== subsystem.lead_user_id}
                      <button 
                        class="btn btn-sm btn-danger" 
                        on:click={() => removeMemberFromSubsystem(member.id, member.user_id)}
                        title="Remove member"
                      >
                        <Trash2 size={14} />
                      </button>
                    {:else}
                      <span class="protected-badge" title="Cannot remove the subsystem lead">Protected</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="modal-actions">
            <button class="btn btn-warning" on:click={openTransferModal}>
              Transfer Leadership
            </button>
            <button class="btn btn-secondary" on:click={closeMemberModal}>Close</button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Transfer Leadership Modal -->
  {#if showTransferModal}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      aria-label="Close transfer leadership dialog"
      on:click|self={closeTransferModal}
      on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeTransferModal(); } }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        tabindex="0"
        style="--modal-width: 480px;"
        on:click|stopPropagation
        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTransferModal(); } }}
      >
        <div class="modal-header">
          <h3>Transfer Subsystem Leadership</h3>
          <button type="button" class="modal-close-button" aria-label="Close transfer dialog" on:click={closeTransferModal}>×</button>
        </div>
        <div class="modal-content">
          <p class="transfer-warning">
            ⚠️ You are about to transfer leadership of <strong>{subsystem.name}</strong> to another user. 
            This action cannot be undone. The new lead will have full control over this subsystem.
          </p>

          {#if transferEligibleMembers.length === 0}
            <p class="no-eligible">
              There are no other members to transfer leadership to. 
              Add members to the subsystem first.
            </p>
          {:else}
            <div class="transfer-select">
              <label for="transfer-target">Select new subsystem lead:</label>
              <select id="transfer-target" class="form-input" bind:value={transferTargetUserId}>
                <option value={null}>-- Select a member --</option>
                {#each transferEligibleMembers as member}
                  <option value={member.user_id}>
                    {member.profile?.full_name || member.profile?.email || 'Unknown'}
                  </option>
                {/each}
              </select>
            </div>
          {/if}

          <div class="modal-actions">
            <button class="btn btn-secondary" on:click={closeTransferModal}>Cancel</button>
            <button 
              class="btn btn-danger" 
              on:click={transferLeadership}
              disabled={!transferTargetUserId || transferEligibleMembers.length === 0}
            >
              Confirm Transfer
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
{:else}
  <div class="error-container">
    <h2>Subsystem Not Found</h2>
    <p>The requested subsystem could not be found.</p>
    <button class="btn btn-primary" on:click={() => goto('/cad')}>
      Back to CAD
    </button>
  </div>
{/if}

<style>
  .main-content {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .page-header {
    margin-bottom: 2rem;
  }

  .back-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    text-decoration: none;
    font-size: 0.875rem;
    transition: all 0.2s ease;
  }

  .back-button:hover {
    background: var(--background);
    border-color: var(--primary);
    color: var(--primary);
  }

  .header-info h1 {
    margin: 0;
    color: var(--text);
    font-size: 2rem;
    font-weight: 600;
  }

  .subsystem-description {
    margin: 0.5rem 0 0 0;
    color: var(--secondary);
  }

  .timeline-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1.5rem;
  }

  .timeline-section h2 {
    margin: 0 0 1.5rem 0;
    color: var(--text);
    font-size: 1.5rem;
    font-weight: 600;
  }

  .timeline {
    position: relative;
    padding-left: 2rem;
  }

  .timeline::before {
    content: '';
    position: absolute;
    left: 0.75rem;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--border);
  }

  .timeline-item {
    position: relative;
    margin-bottom: 2rem;
    padding-left: 2rem;
  }

  .timeline-marker {
    position: absolute;
    left: -2rem;
    top: 0.25rem;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    border: 2px solid var(--border);
    border-radius: 50%;
    color: var(--secondary);
  }

  .timeline-item.release .timeline-marker {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--surface);
  }

  .timeline-content {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1rem;
  }

  .timeline-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .timeline-name {
    font-weight: 600;
    color: var(--text);
  }

  .timeline-date {
    font-size: 0.875rem;
    color: var(--secondary);
  }

  .timeline-description {
    margin: 0.5rem 0;
    color: var(--secondary);
    font-size: 0.875rem;
  }

  .no-onshape {
    text-align: center;
    padding: 3rem;
    color: var(--secondary);
  }

  .bom-actions {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .bom-table-container { margin-bottom: 1.5rem; }
  .bom-table { table-layout: auto; font-size: 0.85rem; }
  .bom-table th, .bom-table td { padding: 0.35rem 0.5rem; min-width: 80px; max-width: 350px; white-space: nowrap; vertical-align: middle; }
  .bom-table th { font-size: 0.95rem; font-weight: 600; }
  .bom-table td { font-size: 0.85rem; vertical-align: top; padding: 0.75rem 0.5rem; }

  .part-name { font-weight: 500; }
  .part-description { font-size: 0.75rem; color: var(--secondary); margin-top: 0.25rem; }

  .workflow-mill { background: var(--blue-soft); color: var(--blue-base); border: 1px solid var(--blue-base); }
  .workflow-lasercut { background: var(--brand-gold-soft); color: var(--orange-strong); border: 1px solid var(--brand-gold-base); }
  .workflow-3dprint { background: var(--purple-soft); color: var(--purple-strong); border: 1px solid var(--purple-base); }
  .workflow-router { background: var(--green-soft); color: var(--green-base); border: 1px solid var(--green-base); }
  .workflow-purchase { background: var(--green-soft); color: var(--green-base); border: 1px solid var(--green-base); }
  .workflow-lathe { background: var(--red-soft); color: var(--red-base); border: 1px solid var(--red-base); }

  .workflow-dropdown {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    min-width: 100px;
  }

  .workflow-dropdown:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
  }

  .workflow-dropdown.workflow-mill { background: var(--blue-soft); color: var(--blue-base); border-color: var(--blue-base); }
  .workflow-dropdown.workflow-laser-cut { background: var(--brand-gold-soft); color: var(--orange-strong); border-color: var(--brand-gold-base); }
  .workflow-dropdown.workflow-3d-print { background: var(--purple-soft); color: var(--purple-strong); border-color: var(--purple-base); }
  .workflow-dropdown.workflow-router { background: var(--green-soft); color: var(--green-base); border-color: var(--green-base); }
  .workflow-dropdown.workflow-lathe { background: var(--red-soft); color: var(--red-base); border-color: var(--red-base); }
  .workflow-dropdown.workflow-purchase { background: var(--green-soft); color: var(--green-base); border-color: var(--green-base); }

  .type-badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; display: inline-block; text-transform: uppercase; }
  .type-cots { background: var(--brand-gold-soft); color: var(--orange-strong); border: 1px solid var(--brand-gold-base); }
  .type-manufactured { background: var(--blue-soft); color: var(--blue-base); border: 1px solid var(--blue-base); }

  .bounding-box { font-family: monospace; font-size: 0.75rem; color: var(--secondary); }
  .ai-reasoning { font-size: 0.8rem; color: var(--secondary); max-width: 200px; cursor: help; }
  .fallback-indicator { font-size: 0.75rem; color: var(--warning); font-style: italic; }

  .confidence-bar { position: relative; width: 60px; height: 16px; background: var(--neutral-100); border-radius: 4px; overflow: hidden; }
  .confidence-fill { height: 100%; background: linear-gradient(90deg, var(--orange-strong) 0%, var(--orange-strong) 50%, var(--green-base) 100%); transition: width 0.3s ease; }
  .confidence-text { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 500; color: var(--neutral-500); }

  .no-data { color: var(--secondary); font-style: italic; font-size: 0.75rem; }
  .empty-timeline { text-align: center; padding: 2rem; color: var(--text-muted); }
  .empty-timeline p { margin: 0.5rem 0; }

  .btn-add-part {
    background: var(--blue-base);
    color: var(--color-white);
    border: 1px solid var(--blue-base);
    border-radius: 4px;
    padding: 0.3rem 0.9rem;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .btn-add-part:hover:not(:disabled) { background: var(--blue-base); color: var(--color-white); border-color: var(--blue-base); }
  .btn-add-part:disabled { background: var(--green-soft); color: var(--green-base); border: 1px solid var(--green-soft); cursor: not-allowed; }

  .download-buttons { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .btn-download {
    background: var(--neutral-500);
    color: var(--color-white);
    border: 1px solid var(--neutral-500);
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .btn-download:hover:not(:disabled) { background: var(--neutral-500); color: var(--color-white); border-color: var(--neutral-500); }
  .btn-download:disabled { background: var(--neutral-300); color: var(--neutral-300); border: 1px solid var(--neutral-300); cursor: not-allowed; }

  .form-input { border: 1px solid var(--border); background: var(--background); color: var(--text); }
  .form-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25); }

  select { padding: 0.375rem 0.75rem; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 0.875rem; }

  /* Mobile Responsive Styles */
  @media (max-width: 768px) {
    .main-content {
      padding: var(--space-3);
    }

    .page-header {
      margin-bottom: var(--space-3);
    }

    .header-info h1 {
      font-size: 1.5rem;
    }

    .timeline-section {
      padding: var(--space-3);
    }

    .timeline-section h2 {
      font-size: 1.25rem;
    }

    .timeline-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .timeline-content {
      padding: var(--space-3);
    }

    /* BOM Modal on mobile */
    .modal-large {
      width: 95vw !important;
      max-width: 95vw !important;
      max-height: 90vh;
    }

    .bom-actions {
      flex-direction: column;
      gap: var(--gap-2);
    }

    .bom-actions .btn {
      width: 100%;
      justify-content: center;
    }

    .bom-table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    .bom-table {
      min-width: 800px;
    }

    /* Hide less critical columns on mobile */
    .bom-table th:nth-child(6),
    .bom-table td:nth-child(6),
    .bom-table th:nth-child(9),
    .bom-table td:nth-child(9) {
      display: none;
    }

    .download-buttons {
      flex-direction: column;
    }
  }

  @media (max-width: 480px) {
    .main-content {
      padding: var(--space-2);
    }

    .header-info h1 {
      font-size: 1.25rem;
    }

    .back-button {
      padding: 0.4rem 0.75rem;
      font-size: 0.8rem;
    }

    .timeline {
      padding-left: 1.5rem;
    }

    .timeline-item {
      padding-left: 1rem;
    }

    .timeline-name {
      font-size: 0.9rem;
    }

    .timeline-date {
      font-size: 0.75rem;
    }

    .btn-sm {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
    }
  }

  /* ========================================
     Member Management Styles
     ======================================== */

  .header-content {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 1rem;
  }

  .header-actions {
    margin-left: auto;
  }

  .member-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .member-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .member-section-header h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.1rem;
    color: var(--text);
  }

  .member-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .member-list-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .member-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 20px;
    font-size: 0.85rem;
    color: var(--text);
  }

  .member-chip.is-lead {
    background: var(--primary-soft, #e3f2fd);
    border-color: var(--primary);
  }

  .member-chip.more-chip {
    cursor: pointer;
    background: var(--neutral-100);
    border-color: var(--neutral-300);
    color: var(--secondary);
  }

  .member-chip.more-chip:hover {
    background: var(--neutral-200);
    border-color: var(--primary);
    color: var(--primary);
  }

  .lead-badge {
    background: var(--primary);
    color: white;
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .no-members {
    color: var(--secondary);
    font-style: italic;
    margin: 0;
  }

  /* Modal styles for member management */
  .modal-medium {
    width: 600px;
    max-width: 95vw;
  }

  .member-add-section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .member-add-section h4,
  .member-list-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 1rem;
    color: var(--text);
  }

  .user-search-results {
    max-height: 200px;
    overflow-y: auto;
    margin-top: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
  }

  .user-search-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .user-search-item:last-child {
    border-bottom: none;
  }

  .user-search-item:hover {
    background: var(--surface);
  }

  .user-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .user-name {
    font-weight: 500;
    color: var(--text);
  }

  .user-email {
    font-size: 0.8rem;
    color: var(--secondary);
  }

  .no-results,
  .more-results {
    padding: 1rem;
    text-align: center;
    color: var(--secondary);
    font-style: italic;
    margin: 0;
  }

  .member-list-section {
    margin-bottom: 1rem;
  }

  .member-list {
    max-height: 250px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
  }

  .member-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .member-item:last-child {
    border-bottom: none;
  }

  .member-item.is-lead {
    background: var(--primary-soft, #e3f2fd);
  }

  .member-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .member-info .member-name {
    font-weight: 500;
    color: var(--text);
  }

  .member-info .member-email {
    font-size: 0.8rem;
    color: var(--secondary);
  }

  .protected-badge {
    font-size: 0.75rem;
    color: var(--secondary);
    font-style: italic;
  }

  .loading-small {
    padding: 1rem;
    text-align: center;
    color: var(--secondary);
  }

  /* Transfer Modal Styles */
  .transfer-warning {
    background: var(--warning-soft, #fff3e0);
    border: 1px solid var(--warning, #ff9800);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
    color: var(--text);
    font-size: 0.9rem;
  }

  .no-eligible {
    padding: 1rem;
    text-align: center;
    color: var(--secondary);
    font-style: italic;
  }

  .transfer-select {
    margin-bottom: 1.5rem;
  }

  .transfer-select label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: var(--text);
  }

  .transfer-select select {
    width: 100%;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 0.95rem;
  }

  .btn-danger {
    background: var(--red-base);
    color: white;
    border: 1px solid var(--red-base);
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--red-strong, #c82333);
    border-color: var(--red-strong, #c82333);
  }

  .btn-danger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-warning {
    background: var(--warning, #ff9800);
    color: white;
    border: 1px solid var(--warning, #ff9800);
  }

  .btn-warning:hover:not(:disabled) {
    background: var(--warning-dark, #f57c00);
    border-color: var(--warning-dark, #f57c00);
  }

  @media (max-width: 768px) {
    .header-content {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      margin-left: 0;
    }

    .member-section-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .modal-medium {
      width: 95vw;
    }
  }
</style>
