<script>
  import { goto } from '$app/navigation';
  import { supabase } from '$lib/supabase.js';
  import { Upload, FileText, Wrench, Zap } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { userStore, loadUserFromUUID } from '$lib/stores/user.js';
  import { validateStepFile } from '$lib/step_validation.js';
  import { queueCamJobForPart, WORKFLOW_OPERATION_TYPE } from '$autocam/camJobs.js';

  let partName = '';
  let requesterName = '';
  let projectId = '';
  let workflow = '';
  let quantity = 1;
  let stockAssignment = '';
  let customStock = '';
  let savedStockOptions = [];
  let newStockDescription = '';
  let isAddingStock = false;
  let stockOptionError = '';
  let uploadedFile = null;
  let uploadedStepFile = null;
  let camJobName = ''; // optional AutoCAM job name for router/lathe
  let notes = '';
  let isSubmitting = false;
  let user = null;

  $: supportsAutocam = !!WORKFLOW_OPERATION_TYPE[workflow];

  // Fire-and-forget: queues + generates the CAM job right after the part is
  // created, straight from the STEP file that was just uploaded (required
  // for router and lathe now) - no separate CAM-specific upload needed.
  // Errors here don't block part creation - the user can retry from the
  // manufacture list.
  async function triggerAutocamFromStep(newPartId, stepFileName) {
    if (!supportsAutocam || !stepFileName) return;
    try {
      const result = await queueCamJobForPart(
        { id: newPartId, name: partName, workflow, file_name: stepFileName },
        { userId: user?.id || null, name: camJobName.trim() || null }
      );
      if (!result.success) console.error('AutoCAM generation failed:', result.error);
    } catch (e) {
      console.error('AutoCAM trigger failed:', e);
    }
  }

  async function loadSavedStockOptions() {
    const { data, error } = await supabase
      .from('manufacturing_stock_options')
      .select('id, workflow, description')
      .order('description');
    if (error) {
      // Keep the bundled catalog usable before the migration reaches an
      // environment or during a temporary database failure.
      console.warn('Could not load shared stock options:', error.message);
      return;
    }
    savedStockOptions = data || [];
  }

  onMount(() => {
    const unsubscribe = userStore.subscribe((value) => {
      user = value;
      if (!requesterName && value?.full_name) {
        requesterName = value.full_name;
      }
    });
    loadSavedStockOptions();
    loadUserFromUUID(supabase);
    return () => unsubscribe();
  });

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

  // Router: needs STEP. Lathe: needs both the PDF print AND a STEP (for AutoCAM).
  // Everything else: needs the one workflow-appropriate file.
  $: hasRequiredFiles = workflow === 'router'
    ? !!uploadedStepFile
    : workflow === 'lathe'
      ? !!uploadedFile && !!uploadedStepFile
      : !!uploadedFile;

  const workflows = [
    { id: 'laser-cut', name: 'Laser Cut', fileType: 'svg', icon: Zap, color: 'workflow-laser' },
    { id: 'router', name: 'Router', fileType: 'step', icon: Wrench, color: 'workflow-router' },
    { id: 'lathe', name: 'Lathe', fileType: 'pdf', icon: FileText, color: 'workflow-lathe' },
    { id: 'mill', name: 'Mill', fileType: 'pdf', icon: FileText, color: 'workflow-mill' },
    { id: '3d-print', name: '3D Print', fileType: 'step', icon: Upload, color: 'workflow-3d-print' }
  ];

  $: selectedWorkflow = workflows.find(w => w.id === workflow);
  $: requiredFileType = selectedWorkflow?.fileType || '';
  import stockData from '$lib/stock.json';
  $: stockOptions = workflow
    ? [
        ...(stockData[workflow] || []),
        ...savedStockOptions
          .filter((option) => option.workflow === workflow)
          .map((option) => ({ ...option, dimensions: 'Custom' }))
      ]
    : [];

  async function addStockOption() {
    const description = newStockDescription.trim();
    stockOptionError = '';
    if (!workflow || !description) {
      stockOptionError = 'Enter a stock name.';
      return;
    }
    if (stockOptions.some((option) => option.description.toLowerCase() === description.toLowerCase())) {
      stockOptionError = 'That stock option already exists for this process.';
      return;
    }
    if (!user?.id) {
      stockOptionError = 'You must be signed in to add a shared stock option.';
      return;
    }

    isAddingStock = true;
    const { data, error } = await supabase
      .from('manufacturing_stock_options')
      .insert({ workflow, description, created_by: user.id })
      .select('id, workflow, description')
      .single();
    isAddingStock = false;
    if (error) {
      stockOptionError = error.code === '23505'
        ? 'That stock option already exists for this process.'
        : error.message;
      return;
    }
    savedStockOptions = [...savedStockOptions, data];
    stockAssignment = data.description;
    newStockDescription = '';
  }

  // No material field: parts list only tracks stock_assignment.

  async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (file) {
      const fileExtension = file.name.split('.').pop().toLowerCase();
      const allowedExts = requiredFileType === 'step' ? ['step','stp'] : [requiredFileType];
      if (requiredFileType && !allowedExts.includes(fileExtension)) {
        const extMsg = requiredFileType === 'step' ? 'STEP (.step or .stp)' : requiredFileType.toUpperCase();
        alert(`Please upload a ${extMsg} file for ${selectedWorkflow.name} workflow.`);
        event.target.value = '';
        return;
      }
      if (requiredFileType === 'step') {
        const { valid, reason } = await validateStepFile(file);
        if (!valid) {
          alert(`This STEP file is not valid:\n\n${reason}`);
          event.target.value = '';
          return;
        }
      }
      uploadedFile = file;
    }
  }

  // Fix for Vercel deployment - ensure functions are properly scoped
  function handleDragOver(event) {
    event.preventDefault();
    event.currentTarget.classList.add('active');
  }

  function handleDragLeave(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('active');
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('active');

    const files = event.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const fileExtension = file.name.split('.').pop().toLowerCase();
      const allowedExts = requiredFileType === 'step' ? ['step','stp'] : [requiredFileType];
      if (requiredFileType && !allowedExts.includes(fileExtension)) {
        const extMsg = requiredFileType === 'step' ? 'STEP (.step or .stp)' : requiredFileType.toUpperCase();
        alert(`Please upload a ${extMsg} file for ${selectedWorkflow.name} workflow.`);
        return;
      }
      if (requiredFileType === 'step') {
        const { valid, reason } = await validateStepFile(file);
        if (!valid) {
          alert(`This STEP file is not valid:\n\n${reason}`);
          return;
        }
      }
      uploadedFile = file;
    }
  }

  // Validate extension + actual STEP content. Returns true if the file is a
  // usable solid model; alerts and returns false otherwise.
  async function acceptStepFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['step', 'stp'].includes(ext)) {
      alert('Please upload a STEP (.step or .stp) file.');
      return false;
    }
    const { valid, reason } = await validateStepFile(file);
    if (!valid) {
      alert(`This STEP file is not valid:\n\n${reason}`);
      return false;
    }
    return true;
  }

  // Router-specific STEP handler
  async function handleStepUpload(event) {
    const file = event.target.files[0];
    if (file) {
      if (!(await acceptStepFile(file))) {
        event.target.value = '';
        return;
      }
      uploadedStepFile = file;
    }
  }
  // Handle drag-and-drop for STEP upload zones
  async function handleDropStep(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('active');
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (!(await acceptStepFile(file))) return;
      uploadedStepFile = file;
    }
  }
  function sanitizeName(n) { return (n || 'part').replace(/[^a-zA-Z0-9]/g, '_'); }

  async function handleSubmitGeneric() {
    const effectiveStock = stockAssignment === '__other__' ? customStock.trim() : (stockAssignment === '__add__' ? '' : stockAssignment);
    if (!partName || !requesterName || !workflow || !uploadedFile || !quantity || quantity < 1 || !effectiveStock) {
      alert('Please fill in all fields, select a stock, upload a file, and specify a valid quantity.');
      return;
    }

    isSubmitting = true;
    try {
      const fileExt = uploadedFile.name.split('.').pop();
      const fileName = `${Date.now()}_${sanitizeName(partName)}.${fileExt}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('manufacturing-files')
        .upload(fileName, uploadedFile, { cacheControl: '3600', upsert: false });
      if (uploadError) throw uploadError;

  const { data: insertedPart, error: insertError } = await supabase
        .from('parts')
        .insert([{
          name: partName,
          requester: requesterName,
          project_id: projectId,
          workflow: workflow,
          quantity: quantity,
          stock_assignment: effectiveStock,
          file_name: fileName,
          file_url: fileName,
          status: 'pending',
          notes: notes.trim() || null,
          frc_team: user?.frc_team || null
        }])
        .select('id')
        .single();
      if (insertError) throw insertError;
      if (insertedPart?.id) {
        await sendNotification('manufacturing-request', { part_id: insertedPart.id });
      }

      // Reset
      partName = '';
      requesterName = '';
      projectId = '';
      workflow = '';
      quantity = 1;
  stockAssignment = '';
  customStock = '';
      uploadedFile = null;
      camJobName = '';
      notes = '';

      goto('/manufacture');
    } catch (error) {
      console.error('Submission error:', error);
      alert(`Error submitting part: ${error.message}`);
    } finally {
      isSubmitting = false;
    }
  }

  async function handleSubmitRouter() {
    const effectiveStock = stockAssignment === '__other__' ? customStock.trim() : (stockAssignment === '__add__' ? '' : stockAssignment);
    if (!partName || !requesterName || !workflow || !quantity || quantity < 1 || !effectiveStock) {
      alert('Please fill in all fields and specify a valid quantity.');
      return;
    }
    if (!uploadedStepFile) {
      alert('Router parts require a STEP file.');
      return;
    }
    // Final gate: never let a bad STEP reach the machine, even if the picker was bypassed.
    const stepCheck = await validateStepFile(uploadedStepFile);
    if (!stepCheck.valid) {
      alert(`This STEP file is not valid:\n\n${stepCheck.reason}`);
      return;
    }

    isSubmitting = true;
    try {
      const base = `${Date.now()}_${sanitizeName(partName)}`;
      // STEP
      const stepExt = uploadedStepFile.name.split('.').pop();
      const stepName = `${base}.${stepExt}`;
      const { error: stepErr } = await supabase.storage
        .from('manufacturing-files')
        .upload(stepName, uploadedStepFile, { cacheControl: '3600', upsert: false });
      if (stepErr) throw stepErr;

      const fileMeta = { step_file: stepName, step_valid: true };
  const { data: insertedPart, error: insertError } = await supabase
        .from('parts')
        .insert([{
          name: partName,
          requester: requesterName,
          project_id: projectId,
          workflow: workflow,
          quantity: quantity,
          stock_assignment: effectiveStock,
          file_name: stepName, // keep for backward compat
          file_url: JSON.stringify(fileMeta),
          status: 'pending',
          notes: notes.trim() || null,
          frc_team: user?.frc_team || null
        }])
        .select('id')
        .single();
      if (insertError) throw insertError;

      await triggerAutocamFromStep(insertedPart.id, stepName);
      if (insertedPart?.id) {
        await sendNotification('manufacturing-request', { part_id: insertedPart.id });
      }

      // Reset
      partName = '';
      requesterName = '';
      projectId = '';
      workflow = '';
      quantity = 1;
  stockAssignment = '';
  customStock = '';
      uploadedStepFile = null;
      uploadedFile = null;
      camJobName = '';
      notes = '';

      goto('/manufacture');
    } catch (error) {
      console.error('Submission error:', error);
      alert(`Error submitting part: ${error.message}`);
    } finally {
      isSubmitting = false;
    }
  }

  async function handleSubmitLathe() {
    const effectiveStock = stockAssignment === '__other__' ? customStock.trim() : (stockAssignment === '__add__' ? '' : stockAssignment);
    if (!partName || !requesterName || !workflow || !quantity || quantity < 1 || !effectiveStock) {
      alert('Please fill in all fields and specify a valid quantity.');
      return;
    }
    if (!uploadedFile) {
      alert('Lathe parts require a PDF print.');
      return;
    }
    if (!uploadedStepFile) {
      alert('Lathe parts require a STEP file so AutoCAM can generate turning G-code.');
      return;
    }
    const stepCheck = await validateStepFile(uploadedStepFile);
    if (!stepCheck.valid) {
      alert(`This STEP file is not valid:\n\n${stepCheck.reason}`);
      return;
    }

    isSubmitting = true;
    try {
      const base = `${Date.now()}_${sanitizeName(partName)}`;
      const pdfExt = uploadedFile.name.split('.').pop();
      const pdfName = `${base}.${pdfExt}`;
      const { error: pdfErr } = await supabase.storage
        .from('manufacturing-files')
        .upload(pdfName, uploadedFile, { cacheControl: '3600', upsert: false });
      if (pdfErr) throw pdfErr;

      const stepExt = uploadedStepFile.name.split('.').pop();
      const stepName = `${base}_cad.${stepExt}`;
      const { error: stepErr } = await supabase.storage
        .from('manufacturing-files')
        .upload(stepName, uploadedStepFile, { cacheControl: '3600', upsert: false });
      if (stepErr) throw stepErr;

      // file_name stays the PDF (unchanged meaning - the print/reference
      // download); the STEP lives in file_url's JSON, same convention router
      // already uses, so getStepFileName()/canViewCad() pick it up for both
      // the 3D viewer and AutoCAM.
      const fileMeta = { step_file: stepName, step_valid: true, pdf_file: pdfName };
      const { data: insertedPart, error: insertError } = await supabase
        .from('parts')
        .insert([{
          name: partName,
          requester: requesterName,
          project_id: projectId,
          workflow: workflow,
          quantity: quantity,
          stock_assignment: effectiveStock,
          file_name: pdfName,
          file_url: JSON.stringify(fileMeta),
          status: 'pending',
          notes: notes.trim() || null,
          frc_team: user?.frc_team || null
        }])
        .select('id')
        .single();
      if (insertError) throw insertError;

      await triggerAutocamFromStep(insertedPart.id, stepName);
      if (insertedPart?.id) {
        await sendNotification('manufacturing-request', { part_id: insertedPart.id });
      }

      // Reset
      partName = '';
      requesterName = '';
      projectId = '';
      workflow = '';
      quantity = 1;
      stockAssignment = '';
      customStock = '';
      uploadedFile = null;
      uploadedStepFile = null;
      camJobName = '';
      notes = '';

      goto('/manufacture');
    } catch (error) {
      console.error('Submission error:', error);
      alert(`Error submitting part: ${error.message}`);
    } finally {
      isSubmitting = false;
    }
  }

  async function handleSubmit() {
    if (workflow === 'router') {
      return await handleSubmitRouter();
    }
    if (workflow === 'lathe') {
      return await handleSubmitLathe();
    }
    return await handleSubmitGeneric();
  }
</script>

<svelte:head>
  <title>Create New Part - 971 Manufacturing</title>
</svelte:head>

<div class="container">
  <div class="header">
    <h1>Manufacturing Request</h1>
    <p>Submit your manufacturing requests for processing</p>
  </div>

  <div class="form-container">
    <form on:submit|preventDefault={handleSubmit} class="manufacturing-form">
      <!-- Basic Information -->
      <div class="form-section">
        <h2>Part Information</h2>
        
        <div class="form-group">
          <label for="partName">Part Name</label>
          <input 
            id="partName"
            type="text" 
            bind:value={partName} 
            placeholder="Enter part name"
            required
          />
        </div>

        <div class="form-group">
          <label for="requesterName">Requester Name</label>
          <input 
            id="requesterName"
            type="text" 
            bind:value={requesterName} 
            placeholder="Enter your name"
            required
          />
        </div>

        <div class="form-group">
          <label for="projectId">Project ID <span class="optional-label">(optional)</span></label>
          <input
            id="projectId"
            type="text"
            bind:value={projectId}
            placeholder="Enter project ID"
          />
        </div>

        <div class="form-group">
          <label for="quantity">Quantity</label>
          <input 
            id="quantity"
            type="number" 
            bind:value={quantity} 
            min="1"
            placeholder="Enter quantity"
            required
          />
        </div>
      </div>

      <!-- Workflow Selection -->
      <div class="form-section">
        <h2>Manufacturing Process</h2>
        
        <div class="workflow-grid">
          {#each workflows as workflowOption}
            <label class="workflow-card {workflow === workflowOption.id ? 'selected' : ''} {workflowOption.color}">
              <input 
                type="radio" 
                bind:group={workflow} 
                value={workflowOption.id}
                on:change={() => { stockAssignment = ''; customStock = ''; newStockDescription = ''; stockOptionError = ''; uploadedFile = null; uploadedStepFile = null; camJobName = ''; }}
              />
              <div class="workflow-content">
                <svelte:component this={workflowOption.icon} size={24} />
                <span class="workflow-name">{workflowOption.name}</span>
                <span class="workflow-file-type">{workflowOption.id === 'lathe' ? 'pdf + step' : `.${workflowOption.fileType}`}</span>
              </div>
            </label>
          {/each}
        </div>
      </div>

      <!-- Stock Selection -->
      {#if stockOptions.length > 0}
        <div class="form-section">
          <h2>Stock Selection</h2>
          <div class="form-group">
            <label for="stock">Stock</label>
            <select id="stock" bind:value={stockAssignment} required>
              <option value="">Select stock</option>
              {#each stockOptions as s}
                <option value={s.description}>{s.description}</option>
              {/each}
              <option value="__add__">Add stock option...</option>
              <option value="__other__">Other...</option>
            </select>
          </div>
          {#if stockAssignment === '__add__'}
            <div class="form-group">
              <label for="newStockDescription">New reusable stock option</label>
              <div class="stock-option-add-row">
                <input id="newStockDescription" type="text" maxlength="120" bind:value={newStockDescription} placeholder={'e.g. 1/8" SRPP Sheet'} on:input={() => (stockOptionError = '')} />
                <button type="button" class="btn btn-secondary" on:click={addStockOption} disabled={isAddingStock || !newStockDescription.trim()}>{isAddingStock ? 'Adding...' : 'Add stock'}</button>
              </div>
              <p class="form-hint">Saved for everyone using this manufacturing process.</p>
              {#if stockOptionError}<p class="form-error" role="alert">{stockOptionError}</p>{/if}
            </div>
          {/if}
          {#if stockAssignment === '__other__'}
            <div class="form-group">
              <label for="customStock">Custom Stock</label>
              <input id="customStock" type="text" bind:value={customStock} placeholder="Type custom stock" required />
            </div>
          {/if}
        </div>
      {/if}



      <!-- File Upload -->
      {#if workflow}
        <div class="form-section">
          <h2>File Upload</h2>
          {#if workflow === 'router'}
            <div class="upload-container">
              <div 
                class="file-drop-zone {uploadedStepFile ? 'has-file' : ''}"
                role="button"
                tabindex="0"
                on:dragover={handleDragOver}
                on:dragleave={handleDragLeave}
                on:drop={handleDropStep}
                on:click={() => document.getElementById('step-input').click()}
                on:keydown={(e) => e.key === 'Enter' && document.getElementById('step-input').click()}
              >
                <input 
                  id="step-input"
                  type="file" 
                  accept=".step,.stp"
                  on:change={handleStepUpload}
                  style="display: none;"
                />
                
                {#if uploadedStepFile}
                  <div class="uploaded-file">
                    <FileText size={48} />
                    <span class="file-name">{uploadedStepFile.name}</span>
                    <span class="file-size">{(uploadedStepFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                {:else}
                  <div class="upload-prompt">
                    <Upload size={48} />
                    <span class="upload-text">Drop STEP (.step/.stp) here or click to browse</span>
                    <span class="upload-subtext">Required</span>
                  </div>
                {/if}
              </div>
            </div>
          {:else if workflow === 'lathe'}
            <p class="cam-hint">Lathe parts need both a PDF print (for the shop) and a STEP file (so AutoCAM can generate turning G-code).</p>
            <div class="upload-container">
              <div
                class="file-drop-zone {uploadedFile ? 'has-file' : ''}"
                role="button"
                tabindex="0"
                on:dragover={handleDragOver}
                on:dragleave={handleDragLeave}
                on:drop={handleDrop}
                on:click={() => document.getElementById('file-input').click()}
                on:keydown={(e) => e.key === 'Enter' && document.getElementById('file-input').click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept=".pdf"
                  on:change={handleFileUpload}
                  style="display: none;"
                />
                {#if uploadedFile}
                  <div class="uploaded-file">
                    <FileText size={48} />
                    <span class="file-name">{uploadedFile.name}</span>
                    <span class="file-size">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                {:else}
                  <div class="upload-prompt">
                    <Upload size={48} />
                    <span class="upload-text">Drop PDF print here or click to browse</span>
                    <span class="upload-subtext">Required</span>
                  </div>
                {/if}
              </div>
            </div>
            <div class="upload-container">
              <div
                class="file-drop-zone {uploadedStepFile ? 'has-file' : ''}"
                role="button"
                tabindex="0"
                on:dragover={handleDragOver}
                on:dragleave={handleDragLeave}
                on:drop={handleDropStep}
                on:click={() => document.getElementById('step-input').click()}
                on:keydown={(e) => e.key === 'Enter' && document.getElementById('step-input').click()}
              >
                <input
                  id="step-input"
                  type="file"
                  accept=".step,.stp"
                  on:change={handleStepUpload}
                  style="display: none;"
                />
                {#if uploadedStepFile}
                  <div class="uploaded-file">
                    <FileText size={48} />
                    <span class="file-name">{uploadedStepFile.name}</span>
                    <span class="file-size">{(uploadedStepFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                {:else}
                  <div class="upload-prompt">
                    <Upload size={48} />
                    <span class="upload-text">Drop STEP (.step/.stp) here or click to browse</span>
                    <span class="upload-subtext">Required - modeled with the spindle axis along Z, centered at X=0, Y=0</span>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <div class="upload-container">
              <div
                class="file-drop-zone {uploadedFile ? 'has-file' : ''}"
                role="button"
                tabindex="0"
                on:dragover={handleDragOver}
                on:dragleave={handleDragLeave}
                on:drop={handleDrop}
                on:click={() => document.getElementById('file-input').click()}
                on:keydown={(e) => e.key === 'Enter' && document.getElementById('file-input').click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept=".{requiredFileType}"
                  on:change={handleFileUpload}
                  style="display: none;"
                />

                {#if uploadedFile}
                  <div class="uploaded-file">
                    <FileText size={48} />
                    <span class="file-name">{uploadedFile.name}</span>
                    <span class="file-size">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                {:else}
                  <div class="upload-prompt">
                    <Upload size={48} />
                    <span class="upload-text">Drop your {requiredFileType.toUpperCase()} file here or click to browse</span>
                    <span class="upload-subtext">Required file type: .{requiredFileType}</span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- AutoCAM job name (optional, router/lathe only - STEP is already required above) -->
      {#if supportsAutocam}
        <div class="form-section">
          <h2>AutoCAM</h2>
          <p class="cam-hint">
            AutoCAM will generate {workflow === 'lathe' ? 'turning' : 'routing'} G-code automatically from the STEP
            file above right after you submit - nothing else to attach.
          </p>
          <div class="form-group">
            <label for="camJobName">CAM Job Name <span class="optional-label">(optional, defaults to part name)</span></label>
            <input id="camJobName" type="text" bind:value={camJobName} placeholder={partName || 'Job name'} />
          </div>
        </div>
      {/if}

      <!-- Notes (optional) -->
      <div class="form-section">
        <div class="form-group">
          <label for="notes">Notes <span class="optional-label">(optional)</span></label>
          <textarea id="notes" bind:value={notes} rows="4" placeholder="Anything the manufacturing lead should know about this request..."></textarea>
        </div>
      </div>

      <!-- Submit Button -->
      <div class="form-actions">
        <button
          type="submit"
          class="submit-btn"
          disabled={isSubmitting || !partName || !requesterName || !workflow || !hasRequiredFiles || !quantity || quantity < 1}
        >
          {#if isSubmitting}
            Submitting...
          {:else}
            Submit Manufacturing Request
          {/if}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .header { margin-bottom: 2rem; }
  .header h1 { margin-bottom: 0.5rem; }
  .header p { color: var(--neutral-500); margin-bottom: 0; }
  .form-container { background: var(--primary); border: 1px solid var(--border); border-radius: 4px; padding: 1.5rem; margin-bottom: 1rem; }
  .form-section { margin-bottom: 2rem; }
  .form-section h2 { margin-bottom: 1rem; font-size: 1.25rem; font-weight: 600; }
  .form-group label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
  .optional-label { font-weight: 400; color: var(--text-muted); }
  .form-group input, .form-group select { width: 100%; border: 1px solid var(--border); }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--accent); }
  .stock-option-add-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; }
  .stock-option-add-row input { min-width: 0; }
  .stock-option-add-row button { white-space: nowrap; }
  .form-hint { margin: 0.45rem 0 0; color: var(--text-muted); font-size: 0.85rem; }
  .form-error { margin: 0.45rem 0 0; color: var(--danger, #b42318); font-size: 0.85rem; }
  .workflow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
  .workflow-card { display: block; padding: 1rem; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; position: relative; background: var(--primary); }
  .workflow-card input { position: absolute; opacity: 0; pointer-events: none; }
  .workflow-card:hover { border-color: var(--accent); }
  .workflow-card.selected { border-color: var(--accent); background-color: rgba(241, 195, 49, 0.1); }
  .workflow-content { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
  .workflow-name { font-weight: 600; }
  .workflow-file-type { font-size: 0.875rem; color: var(--neutral-500); background: var(--background); padding: 0.25rem 0.5rem; border-radius: 4px; }
  .upload-container { margin-top: 1rem; }
  .file-drop-zone { border: 1px dashed var(--border); border-radius: 4px; padding: 2rem; text-align: center; cursor: pointer; background: var(--background); }
  .file-drop-zone:hover, .file-drop-zone.active { border-color: var(--accent); }
  .file-drop-zone.has-file { border-color: var(--success); }
  .upload-prompt, .uploaded-file { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
  .upload-text { font-weight: 500; }
  .upload-subtext { font-size: 0.875rem; color: var(--neutral-500); }
  .cam-hint { font-size: 0.875rem; color: var(--neutral-500); margin-bottom: 1rem; }
  .file-name { font-weight: 600; color: var(--success); }
  .file-size { font-size: 0.875rem; color: var(--neutral-500); }
  .form-actions { margin-top: 2rem; text-align: center; }
  .submit-btn {
    background: var(--accent);
    color: var(--secondary);
    border: none;
    border-radius: 6px;
    font-weight: 600;
    font-size: 1.05rem;
    padding: 1rem 2.75rem;
    cursor: pointer;
    transition: opacity 0.15s ease, transform 0.05s ease;
  }
  .submit-btn:hover:not(:disabled) { opacity: 0.9; }
  .submit-btn:active:not(:disabled) { transform: scale(0.99); }
  .submit-btn:disabled { background: var(--neutral-300); cursor: not-allowed; }
  @media (max-width: 640px) {
    .workflow-grid { grid-template-columns: 1fr; }
    .stock-option-add-row { grid-template-columns: 1fr; }
  }
</style>
