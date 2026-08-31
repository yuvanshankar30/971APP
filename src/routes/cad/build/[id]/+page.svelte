<script>
  import { onMount } from 'svelte';
  import { requestConfirmation } from '$lib/confirmation.js';
  import { page } from '$app/stores';
  import { supabase } from '$lib/supabase.js';
  import { userStore, loadUserFromUUID, upsertProfileIfMissing, setUserUUID } from '$lib/stores/user.js';
  import { goto } from '$app/navigation';
  import { ArrowLeft, Package, CheckCircle, Clock, Wrench, ExternalLink, MapPin, Plus, Download, Trash2 } from 'lucide-svelte';
  import stockData from '$lib/stock.json';
  import { BUTTONS } from '$lib/statuses.js';
  import { detectVendorFromString, buildVendorSearchUrl } from '$lib/vendor_detect.js';
  import { GENERAL_ROLES } from '$lib/permissions.js';
  import { formatPacificDate, formatPacificDateTimeWithZone } from '$lib/timezone.js';

  let user = null;
  let loading = true;
  let build = null;
  let buildId = $page.params.id;
  let bomSnapshot = [];
  let processingAdd = false;
  let updatingBuildQuantity = false;
  let projectBuilds = [];
  let projectTotalCost = 0;
  let projectPartsCount = 0;
  let buildQuantityInput = '1';

  // Edit modal state for build items (top table)
  let showEditModal = false;
  let editTarget = null;
  let editWorkflow = '';
  let editType = ''; // 'COTS' or 'manufactured'
  let editMaterial = '';
  let editQuantity = 1;
  let editStockAssignment = '';
  let editStockChoice = '';
  let editStockAssignmentCustom = null;

  // Purchase modal (when auto-detect fails)
  let showPurchaseModal = false;
  let purchaseModalItem = null;
  let purchaseModalUrl = '';
  let purchaseModalPrice = '';

  // Version selector modal for refetching BOM
  let showVersionModal = false;
  let versionTimeline = [];
  let loadingVersions = false;
  let selectedVersionForRefetch = null;

  onMount(async () => {
    // Hydrate from UUID and keep local var in sync
    const unsub = userStore.subscribe((v) => { user = v; });
    await loadUserFromUUID(supabase);

    // Check authentication
    const { data: { session } } = await supabase.auth.getSession();
    if (!session && !user) {
      goto('/');
      loading = false;
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

    await loadBuildDetails();
    loading = false;
  });

  function normalizePositiveInt(value, fallback = 1) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.max(1, Math.round(n));
  }

  // Helper function to fetch and cache preview image for a part
  async function fetchAndCachePreviewImage(part) {
    if (!part?.onshape_document_id || !part?.onshape_element_id || !part?.onshape_part_id || !part?.onshape_wvmid) {
      return;
    }
    
    try {
      const params = new URLSearchParams({
        action: 'shaded-views',
        documentId: part.onshape_document_id,
        elementId: part.onshape_element_id,
        partId: part.onshape_part_id,
        wvm: part.onshape_wvm || 'w',
        wvmId: part.onshape_wvmid,
        outputHeight: '800',
        outputWidth: '800'
      });
      
      const response = await fetch(`/api/onshape?${params}`);
      const data = await response.json();
      
      if (data.success && data.image) {
        // Convert base64 to blob and upload to storage
        const byteCharacters = atob(data.image);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'image/png' });
        
        const fileName = `${part.id}.png`;
        const { error: uploadError } = await supabase.storage
          .from('part-previews')
          .upload(fileName, blob, { upsert: true, contentType: 'image/png' });
        
        if (uploadError) {
          console.warn('Failed to upload preview image:', uploadError);
          return;
        }
        
        // Update the parts table with the storage path
        await supabase
          .from('parts')
          .update({ 
            preview_image_url: fileName,
            preview_image_updated_at: new Date().toISOString()
          })
          .eq('id', part.id);
        console.log('Preview image uploaded for part:', part.id, part.name);
      }
    } catch (err) {
      console.warn('Failed to fetch/cache preview image:', err);
    }
  }

  async function loadBuildDetails() {
    try {
      const { data, error } = await supabase
        .from('builds')
        .select(`
          *,
          subsystems(
            id,
            name,
            description,
            onshape_url,
            onshape_document_id,
            onshape_workspace_id,
            onshape_element_id,
            lead_user_id
          )
        `)
        .eq('id', buildId)
        .single();

      if (error) throw error;
      const normalizedBuildQty = normalizePositiveInt(data?.quantity, 1);
      build = { ...data, quantity: normalizedBuildQty };
      buildQuantityInput = String(normalizedBuildQty);

      // Load saved BOM snapshot (all items)
      const { data: bomData, error: bomErr } = await supabase
        .from('build_bom')
        .select('*')
        .eq('build_id', buildId)
        .order('created_at', { ascending: true });
      if (!bomErr) {
        bomSnapshot = (bomData || []).map(it => ({
          ...it,
          _stock_choice: it.stock_assignment_custom ? '__other__' : '',
        }));
      } else {
        console.error('Error loading BOM snapshot:', bomErr);
        bomSnapshot = [];
      }

      // Load actual created items by following relations from build_bom
      // Get all build_bom rows that have been added to the build
      const addedBomRows = bomSnapshot.filter(row => row.added === true);

      // Collect all related IDs
      const partsIds = addedBomRows.filter(row => row.parts_id).map(row => row.parts_id);
      const purchasingIds = addedBomRows.filter(row => row.purchasing_id).map(row => row.purchasing_id);
      const kittingIds = addedBomRows.filter(row => row.kitting_id).map(row => row.kitting_id);

      // Fetch actual created items
      let partsData = [];
      let purchasingData = [];
      let kittingData = [];

      if (partsIds.length > 0) {
        const { data, error: partsError } = await supabase
          .from('parts')
          .select('*')
          .in('id', partsIds);
        if (!partsError) partsData = data || [];
      }

      if (purchasingIds.length > 0) {
        const { data, error: purchasingError } = await supabase
          .from('purchasing')
          .select('*')
          .in('id', purchasingIds);
        if (!purchasingError) purchasingData = data || [];
      }

      if (kittingIds.length > 0) {
        const { data, error: kittingError } = await supabase
          .from('kitting')
          .select('*')
          .in('id', kittingIds);
        if (!kittingError) kittingData = data || [];
      }

      // Update build object to trigger reactivity
      build = {
        ...build,
        parts: partsData,
        purchasing: purchasingData,
        kitting: kittingData
      };

      // Create placeholder entries for added items that don't have relations yet (pending approval)
      const pendingParts = addedBomRows.filter(row =>
        row.part_type === 'manufactured' && !row.parts_id
      ).map(row => ({
        _bom: true,
        bom_id: row.id,
        name: row.part_name,
        part_number: row.part_number || null,
        quantity: row.quantity || 1,
        material: row.material || '',
        workflow: row.workflow || 'mill',
        status: 'needs_approval',
        stock_assignment: row.stock_assignment || null
      }));

      const pendingPurchasing = addedBomRows.filter(row =>
        row.part_type === 'COTS' && (row.workflow || 'purchase') === 'purchase' && !row.purchasing_id
      ).map(row => ({
        _bom: true,
        bom_id: row.id,
        name: row.part_name,
        part_number: row.part_number || null,
        quantity: row.quantity || 1,
        material: row.material || '',
        workflow: 'purchase',
        status: 'needs_approval'
      }));

      const pendingKitting = addedBomRows.filter(row =>
        row.part_type === 'COTS' && row.workflow === 'kit' && !row.kitting_id
      ).map(row => ({
        _bom: true,
        bom_id: row.id,
        name: row.part_name,
        part_number: row.part_number || null,
        quantity: row.quantity || 1,
        material: row.material || '',
        workflow: 'kit',
        status: 'needs_approval'
      }));

  // Merge placeholders with actual created rows
  // Use `let` so variables exist even if an earlier error occurs during load
  let mergedParts = [];
  let mergedPurchasing = [];
  let mergedKitting = [];
  mergedParts = [...(partsData || []), ...(pendingParts || [])];
  mergedPurchasing = [...(purchasingData || []), ...(pendingPurchasing || [])];
  mergedKitting = [...(kittingData || []), ...(pendingKitting || [])];

      // Compute purchasing cost for this build
      let totalCost = 0;
      try {
        totalCost = mergedPurchasing.reduce((sum, p) => {
          const unit = (p.final_price ?? p.price) || 0;
          const qty = p.quantity || 1;
          return sum + (Number(unit) * Number(qty));
        }, 0);
      } catch (e) { totalCost = 0; }

      // Update build object with merged data and total cost
      build = {
        ...build,
        parts: mergedParts,
        purchasing: mergedPurchasing,
        kitting: mergedKitting,
        totalPurchasingCost: totalCost
      };

      // If build has a project_id, load sibling builds in the same project to show project container
      if (build.project_id) {
        try {
          const { data: siblings, error: sibErr } = await supabase.from('builds').select('*, subsystems(name)').eq('project_id', build.project_id).order('created_at', { ascending: false });
          if (!sibErr) {
            projectBuilds = siblings || [];
            projectTotalCost = projectBuilds.reduce((s, b) => s + (b.totalPurchasingCost || 0), 0);
            // compute project parts (row-based) across sibling builds
            try {
              projectPartsCount = projectBuilds.reduce((s, b) => s + (((b.parts||[]).length || 0) + ((b.purchasing||[]).length || 0) + ((b.kitting||[]).length || 0)), 0);
            } catch (e) {
              projectPartsCount = 0;
            }
          }
        } catch (e) {
          projectBuilds = [];
          projectTotalCost = 0;
        }
      }
    } catch (error) {
      console.error('Error loading build details:', error);
      alert('Failed to load build details: ' + error.message);
      goto('/cad/build');
    } finally {
      loading = false;
    }
  }

  async function markAsAssembled() {
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
      await loadBuildDetails();
    } catch (error) {
      console.error('Error marking as assembled:', error);
      alert('Failed to mark as assembled');
    }
  }

  function getStocksForWorkflow(workflow) {
    return stockData[workflow] || [];
  }

  function getBuildProgress() {
    if (!build) return { 
      percent: 0, 
      manufactured: 0, 
      total: 0, 
      status: 'No parts',
      mfgPercent: 0,
      purPercent: 0,
      kitPercent: 0,
      mfgCount: { complete: 0, total: 0 },
      purCount: { complete: 0, total: 0 },
      kitCount: { complete: 0, total: 0 }
    };
    const allParts = [...(build.parts || []), ...(build.purchasing || []), ...(build.kitting || [])];
    if (allParts.length === 0) return { 
      percent: 0, 
      manufactured: 0, 
      total: 0, 
      status: 'No parts',
      mfgPercent: 0,
      purPercent: 0,
      kitPercent: 0,
      mfgCount: { complete: 0, total: 0 },
      purCount: { complete: 0, total: 0 },
      kitCount: { complete: 0, total: 0 }
    };
    const manufactured = allParts.filter(item => item.status === 'complete' || item.status === 'delivered' || item.status === 'kitted').length;
    const inProgress = allParts.filter(item => item.status === 'in-progress' || item.status === 'cammed' || item.status === 'ordered').length;
    let status = 'Requested';
    if (manufactured === allParts.length) status = 'Ready to Assemble';
    else if (inProgress > 0 || manufactured > 0) status = 'Manufacturing';
  // Derive per-workflow lists from the aggregated allParts so counts
  // align with the overall manufactured/total calculations. This
  // handles cases where parts/purchasing/kitting arrays may not be
  // populated consistently but allParts still contains the items.
  const mfgParts = allParts.filter(p => (p.workflow || '').toString() !== 'purchase' && (p.workflow || '').toString() !== 'kit');
  const purParts = allParts.filter(p => (p.workflow || '').toString() === 'purchase');
  const kitParts = allParts.filter(p => (p.workflow || '').toString() === 'kit');

  const mfgComplete = mfgParts.filter(p => p.status === 'complete').length;
  const purComplete = purParts.filter(p => p.status === 'delivered').length;
  const kitComplete = kitParts.filter(p => p.status === 'kitted').length;
    return {
      percent: Math.round((manufactured / allParts.length) * 100),
      manufactured,
      total: allParts.length,
      inProgress,
      status,
      mfgPercent: mfgParts.length ? Math.round((mfgComplete / mfgParts.length) * 100) : 0,
      purPercent: purParts.length ? Math.round((purComplete / purParts.length) * 100) : 0,
      kitPercent: kitParts.length ? Math.round((kitComplete / kitParts.length) * 100) : 0,
      mfgCount: { complete: mfgComplete, total: mfgParts.length },
      purCount: { complete: purComplete, total: purParts.length },
      kitCount: { complete: kitComplete, total: kitParts.length }
    };
  }

  function getWorkflowIcon(workflow) {
    switch (workflow) {
      case '3d-print': return '🖨️';
      case 'laser-cut': return '🔥';
      case 'mill': return '⚙️';
      case 'lathe': return '🔄';
      case 'router': return '🪚';
      case 'purchase': return '🛒';
      default: return '🔧';
    }
  }

  // Build Components edit modal
  function openEditModal(part) {
    // If this is a BOM placeholder (not yet created in parts/purchasing/kitting)
    // we don't open the edit modal. Edits should be performed in the Full BOM
    // editor where the BOM snapshot is persisted.
    if (part && part._bom) {
      // prefer navigating to the full BOM edit page (same route)
      showToast('This item is a queued BOM item. Edit it in the Full BOM section below.');
      return;
    }
    editTarget = part;
    editWorkflow = part.workflow || '';
    editMaterial = part.material || '';
    editQuantity = part.quantity || 1;
    editStockAssignment = part.stock_assignment || '';
    editStockChoice = part._stock_choice || (part.stock_assignment_custom ? '__other__' : '') || '';
    editStockAssignmentCustom = part.stock_assignment_custom ?? null;
    editType = part.workflow === 'purchase' ? 'COTS' : 'manufactured';
    showEditModal = true;
  }

  // Row interaction helpers (like manufacture route)
  function onRowClick(e, part) {
    try {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a') || e.target.closest('select')) return;
    } catch {}
    // If placeholder BOM row, redirect user to the Full BOM section rather
    // than attempting to edit a non-persisted row in the parts/purchasing lists.
    if (part && part._bom) {
      // Smooth scroll to Full BOM section
      const el = document.querySelector('.bom-section:last-of-type');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      showToast('Scroll to Full BOM to edit queued items.');
      return;
    }
    openEditModal(part);
  }

  function onRowKeyDown(e, part) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    try {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a') || e.target.closest('select')) return;
    } catch {}
    e.preventDefault();
    openEditModal(part);
  }

  async function saveEdit() {
    if (!editTarget) {
      showEditModal = false;
      return;
    }
    try {
      const wasCOTS = editTarget?.workflow === 'purchase';
      const wantsCOTS = editType === 'COTS';

      // Find the corresponding build_bom row for synchronization
      let bomRow = null;
      if (editTarget._bom && editTarget.bom_id) {
        // This is a BOM placeholder, find the build_bom row
        bomRow = bomSnapshot.find(row => row.id === editTarget.bom_id);
      } else {
        // This is a created part, find the build_bom row by relation
        bomRow = bomSnapshot.find(row =>
          (row.parts_id === editTarget.id) ||
          (row.purchasing_id === editTarget.id) ||
          (row.kitting_id === editTarget.id)
        );
      }

      if (wasCOTS !== wantsCOTS) {
        // Project ID uses subsystem name only (version-independent for rollup)
        const project_id = build?.subsystems?.name || 'Project';
        if (wantsCOTS) {
          // Converting from manufactured to COTS - create purchasing entry
          const purchasingInsertData = {
            name: editTarget.name || editTarget.part_name || 'Unnamed Item',
            requester: user?.full_name || user?.email,
            project_id,
            quantity: editQuantity || editTarget.quantity || 1,
            material: editMaterial || editTarget.material || '',
            status: 'pending',
            vendor: editTarget.vendor || null,
            url: null,
            price: null,
            workflow: 'purchase',
            frc_team: user?.frc_team || null
          };
          const { data: pur, error: purErr } = await supabase.from('purchasing').insert([purchasingInsertData]).select();
          if (purErr) throw purErr;
          const newId = pur?.[0]?.id;
          if (newId) {
            // Update build_bom with the new relation
            if (bomRow) {
              await supabase.from('build_bom').update({
                purchasing_id: newId,
                parts_id: null,
                kitting_id: null
              }).eq('id', bomRow.id);
            }
          }
        } else {
          // Converting from COTS to manufactured - create parts entry
          const wf = editWorkflow && editWorkflow !== 'purchase' ? editWorkflow : 'mill';
          const baseInsert = {
            name: editTarget.name || editTarget.part_name || 'Unnamed Part',
            requester: user?.full_name || user?.email,
            project_id,
            workflow: wf,
            status: 'pending',
            quantity: editQuantity || editTarget.quantity || 1,
            material: editMaterial || editTarget.material || '',
            file_name: '',
            file_url: '',
            frc_team: user?.frc_team || null
          };
          const finalStock = (editStockChoice === '__other__') ? (editStockAssignmentCustom || editStockAssignment || null) : (editStockChoice || editStockAssignment || null);
          let partRow = null;
          let primaryError = null;
          try {
            const { data, error } = await supabase.from('parts').insert([{ ...baseInsert, stock_assignment: finalStock || null }]).select();
            if (error) primaryError = error; else partRow = data?.[0] || null;
          } catch (e) { primaryError = e; }
          if (!partRow) {
            if (primaryError && String(primaryError.message || primaryError).includes('stock_assignment') && String(primaryError.message || primaryError).includes('does not exist')) {
              const { data, error } = await supabase.from('parts').insert([baseInsert]).select();
              if (error) throw error;
              partRow = data?.[0] || null;
            } else if (primaryError) {
              throw primaryError;
            }
          }
          if (partRow?.id) {
            // Update build_bom with the new relation
            if (bomRow) {
              await supabase.from('build_bom').update({
                parts_id: partRow.id,
                purchasing_id: null,
                kitting_id: null
              }).eq('id', bomRow.id);
            }
          }
        }
        await loadBuildDetails();
        showEditModal = false;
        editTarget = null;
        return;
      }

      // Same type, just update existing entry
      if (editType === 'COTS') {
        const { error } = await supabase
          .from('purchasing')
          .update({
            material: editMaterial,
            quantity: editQuantity
          })
          .eq('id', editTarget.id);
        if (error) throw error;

        // Also update build_bom if we have a relation
        if (bomRow) {
          await supabase.from('build_bom').update({
            material: editMaterial,
            quantity: editQuantity
          }).eq('id', bomRow.id);
        }
      } else {
        // Try updating stock_assignment too; if column doesn't exist, retry without it
        let updateError = null;
        const baseUpdate = {
          workflow: editWorkflow || null,
          material: editMaterial,
          quantity: editQuantity
        };
        // Determine final stock value from choice/custom fields
        const finalStock = (editStockChoice === '__other__') ? (editStockAssignmentCustom || editStockAssignment || null) : (editStockChoice || editStockAssignment || null);
        try {
          const { error } = await supabase
            .from('parts')
            .update({
              ...baseUpdate,
              stock_assignment: finalStock
            })
            .eq('id', editTarget.id);
          if (error) updateError = error;
        } catch (e) {
          updateError = e;
        }
        if (updateError) {
          const msg = String(updateError.message || updateError);
          if (msg.includes('stock_assignment') && msg.includes('does not exist')) {
            const { error: e2 } = await supabase
              .from('parts')
              .update(baseUpdate)
              .eq('id', editTarget.id);
            if (e2) throw e2;
          } else {
            throw updateError;
          }
        }

        // Also update build_bom if we have a relation
        if (bomRow) {
          await supabase.from('build_bom').update({
            ...baseUpdate,
            stock_assignment: finalStock,
            stock_assignment_custom: editStockChoice === '__other__' ? (editStockAssignmentCustom || '') : null
          }).eq('id', bomRow.id);
        }
      }
      await loadBuildDetails();
    } catch (e) {
      console.error('Edit save failed:', e);
      alert('Failed to save changes');
    } finally {
      showEditModal = false;
      editTarget = null;
    }
  }

  async function removeBuildAssociation(partId) {
    try {
      // Normalize the incoming id to the probable DB type
      // parts/purchasing/kitting use bigint ids; build_bom stores those in columns parts_id, purchasing_id, kitting_id
      // If the id is a string that looks like a number, coerce to Number so the query matches correctly.
      const normalizedId = (typeof partId === 'string' && /^\d+$/.test(partId)) ? Number(partId) : partId;

      // Find any build_bom rows that reference this id so we can report them if clearing fails
      const { data: referencingRows, error: refErr } = await supabase.from('build_bom').select('id, parts_id, purchasing_id, kitting_id, build_id').or(
        `parts_id.eq.${normalizedId},purchasing_id.eq.${normalizedId},kitting_id.eq.${normalizedId}`
      );
      if (refErr) {
        console.warn('Error querying build_bom for references:', refErr);
      }

      // Attempt targeted clears only for the columns that actually reference this id
      // If there are any build_bom rows referencing this id, clear the specific
      // relation column and mark the BOM row as not added (added = false).
      // This intentionally does NOT block deletion of the parts/purchasing/kitting
      // row: we want to remove the created item while keeping the BOM row.
      if (referencingRows && referencingRows.length > 0) {
        const partsRefs = referencingRows.filter(r => r.parts_id === normalizedId).map(r => r.id);
        const purchRefs = referencingRows.filter(r => r.purchasing_id === normalizedId).map(r => r.id);
        const kitRefs = referencingRows.filter(r => r.kitting_id === normalizedId).map(r => r.id);

        async function clearBomRows(column, ids) {
          if (!ids || ids.length === 0) return;
          try {
            const patch = {};
            patch[column] = null;
            patch.added = false;
            const { error } = await supabase.from('build_bom').update(patch).in('id', ids);
            if (error) throw error;
          } catch (e) {
            // Log but don't block deletion; best-effort update to BOM rows
            console.warn(`Error clearing ${column} references in build_bom for ids ${ids}:`, e);
          }
        }

        await clearBomRows('parts_id', partsRefs);
        await clearBomRows('purchasing_id', purchRefs);
        await clearBomRows('kitting_id', kitRefs);
      }

      // Attempt deletion from each table; only one should match but trying all is safe.
      // If deletion fails due to lingering FK refs, the errors will be surfaced to the user.
      const { error: delPartsErr } = await supabase.from('parts').delete().eq('id', normalizedId);
      if (delPartsErr && String(delPartsErr.message || delPartsErr).toLowerCase().includes('foreign key')) {
        console.error('Failed to delete part due to foreign key:', delPartsErr);
        alert('Failed to delete part: ' + delPartsErr.message);
        return;
      }
      if (delPartsErr) console.warn('Non-critical error deleting from parts:', delPartsErr);

      const { error: delPurchErr } = await supabase.from('purchasing').delete().eq('id', normalizedId);
      if (delPurchErr && String(delPurchErr.message || delPurchErr).toLowerCase().includes('foreign key')) {
        console.error('Failed to delete purchasing due to foreign key:', delPurchErr);
        alert('Failed to delete purchasing entry: ' + delPurchErr.message);
        return;
      }
      if (delPurchErr) console.warn('Non-critical error deleting from purchasing:', delPurchErr);

      const { error: delKitErr } = await supabase.from('kitting').delete().eq('id', normalizedId);
      if (delKitErr && String(delKitErr.message || delKitErr).toLowerCase().includes('foreign key')) {
        console.error('Failed to delete kitting due to foreign key:', delKitErr);
        alert('Failed to delete kitting entry: ' + delKitErr.message);
        return;
      }
      if (delKitErr) console.warn('Non-critical error deleting from kitting:', delKitErr);

      // Reload the build details to reflect changes
      await loadBuildDetails();
    } catch (e) {
      console.error('Remove from build failed:', e);
      alert('Failed to remove from build: ' + (e?.message || e));
    }
  }

  // Full BOM (bottom table) - editing helpers
  function finalStockFromRow(item) {
    return item._stock_choice === '__other__'
      ? (item.stock_assignment_custom || item.stock_assignment || null)
      : (item._stock_choice || item.stock_assignment || null);
  }

  async function persistBomUpdate(itemId, patch) {
    try {
      const { error } = await supabase.from('build_bom').update(patch).eq('id', itemId);
      if (error) throw error;
    } catch (e) {
      console.error('Failed to persist BOM update:', e);
      alert('Failed to update BOM row: ' + (e?.message || e));
    }
  }

  function updateBomType(index, newType) {
    const item = bomSnapshot[index];
    if (!item) return;
    item.part_type = newType;
    if (newType === 'COTS') {
      item.workflow = 'purchase';
    } else {
      item.workflow = item.workflow && item.workflow !== 'purchase' ? item.workflow : 'mill';
    }
    bomSnapshot = [...bomSnapshot];
    persistBomUpdate(item.id, { part_type: item.part_type, workflow: item.workflow });
  }

  function updateBomWorkflow(index, newWorkflow) {
    const item = bomSnapshot[index];
    if (!item || item.part_type === 'COTS') return;
    item.workflow = newWorkflow;
    bomSnapshot = [...bomSnapshot];
    persistBomUpdate(item.id, { workflow: item.workflow });
  }

  // COTS workflow (Purchase vs Kit) selector in Full BOM
  function setCotsWorkflow(index, wf) {
    const item = bomSnapshot[index];
    if (!item || item.part_type !== 'COTS') return;
    item.workflow = (wf === 'kit') ? 'kit' : 'purchase';
    bomSnapshot = [...bomSnapshot];
    persistBomUpdate(item.id, { workflow: item.workflow });
  }

  function updateBomStockChoice(index, choice) {
    const item = bomSnapshot[index];
    if (!item || item.part_type === 'COTS') return;
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
    bomSnapshot = [...bomSnapshot];
    const finalStock = finalStockFromRow(item);
    persistBomUpdate(item.id, { stock_assignment: finalStock, stock_assignment_custom: item._stock_choice === '__other__' ? (item.stock_assignment_custom || '') : null });
  }

  function updateBomCustomStock(index, value) {
    const item = bomSnapshot[index];
    if (!item || item.part_type === 'COTS') return;
    item.stock_assignment_custom = value;
    item.stock_assignment = value;
    item._stock_choice = '__other__';
    bomSnapshot = [...bomSnapshot];
    persistBomUpdate(item.id, { stock_assignment: value, stock_assignment_custom: value });
  }

  // Full BOM - Add action
  async function addFromFullBOM(item) {
    if (!item) return;
    if (processingAdd) return;
    processingAdd = true;
    try {
      // Project ID uses subsystem name only (version-independent for rollup)
      const project_id = build?.subsystems?.name || 'Project';

      if (item.part_type === 'COTS' && item.workflow === 'kit') {
        // Insert into kitting (in-stock COTS, just assign to bin later)
        const kittingInsertData = {
          name: item.part_name || item.part_number || 'Unnamed Item',
          requester: user?.full_name || user?.email,
          project_id,
          quantity: item.quantity || 1,
          status: 'pending',
          workflow: 'kit'
        };
        const { data: kit, error: kitErr } = await supabase
          .from('kitting')
          .insert([kittingInsertData])
          .select();
        if (kitErr) throw kitErr;
        const k = kit?.[0];

        if (k?.id) {
          // Update build_bom with the new relation
          await supabase.from('build_bom').update({
            kitting_id: k.id,
            added: true
          }).eq('id', item.id);
        }
      } else if (item.part_type === 'COTS' || item.workflow === 'purchase') {
        // Attempt vendor detection
        const detection = detectVendorFromString(item.vendor || item.part_name || item.part_number || '');
        
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
          processingAdd = false;
          return;
        }
        
        // Insert into purchasing with validated URL
        const purchasingInsertData = {
          name: item.part_name || item.part_number || 'Unnamed Item',
          requester: user?.full_name || user?.email,
          project_id,
          quantity: item.quantity || 1,
          material: item.material || '',
          status: 'pending',
          vendor: vendor || null,
          url: rawUrl || null,
          price: null,
          workflow: 'purchase',
          frc_team: user?.frc_team || null
        };
        const { data: pur, error: purErr } = await supabase
          .from('purchasing')
          .insert([purchasingInsertData])
          .select();
        if (purErr) throw purErr;
        const p = pur?.[0];

        if (p?.id) {
          // Update build_bom with the new relation
          await supabase.from('build_bom').update({
            purchasing_id: p.id,
            added: true
          }).eq('id', item.id);
        }
      } else {
        // Insert into parts (manufactured)
        const wf = item.workflow || 'mill';
        const file_format =
          wf === '3d-print' ? 'step' :
          (wf === 'laser-cut' || wf === 'lathe' || wf === 'mill' || wf === 'router') ? 'step' : 'step';

        const baseInsert = {
          name: item.part_name || item.part_number || 'Unnamed Part',
          requester: user?.full_name || user?.email,
          project_id,
          workflow: wf,
          status: 'pending',
          quantity: item.quantity || 1,
          material: item.material || '',
          file_name: '',
          file_url: '',
          frc_team: user?.frc_team || null
        };

        const stock_assignment_value = finalStockFromRow(item);

        let partRow = null;
        let primaryError = null;
        try {
          const withOnshape = {
            ...baseInsert,
            stock_assignment: stock_assignment_value || null,
            onshape_document_id: item.onshape_document_id || build?.subsystems?.onshape_document_id || null,
            onshape_wvm: item.onshape_wvm || (build?.release_id ? 'v' : 'w'),
            onshape_wvmid: item.onshape_wvmid || build?.release_id || build?.subsystems?.onshape_workspace_id || null,
            onshape_element_id: item.onshape_element_id || item.onshape_part_studio_element_id || build?.subsystems?.onshape_element_id || null,
            onshape_part_id: item.onshape_part_id || null,
            file_format,
            is_onshape_part: !!(item.onshape_document_id || item.onshape_part_id)
          };
          const { data, error } = await supabase.from('parts').insert([withOnshape]).select();
          if (error) primaryError = error;
          else partRow = data?.[0] || null;
        } catch (e) {
          primaryError = e;
        }

        if (!partRow) {
          if (primaryError && String(primaryError.message || primaryError).includes('stock_assignment') && String(primaryError.message || primaryError).includes('does not exist')) {
            // Retry without stock_assignment
            const withOnshapeNoStock = {
              ...baseInsert,
              onshape_document_id: item.onshape_document_id || build?.subsystems?.onshape_document_id || null,
              onshape_wvm: item.onshape_wvm || (build?.release_id ? 'v' : 'w'),
              onshape_wvmid: item.onshape_wvmid || build?.release_id || build?.subsystems?.onshape_workspace_id || null,
              onshape_element_id: item.onshape_element_id || item.onshape_part_studio_element_id || build?.subsystems?.onshape_element_id || null,
              onshape_part_id: item.onshape_part_id || null,
              file_format,
              is_onshape_part: !!(item.onshape_document_id || item.onshape_part_id)
            };
            const { data, error } = await supabase.from('parts').insert([withOnshapeNoStock]).select();
            if (error) throw error;
            partRow = data?.[0] || null;
          } else {
            // fallback to basic insert
            const { data, error } = await supabase.from('parts').insert([baseInsert]).select();
            if (error) throw error;
            partRow = data?.[0] || null;
          }
        }

        if (partRow?.id) {
          // Update build_bom with the new relation
          await supabase.from('build_bom').update({
            parts_id: partRow.id,
            added: true
          }).eq('id', item.id);
          
          // Fetch and cache preview image in the background (don't block)
          if (partRow.is_onshape_part) {
            fetchAndCachePreviewImage(partRow);
          }
        }
      }

      await loadBuildDetails();
    } catch (e) {
      console.error('Add from Full BOM failed:', e);
      alert('Failed to add item to build: ' + (e?.message || e));
    } finally {
      processingAdd = false;
    }
  }

  async function confirmAddToPurchasingFromModal() {
    if (!purchaseModalItem) return;
    showPurchaseModal = false;
    
    // Project ID uses subsystem name only (version-independent for rollup)
    const project_id = build?.subsystems?.name || 'Project';
    
    try {
      // Insert into purchasing with user-provided URL and price
      const purchasingInsertData = {
        name: purchaseModalItem.part_name || purchaseModalItem.part_number || 'Unnamed Item',
        requester: user?.full_name || user?.email,
        project_id,
        quantity: purchaseModalItem.quantity || 1,
        material: purchaseModalItem.material || '',
        status: 'pending',
        vendor: purchaseModalItem.vendor || null,
        url: purchaseModalUrl && purchaseModalUrl.trim() !== '' ? purchaseModalUrl.trim() : null,
        price: purchaseModalPrice && purchaseModalPrice !== '' ? Number(purchaseModalPrice) : null,
        workflow: 'purchase',
        frc_team: user?.frc_team || null
      };
      
      const { data: pur, error: purErr } = await supabase
        .from('purchasing')
        .insert([purchasingInsertData])
        .select();
      if (purErr) throw purErr;
      
      const p = pur?.[0];
      if (p?.id) {
        // Update build_bom with the new relation
        await supabase.from('build_bom').update({
          purchasing_id: p.id,
          added: true
        }).eq('id', purchaseModalItem.id);
      }

      await loadBuildDetails();
      alert('Added to purchasing successfully!');
      
    } catch (e) {
      console.error('Failed to add from purchase modal:', e);
      alert('Failed to add to purchasing: ' + (e?.message || e));
    } finally {
      purchaseModalItem = null;
      purchaseModalUrl = '';
      purchaseModalPrice = '';
    }
  }

  function isGeneralLead() {
    if (!user) return false;
    return user.general_role === GENERAL_ROLES.LEAD || user.role === 'admin';
  }

  // Check if current user is the lead of this build's subsystem
  function isSubsystemLead() {
    if (!build || !user) return false;
    // Need to fetch the subsystem lead_user_id
    return build.subsystems?.lead_user_id === user.id || isGeneralLead();
  }

  async function deleteBuild() {
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

      alert('Build deleted successfully');
      goto('/cad/build');
    } catch (error) {
      console.error('Error deleting build:', error);
      alert('Failed to delete build: ' + error.message);
    }
  }

  async function updateBuildQuantity() {
    if (!build) return;
    const oldQty = normalizePositiveInt(build.quantity, 1);
    const newQty = normalizePositiveInt(buildQuantityInput, oldQty);
    if (newQty === oldQty) {
      buildQuantityInput = String(oldQty);
      return;
    }

    if (!await requestConfirmation({ title: 'Update build quantity', message: `Update build quantity from ${oldQty} to ${newQty}? This rescales all associated BOM, manufacturing, purchasing, and kitting quantities.`, confirmLabel: 'Update quantity' })) {
      buildQuantityInput = String(oldQty);
      return;
    }

    updatingBuildQuantity = true;
    try {
      const ratio = newQty / oldQty;

      const { error: buildErr } = await supabase
        .from('builds')
        .update({ quantity: newQty })
        .eq('id', buildId);
      if (buildErr) throw buildErr;

      const { data: rows, error: rowsErr } = await supabase
        .from('build_bom')
        .select('id, quantity, parts_id, purchasing_id, kitting_id')
        .eq('build_id', buildId);
      if (rowsErr) throw rowsErr;

      const bomRows = rows || [];
      const scaledByBomId = new Map();
      const partTotals = new Map();
      const purchasingTotals = new Map();
      const kittingTotals = new Map();

      for (const row of bomRows) {
        const current = normalizePositiveInt(row.quantity, 1);
        const next = Math.max(1, Math.round(current * ratio));
        scaledByBomId.set(row.id, next);

        if (row.parts_id) partTotals.set(row.parts_id, (partTotals.get(row.parts_id) || 0) + next);
        if (row.purchasing_id) purchasingTotals.set(row.purchasing_id, (purchasingTotals.get(row.purchasing_id) || 0) + next);
        if (row.kitting_id) kittingTotals.set(row.kitting_id, (kittingTotals.get(row.kitting_id) || 0) + next);
      }

      for (const row of bomRows) {
        const nextQty = scaledByBomId.get(row.id);
        const currentQty = normalizePositiveInt(row.quantity, 1);
        if (nextQty !== currentQty) {
          const { error } = await supabase.from('build_bom').update({ quantity: nextQty }).eq('id', row.id);
          if (error) throw error;
        }
      }

      for (const [id, qty] of partTotals.entries()) {
        const { error } = await supabase.from('parts').update({ quantity: qty }).eq('id', id);
        if (error) throw error;
      }
      for (const [id, qty] of purchasingTotals.entries()) {
        const { error } = await supabase.from('purchasing').update({ quantity: qty }).eq('id', id);
        if (error) throw error;
      }
      for (const [id, qty] of kittingTotals.entries()) {
        const { error } = await supabase.from('kitting').update({ quantity: qty }).eq('id', id);
        if (error) throw error;
      }

      await loadBuildDetails();
      alert(`Build quantity updated to ${newQty}.`);
    } catch (error) {
      console.error('Error updating build quantity:', error);
      alert('Failed to update build quantity: ' + (error?.message || error));
      buildQuantityInput = String(oldQty);
    } finally {
      updatingBuildQuantity = false;
    }
  }

  // Version refetch functionality
  async function openVersionSelector() {
    if (!build?.subsystems?.onshape_document_id) {
      alert('No OnShape document linked to this subsystem');
      return;
    }
    
    showVersionModal = true;
    loadingVersions = true;
    
    try {
      const { onShapeAPI } = await import('$lib/onshape.js');
      const allVersions = await onShapeAPI.getDocumentVersions(build.subsystems.onshape_document_id);
      
      if (!Array.isArray(allVersions)) {
        console.warn('Invalid versions response');
        versionTimeline = [];
        return;
      }
      
      // Take the last 15 versions (newest first)
      const sortedVersions = allVersions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const recentVersions = sortedVersions.slice(0, 15);
      
      versionTimeline = recentVersions.map(version => ({
        ...version,
        type: 'version',
        date: new Date(version.createdAt)
      }));
      
    } catch (error) {
      console.error('Error loading versions:', error);
      alert('Failed to load versions: ' + (error?.message || error));
    } finally {
      loadingVersions = false;
    }
  }

  async function refetchBOMFromVersion() {
    if (!selectedVersionForRefetch) {
      alert('Please select a version');
      return;
    }
    
    if (!build?.subsystems?.onshape_document_id || !build?.subsystems?.onshape_workspace_id || !build?.subsystems?.onshape_element_id) {
      alert('Missing OnShape configuration for this build');
      return;
    }
    
    try {
      loadingVersions = true;
      
      // Import OnShape API
      const { onShapeAPI } = await import('$lib/onshape.js');
      
      // Get BOM from OnShape using the selected version ID
      const bom = await onShapeAPI.getAssemblyBOM(
        build.subsystems.onshape_document_id,
        build.subsystems.onshape_workspace_id,
        build.subsystems.onshape_element_id,
        selectedVersionForRefetch.id
      );
      
      // Analyze BOM
      const newBOM = await onShapeAPI.analyzeBOM(bom, build.subsystems.onshape_workspace_id);
      
      // Separate existing BOM parts into added and unadded
      const addedParts = bomSnapshot.filter(row => row.added === true);
      const unaddedParts = bomSnapshot.filter(row => row.added !== true);
      
      // Delete ALL unadded parts - even if names match, Onshape parameters change between versions
      if (unaddedParts.length > 0) {
        const idsToDelete = unaddedParts.map(p => p.id);
        const { error: deleteError } = await supabase
          .from('build_bom')
          .delete()
          .in('id', idsToDelete);
        
        if (deleteError) {
          console.error('Error deleting unadded parts:', deleteError);
        }
      }
      
      // Build set of identifiers for added parts only (these are preserved)
      const addedIdentifiers = new Set();
      addedParts.forEach(part => {
        if (part.part_name) addedIdentifiers.add(part.part_name.toLowerCase().trim());
        if (part.part_number) addedIdentifiers.add(part.part_number.toLowerCase().trim());
      });
      
      // Filter new BOM to exclude parts that are already added (in production)
      const partsToAdd = newBOM.filter(newPart => {
        const name = (newPart.part_name || '').toLowerCase().trim();
        const partNum = (newPart.part_number || '').toLowerCase().trim();
        
        // If either name or part_number matches an added part, skip it (already in production)
        if (name && addedIdentifiers.has(name)) return false;
        if (partNum && addedIdentifiers.has(partNum)) return false;
        
        return true;
      });
      
      // Insert new BOM entries with fresh Onshape parameters from the new version
      if (partsToAdd.length > 0) {
        const bomInserts = partsToAdd.map(part => ({
          build_id: buildId,
          part_name: part.part_name || 'Unnamed Part',
          part_number: part.part_number || null,
          part_type: part.part_type || 'manufactured',
          workflow: part.workflow || 'mill',
          quantity: (part.quantity || 1) * normalizePositiveInt(build?.quantity, 1),
          material: part.material || '',
          stock_assignment: part.stock_assignment || null,
          stock_assignment_custom: part.stock_assignment_custom || null,
          onshape_document_id: part.onshape_document_id || build?.subsystems?.onshape_document_id || null,
          onshape_wvm: part.onshape_wvm || 'v',
          onshape_wvmid: part.onshape_wvmid || selectedVersionForRefetch.id,
          onshape_element_id: part.onshape_element_id || part.onshape_part_studio_element_id || build?.subsystems?.onshape_element_id || null,
          onshape_part_id: part.onshape_part_id || null,
          added: false
        }));
        
        const { error: insertError } = await supabase
          .from('build_bom')
          .insert(bomInserts);
        
        if (insertError) throw insertError;
      }
      
      // Update the version reference on the build
      const { error: updateError } = await supabase
        .from('builds')
        .update({ 
          release_id: selectedVersionForRefetch.id,
          release_name: selectedVersionForRefetch.name
        })
        .eq('id', buildId);
      
      if (updateError) {
        console.warn('Failed to update build version reference:', updateError);
      }
      
      // Reload build details to show changes
      await loadBuildDetails();
      
      // Show summary
      const summary = [];
      if (partsToAdd.length > 0) summary.push(`${partsToAdd.length} parts from new version`);
      if (unaddedParts.length > 0) summary.push(`${unaddedParts.length} unadded parts replaced`);
      if (addedParts.length > 0) summary.push(`${addedParts.length} added parts preserved`);
      
      alert(summary.length > 0 ? `BOM updated:\n• ${summary.join('\n• ')}` : 'BOM is already up to date');
      
      showVersionModal = false;
      selectedVersionForRefetch = null;
      
    } catch (error) {
      console.error('Error refetching BOM:', error);
      alert('Failed to refetch BOM: ' + (error?.message || error));
    } finally {
      loadingVersions = false;
    }
  }

</script>

<svelte:head>
  <title>Build Details - {build?.subsystems?.name || 'Unknown'} {build?.release_name || ''} - Spartans Hub</title>
</svelte:head>

<div class="main-content">
  {#if loading}
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading build details...</p>
    </div>
  {:else if build}
    <div class="page-header">
      <div class="header-content">
        <div class="header-left">
          <div class="header-actions">
            <button class="btn btn-secondary btn-sm" on:click={() => goto('/cad/build')}>
              <ArrowLeft size={16} />
              Back to Builds
            </button>
            {#if build.subsystems?.onshape_url}
              <a href={build.subsystems.onshape_url} target="_blank" class="btn btn-secondary btn-sm">
                <ExternalLink size={16} />
                View CAD
              </a>
            {/if}
          </div>
          <div class="header-info">
            <h1>
              <Package size={32} />
              {build.subsystems?.name || 'Unknown Subsystem'} - {build.release_name}
            </h1>
            <p class="build-hash">Build #{build.build_hash?.split('_')[1] || build.id.substring(0, 8)}</p>
            <div class="build-meta">
              <span>Created: {formatPacificDate(build.created_at)}</span>
              <span>Quantity: x{normalizePositiveInt(build.quantity, 1)}</span>
              {#if build.assembled_at}
                <span>Assembled: {formatPacificDate(build.assembled_at)}</span>
              {/if}
              {#if build.project_id}
                <span>{projectBuilds.length} builds • {projectPartsCount} parts • Total cost: ${projectTotalCost.toFixed(2)}</span>
              {/if}
            </div>
          </div>
        </div>
        <div class="header-right">
          {#if isSubsystemLead()}
            <div class="build-qty-control">
              <label for="build-quantity">Build Quantity</label>
              <div class="build-qty-row">
                <input
                  id="build-quantity"
                  class="form-input"
                  type="number"
                  min="1"
                  step="1"
                  bind:value={buildQuantityInput}
                  disabled={updatingBuildQuantity}
                />
                <button class="btn btn-secondary btn-sm" on:click={updateBuildQuantity} disabled={updatingBuildQuantity}>
                  {updatingBuildQuantity ? 'Saving...' : 'Apply'}
                </button>
              </div>
            </div>
          {/if}
          {#if build.status !== 'assembled'}
            {@const progress = getBuildProgress()}
            {#if progress.status === 'Ready to Assemble'}
              <button class="btn btn-success btn-sm" on:click={markAsAssembled}>
                <CheckCircle size={16} />
                Mark as Assembled
              </button>
            {/if}
          {/if}
          {#if isSubsystemLead()}
            <button class="btn btn-outline-danger btn-sm" on:click={deleteBuild} title="Delete this build">
              <Trash2 size={16} />
              Delete Build
            </button>
          {/if}
        </div>
      </div>
    </div>

    <div class="status-section">
      <div class="status-card status-{build.status}">
        <div class="status-header">
          <span class="status-title">Parts</span>
          <span class="flag flag-{build.status}">
            {#if build.status === 'pending'}
              <Clock size={14} /> Pending
            {:else if build.status === 'manufacturing'}
              <Wrench size={14} /> in progress
            {:else if build.status === 'ready_to_assemble'}
              <CheckCircle size={14} /> Ready to Assemble
            {:else if build.status === 'assembled'}
              <CheckCircle size={14} /> Assembled
            {/if}
          </span>
        </div>
        {#if build}
          {@const progress = getBuildProgress()}
          <div class="progress-section">
            <div class="progress-row">
              <span class="progress-label">Manufacturing</span>
              <div class="progress-bar">
                <div class="progress-fill mfg" style="width: {progress.mfgPercent}%"></div>
              </div>
              <span class="progress-count">{progress.mfgCount.complete}/{progress.mfgCount.total}</span>
            </div>
            <div class="progress-row">
              <span class="progress-label">Purchasing</span>
              <div class="progress-bar">
                <div class="progress-fill pur" style="width: {progress.purPercent}%"></div>
              </div>
              <span class="progress-count">{progress.purCount.complete}/{progress.purCount.total}</span>
            </div>
            <div class="progress-row">
              <span class="progress-label">Kitting</span>
              <div class="progress-bar">
                <div class="progress-fill kit" style="width: {progress.kitPercent}%"></div>
              </div>
              <span class="progress-count">{progress.kitCount.complete}/{progress.kitCount.total}</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Build Components on top - Added Parts Only -->
    <div class="bom-section">
      <div class="parts-header">
        <h2>Build Components (Added Parts)</h2>
      </div>
      {#if build.parts || build.purchasing}
        {@const allParts = [...(build.parts || []), ...(build.purchasing || []), ...(build.kitting || [])]}
        {#if allParts.length > 0}
          <div class="bom-table-container">
            <table class="bom-table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Type</th>
                  <th>Workflow</th>
                  <th>Qty</th>
                  <th>Status</th>
                  <th>Kitting</th>
                </tr>
              </thead>
              <tbody>
                {#each allParts as part, i}
                  <tr
                    class="row {i % 2 === 0 ? 'even' : 'odd'}"
                    on:click={(e) => onRowClick(e, part)}
                    on:keydown={(e) => onRowKeyDown(e, part)}
                    role="button"
                    tabindex="0"
                    style="cursor: pointer;"
                  >
                    <td class="part-name">
                      <div class="name-cell">
                        <div class="name-wrap">
                          <div class="name">{part.name || part.part_name || 'Unnamed Part'}</div>
                          {#if part.part_number}
                            <div class="part-number">{part.part_number}</div>
                          {/if}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="chip {(part.workflow === 'purchase' || part.workflow === 'kit') ? 'chip-cots' : 'chip-mfg'}">
                        {(part.workflow === 'purchase' || part.workflow === 'kit') ? 'COTS' : 'Manufactured'}
                      </span>
                    </td>
                    <td>
                      <span class="chip chip-neutral">
                        {part.workflow || 'N/A'}
                      </span>
                    </td>
                    <td class="quantity">{part.quantity || 1}</td>
                    <td>
                      <span class="tag tag-status tag-status-{part.status || 'pending'}">
                        {#if part.status === 'pending'}
                          <Clock size={12} />
                        {:else if part.status === 'in-progress' || part.status === 'cammed'}
                          <Wrench size={12} />
                        {:else if part.status === 'ordered'}
                          <Package size={12} />
                        {:else if part.status === 'delivered' || part.status === 'complete' || part.status === 'manufactured' || part.status === 'kitted'}
                          <CheckCircle size={12} />
                        {:else}
                          <Clock size={12} />
                        {/if}
                        <span>{part.status || 'pending'}</span>
                      </span>
                    </td>
                    <td class="kitting">
                      {#if part.kitting_bin}
                        <div class="kitting-location">
                          <MapPin size={14} />
                          {part.kitting_bin}
                        </div>
                      {:else}
                        <span class="no-kitting">Not assigned</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty-state">
            <Package size={48} />
            <h3>No Parts in This Build</h3>
            <p>No parts have been added to this build yet.</p>
          </div>
        {/if}
      {:else}
        <div class="empty-state">
          <Package size={48} />
          <h3>No Parts in This Build</h3>
          <p>No parts have been added to this build yet.</p>
        </div>
      {/if}
    </div>

    <!-- Full BOM below - Unadded Parts Only -->
    <div class="bom-section">
      <div class="parts-header">
        <h2>Full BOM (Unadded Parts)</h2>
        <div style="display: flex; align-items: center; gap: 1rem;">
          <button class="btn btn-secondary btn-sm" on:click={openVersionSelector}>
            <Download size={16} />
            Change Version
          </button>
        </div>
      </div>
      {#if bomSnapshot && bomSnapshot.length > 0}
        {@const unaddedParts = bomSnapshot.filter(item => !item.added && !item.parts_id && !item.purchasing_id && !item.kitting_id)}
        {#if unaddedParts.length > 0}
        <div class="bom-table-container">
          <table class="bom-table">
            <thead>
              <tr>
                <th>Part</th>
                <th>Type</th>
                <th>Workflow</th>
                <th>Qty</th>
                <th>Stock</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {#each unaddedParts as item, i}
                {@const actualIndex = bomSnapshot.findIndex(b => b.id === item.id)}
                <tr class="row {i % 2 === 0 ? 'even' : 'odd'}">
                  <td class="part-name">
                    <div class="name-cell">
                      <div class="name-wrap">
                        <div class="name">{item.part_name || 'Unnamed Part'}</div>
                        {#if item.part_number}
                          <div class="part-number">{item.part_number}</div>
                        {/if}
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      class="type-dropdown {item.part_type === 'COTS' ? 'type-cots' : 'type-manufactured'}"
                      value={item.part_type}
                      on:change={(e) => updateBomType(actualIndex, e.target.value)}
                    >
                      <option value="COTS">COTS</option>
                      <option value="manufactured">Manufactured</option>
                      <option value="other">Other</option>
                    </select>
                  </td>
                  <td>
                    {#if item.part_type === 'COTS'}
                      <select
                        class="workflow-dropdown workflow-{item.workflow || 'purchase'}"
                        value={item.workflow || 'purchase'}
                        on:change={(e) => setCotsWorkflow(actualIndex, e.target.value)}
                      >
                        <option value="purchase">Purchase</option>
                        <option value="kit">Kit</option>
                      </select>
                    {:else}
                      <select
                        class="workflow-dropdown workflow-{item.workflow || 'mill'}"
                        value={item.workflow || 'mill'}
                        on:change={(e) => updateBomWorkflow(actualIndex, e.target.value)}
                      >
                        <option value="3d-print">3D Print</option>
                        <option value="laser-cut">Laser Cut</option>
                        <option value="lathe">Lathe</option>
                        <option value="mill">Mill</option>
                        <option value="router">Router</option>
                      </select>
                    {/if}
                  </td>
                  <td class="quantity">{item.quantity || 1}</td>
                  <td class="material">
                    {#if item.part_type !== 'COTS'}
                      <select on:change={(e) => updateBomStockChoice(actualIndex, e.target.value)} value={item._stock_choice || item.stock_assignment || ''}>
                        <option value="">Select Stock</option>
                        {#each getStocksForWorkflow(item.workflow || 'mill') as stock}
                          <option value={stock.description}>{stock.description}</option>
                        {/each}
                        <option value="__other__">Other...</option>
                      </select>
                      {#if item._stock_choice === '__other__'}
                        <div style="margin-top:0.35rem;">
                          <input class="form-input" type="text" placeholder="Type custom stock" value={item.stock_assignment_custom || ''} on:input={(e) => updateBomCustomStock(actualIndex, e.target.value)} />
                        </div>
                      {/if}
                    {:else}
                      <span class="no-stock">-</span>
                    {/if}
                  </td>
                  <td>
                    <button
                      class="btn btn-sm btn-yellow add-btn"
                      on:click={() => addFromFullBOM(item)}
                      disabled={(item.parts_id || item.purchasing_id || item.kitting_id) || processingAdd}
                    >
                      {#if item.parts_id || item.purchasing_id || item.kitting_id}
                        <CheckCircle size={14} />
                        Added
                      {:else}
                        <Plus size={14} />
                        Add
                      {/if}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {:else}
          <div class="empty-state">
            <Package size={48} />
            <h3>No Unadded Parts in BOM</h3>
            <p>All BOM items have been added to the build, or you can load a new version.</p>
          </div>
        {/if}
      {:else}
        <div class="empty-state">
          <Package size={48} />
          <h3>No BOM Snapshot</h3>
          <p>The BOM snapshot for this build does not contain items yet. Click "Change Version" to load a BOM.</p>
        </div>
      {/if}
    </div>
  {:else}
    <div class="error-container">
      <h2>Build Not Found</h2>
      <p>The requested build could not be found.</p>
      <button class="btn btn-primary btn-sm" on:click={() => goto('/cad/build')}>
        <ArrowLeft size={16} />
        Back to Builds
      </button>
    </div>
  {/if}
</div>

{#if showEditModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click|self={() => { showEditModal = false; editTarget = null; }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { showEditModal = false; editTarget = null; } }}
    >
    <h3>Edit Build Item</h3>
    <div class="modal-row">
      <label for="edit-type">Type</label>
      <select id="edit-type" bind:value={editType} on:change={() => { if (editType === 'COTS') editWorkflow = 'purchase'; else if (!editWorkflow || editWorkflow === 'purchase') editWorkflow = 'mill'; }}>
        <option value="manufactured">Manufactured</option>
        <option value="COTS">COTS</option>
      </select>
    </div>
    <div class="modal-row">
      <label for="edit-workflow">Workflow</label>
      {#if editType === 'COTS'}
        <input id="edit-workflow" class="form-input" type="text" value="Purchase" readonly disabled />
      {:else}
        <select id="edit-workflow" class="workflow-dropdown workflow-{editWorkflow || 'mill'}" bind:value={editWorkflow}>
          <option value="3d-print">3D Print</option>
          <option value="laser-cut">Laser Cut</option>
          <option value="lathe">Lathe</option>
          <option value="mill">Mill</option>
          <option value="router">Router</option>
        </select>
      {/if}
    </div>
    <div class="modal-row">
      <label for="edit-stock">Stock</label>
      {#if editType === 'COTS'}
        <input id="edit-stock" class="form-input" type="text" value="-" readonly disabled />
      {:else}
        <div style="display:flex;flex-direction:column;gap:0.5rem;">
          <select id="edit-stock" on:change={(e) => editStockChoice = e.target.value} value={editStockChoice || editStockAssignment}>
            <option value="">Select Stock</option>
            {#each getStocksForWorkflow(editWorkflow || 'mill') as stock}
              <option value={stock.description}>{stock.description}</option>
            {/each}
            <option value="__other__">Other...</option>
          </select>
          {#if (editStockChoice === '__other__' || (!editStockChoice && typeof editStockAssignmentCustom !== 'undefined' && editStockAssignmentCustom !== null))}
            <input id="edit-stock-custom" class="form-input" type="text" placeholder="Type custom stock" bind:value={editStockAssignmentCustom} />
          {/if}
        </div>
      {/if}
    </div>
    <div class="modal-row">
      <label for="edit-material">Material</label>
      <input id="edit-material" class="form-input" type="text" bind:value={editMaterial} readonly title="Material is read-only" />
    </div>
    <div class="modal-row">
      <label for="edit-quantity">Quantity</label>
      <input id="edit-quantity" class="form-input" type="number" min="1" step="1" bind:value={editQuantity} />
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline-danger" on:click={() => { removeBuildAssociation(editTarget.id); showEditModal = false; editTarget = null; }}>Delete</button>
      <div style="flex:1"></div>
      <button class="btn" on:click={() => { showEditModal = false; editTarget = null; }}>Cancel</button>
      <button class="btn btn-yellow" on:click={saveEdit}>Save</button>
    </div>
    </div>
  </div>
{/if}

<!-- Purchase Link/Price Modal (when auto-detect fails) -->
{#if showPurchaseModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click|self={() => { showPurchaseModal = false; purchaseModalItem = null; }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { showPurchaseModal = false; purchaseModalItem = null; } }}
    >
      <h3>Provide vendor link and unit price</h3>
      <p>Please supply a vendor URL and unit price for <strong>{purchaseModalItem?.part_name || purchaseModalItem?.part_number || 'this part'}</strong></p>
      <div style="display:flex; flex-direction:column; gap:0.5rem;">
        <label for="purchase-url">Vendor URL:</label>
        <input id="purchase-url" class="form-input" type="url" placeholder="https://..." bind:value={purchaseModalUrl} />

        <label for="purchase-price">Unit Price (optional):</label>
        <input id="purchase-price" class="form-input" type="number" step="0.01" min="0" placeholder="0.00" bind:value={purchaseModalPrice} />
      </div>
      <div class="modal-actions">
        <button class="btn" on:click={() => { showPurchaseModal = false; purchaseModalItem = null; }}>Cancel</button>
        <button class="btn btn-yellow" on:click={confirmAddToPurchasingFromModal}>Add to Purchasing</button>
      </div>
    </div>
  </div>
{/if}

<!-- Version Selector Modal -->
{#if showVersionModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    on:click|self={() => { showVersionModal = false; selectedVersionForRefetch = null; }}
  >
    <div
      class="modal version-modal"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      on:click|stopPropagation
      on:keydown={(e) => { if (e.key === 'Escape') { showVersionModal = false; selectedVersionForRefetch = null; } }}
      style="--modal-width: 900px;"
    >
      <h3>Select Version to Load BOM</h3>
      <p style="color: #666; margin-bottom: 1rem;">Choose a version to fetch its BOM. Parts already added will be skipped.</p>
      
      {#if loadingVersions}
        <div style="display: flex; flex-direction: column; align-items: center; padding: 2rem; gap: 1rem;">
          <div class="loading-spinner"></div>
          <p>Loading versions...</p>
        </div>
      {:else if versionTimeline.length > 0}
        <div class="version-timeline" style="max-height: 400px; overflow-y: auto; margin-bottom: 1rem;">
          {#each versionTimeline as version}
            <div 
              class="version-item {selectedVersionForRefetch?.id === version.id ? 'selected' : ''}"
              on:click={() => selectedVersionForRefetch = version}
              on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedVersionForRefetch = version; } }}
              role="button"
              tabindex="0"
            >
              <div class="version-info">
                <div class="version-name">{version.name || `Version ${version.id.substring(0, 8)}`}</div>
                <div class="version-date">{formatPacificDateTimeWithZone(version.date)}</div>
              </div>
              {#if selectedVersionForRefetch?.id === version.id}
                <div class="version-checkmark">✓</div>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div style="padding: 2rem; text-align: center; color: #666;">
          <p>No versions available</p>
        </div>
      {/if}
      
      <div class="modal-actions">
        <button class="btn" on:click={() => { showVersionModal = false; selectedVersionForRefetch = null; }}>Cancel</button>
        <button 
          class="btn btn-yellow" 
          on:click={refetchBOMFromVersion}
          disabled={!selectedVersionForRefetch || loadingVersions}
        >
          {loadingVersions ? 'Loading...' : 'Load BOM from Version'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Issue 2: Fix the status card / progress section - remove yellow background */
  .status-section {
    margin-bottom: var(--space-4);
  }

  .status-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  .status-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .status-title {
    font-weight: 600;
    font-size: var(--font-md);
    color: var(--secondary);
  }

  .flag {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    font-weight: 600;
    text-transform: uppercase;
  }

  .flag-pending {
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  .flag-manufacturing {
    background: var(--blue-soft);
    color: var(--blue-base);
  }

  .flag-ready_to_assemble {
    background: var(--green-soft);
    color: var(--green-strong);
  }

  .flag-assembled {
    background: var(--green-soft);
    color: var(--green-strong);
  }

  .progress-section {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .progress-label {
    width: 120px;
    font-size: var(--font-xs);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .progress-count {
    font-size: var(--font-xs);
    color: var(--text-muted);
    min-width: 50px;
    text-align: right;
  }

  /* Issue 10: Add gap/margin between parts header and table */
  .bom-section {
    margin-bottom: var(--space-6);
  }

  .parts-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-4);
    gap: var(--gap-4);
    flex-wrap: wrap;
  }

  .parts-header h2 {
    margin: 0;
    font-size: var(--font-xl);
    color: var(--secondary);
  }

  /* Issue 3: Fix tag heights to be consistent */
  .tag, .chip {
    height: var(--control-height-sm);
    display: inline-flex;
    align-items: center;
  }

  /* Issues 8 & 9: Style the dropdowns in the Full BOM table */
  .type-dropdown,
  .workflow-dropdown {
    height: var(--control-height-sm);
    padding: var(--control-padding-sm);
    font-size: var(--control-font-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text);
    cursor: pointer;
    min-width: 120px;
  }

  .type-dropdown:focus,
  .workflow-dropdown:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(241, 195, 49, 0.2);
  }

  /* Type dropdown colors */
  .type-cots {
    background: var(--green-soft);
    color: var(--green-strong);
    border-color: var(--green-base);
  }

  .type-manufactured {
    background: var(--blue-soft);
    color: var(--blue-base);
    border-color: var(--blue-soft);
  }

  /* Workflow dropdown colors */
  .workflow-purchase,
  .workflow-kit {
    background: var(--green-soft);
    color: var(--green-strong);
    border-color: var(--green-base);
  }

  .workflow-mill {
    background: var(--blue-soft);
    color: var(--blue-base);
    border-color: var(--blue-soft);
  }

  .workflow-lathe {
    background: var(--red-soft);
    color: var(--red-base);
    border-color: var(--red-base);
  }

  .workflow-3d-print {
    background: var(--purple-soft);
    color: var(--purple-strong);
    border-color: var(--purple-base);
  }

  .workflow-laser-cut {
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
    border-color: var(--brand-gold-base);
  }

  .workflow-router {
    background: var(--green-soft);
    color: var(--green-base);
    border-color: var(--green-base);
  }

  /* Stock dropdown in material column */
  .material select {
    height: var(--control-height-sm);
    padding: var(--control-padding-sm);
    font-size: var(--control-font-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text);
    cursor: pointer;
    min-width: 140px;
    width: 100%;
  }

  .material select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(241, 195, 49, 0.2);
  }

  .no-stock {
    color: var(--text-muted);
  }

  /* Name cell styling */
  .name-cell {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .name-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-weight: 500;
    color: var(--secondary);
  }

  .part-number {
    font-size: var(--font-xs);
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  /* Status tag styling */
  .tag-status {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    font-weight: 600;
    text-transform: capitalize;
    height: var(--control-height-sm);
  }

  .tag-status-pending {
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  .tag-status-in-progress,
  .tag-status-cammed {
    background: var(--blue-soft);
    color: var(--blue-base);
  }

  .tag-status-ordered {
    background: var(--purple-soft);
    color: var(--purple-strong);
  }

  .tag-status-delivered,
  .tag-status-complete,
  .tag-status-manufactured,
  .tag-status-kitted {
    background: var(--green-soft);
    color: var(--green-strong);
  }

  .tag-status-needs_approval {
    background: var(--brand-gold-soft);
    color: var(--brand-gold-strong);
  }

  /* Chip styling for Type and Workflow columns */
  .chip-cots {
    background: var(--green-soft);
    color: var(--green-strong);
    border-color: var(--green-base);
  }

  .chip-mfg {
    background: var(--blue-soft);
    color: var(--blue-base);
    border-color: var(--blue-soft);
  }

  .chip-neutral {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
    text-transform: capitalize;
  }

  /* Kitting column styling */
  .kitting-location {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    color: var(--success);
    font-weight: 500;
  }

  .no-kitting {
    color: var(--text-muted);
    font-size: var(--font-xs);
  }

  /* Header styling */
  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    width: 100%;
    gap: var(--gap-4);
  }

  .header-left {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .header-info h1 {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    margin: 0;
    font-size: var(--font-xl);
  }

  .build-hash {
    color: var(--text-muted);
    font-size: var(--font-xs);
    margin: var(--space-1) 0 0 0;
  }

  .build-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-4);
    font-size: var(--font-xs);
    color: var(--text-muted);
  }

  .header-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--gap-2);
  }

  .build-qty-control {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    align-items: flex-end;
  }

  .build-qty-control label {
    font-size: var(--font-xs);
    color: var(--text-muted);
    font-weight: 600;
  }

  .build-qty-row {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .build-qty-row .form-input {
    width: 90px;
  }

  /* Version modal styling */
  .version-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-2);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .version-item:hover {
    background: var(--surface-2);
  }

  .version-item.selected {
    border-color: var(--accent);
    background: var(--brand-gold-soft);
  }

  .version-name {
    font-weight: 500;
  }

  .version-date {
    font-size: var(--font-xs);
    color: var(--text-muted);
  }

  .version-checkmark {
    color: var(--accent);
    font-weight: 700;
  }

  /* Modal row for edit modal */
  .modal-row {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    margin-bottom: var(--space-3);
  }

  .modal-row label {
    font-weight: 600;
    color: var(--secondary);
  }

  /* Add button in Full BOM table */
  .add-btn {
    white-space: nowrap;
  }

  .btn-yellow {
    --btn-bg: var(--accent);
    --btn-color: var(--secondary);
    --btn-border: var(--accent);
    --btn-hover-bg: var(--brand-gold-base);
    --btn-hover-color: var(--secondary);
    --btn-hover-border: var(--brand-gold-base);
  }

  /* Responsive adjustments */
  @media (max-width: 768px) {
    .header-content {
      flex-direction: column;
    }

    .header-right,
    .build-qty-control {
      align-items: flex-start;
    }

    .parts-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .progress-label {
      width: 80px;
    }
  }
</style>
