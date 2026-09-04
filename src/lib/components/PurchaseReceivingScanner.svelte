<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { Camera, CheckCircle, LoaderCircle, PackageCheck, RefreshCw, ScanLine, Upload, X } from 'lucide-svelte';
  import { supabase } from '$lib/supabase.js';
  import { toastActions } from '$lib/toast.js';

  export let enabled = false;
  const dispatch = createEventDispatcher();
  let isPhone = false;
  let open = false;
  let stream = null;
  let video;
  let fileInput;
  let photo = '';
  let stage = 'camera';
  let extraction = null;
  let candidates = [];
  let selected = null;
  let error = '';

  onMount(() => {
    const query = window.matchMedia('(max-width: 767px) and (pointer: coarse)');
    const refresh = () => { isPhone = query.matches; };
    refresh();
    query.addEventListener?.('change', refresh);
    return () => query.removeEventListener?.('change', refresh);
  });
  onDestroy(stopCamera);

  function stopCamera() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  async function openScanner() {
    if (!enabled) return;
    open = true;
    stage = isPhone ? 'camera' : 'phone-only';
    photo = '';
    candidates = [];
    selected = null;
    extraction = null;
    error = '';
    if (isPhone) await startCamera();
  }

  async function startCamera() {
    stopCamera();
    error = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
    } catch {
      error = 'Camera access is unavailable. Choose a photo instead.';
    }
  }

  function close() {
    stopCamera();
    open = false;
  }

  function capture() {
    if (!video?.videoWidth) return;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    photo = canvas.toDataURL('image/jpeg', 0.82);
    stopCamera();
    stage = 'review';
  }

  function chooseFile() { fileInput?.click(); }
  function loadFile(event) {
    const file = event.currentTarget.files?.[0];
    if (!file?.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => { photo = String(reader.result); stage = 'review'; stopCamera(); };
    reader.readAsDataURL(file);
    event.currentTarget.value = '';
  }

  async function authedFetch(url, body) {
    const { data } = await supabase.auth.getSession();
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(data?.session?.access_token ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
      body: JSON.stringify(body)
    });
  }

  async function identify() {
    stage = 'identifying';
    error = '';
    try {
      const response = await authedFetch('/api/purchasing/identify-photo', { image: photo });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not identify this photo.');
      extraction = data.extraction;
      candidates = data.candidates || [];
      selected = candidates[0] || null;
      stage = candidates.length ? 'confirm' : 'unmatched';
    } catch (err) {
      error = err.message || 'Could not identify this photo.';
      stage = 'review';
    }
  }

  async function checkoff() {
    if (!selected) return;
    stage = 'checking-off';
    try {
      const response = await authedFetch('/api/purchasing/checkoff', {
        purchasing_id: selected.id,
        match_confidence: selected.confidence,
        extracted_text: extraction?.rawText || ''
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not mark this item delivered.');
      toastActions.show(data.already_checked_off ? 'This item was already checked off.' : `${selected.name} marked delivered.`);
      dispatch('complete', data);
      stage = 'complete';
    } catch (err) {
      error = err.message || 'Could not mark this item delivered.';
      stage = 'confirm';
    }
  }
</script>

<button class="btn btn-secondary receiving-scan-button" disabled={!enabled} on:click={openScanner} title={isPhone ? 'Scan a delivered item' : 'Scan is available on phones'}>
  <ScanLine size={16} /> Scan
</button>

{#if open}
  <div class="modal-backdrop" role="presentation" on:click|self={close}>
    <section class="modal receiving-modal" role="dialog" aria-modal="true" aria-label="Scan delivered item">
      <div class="modal-header">
        <div><h3>Scan delivery</h3><p>Photos are sent to OpenAI only to identify the package. They are not saved.</p></div>
        <button class="btn btn-icon" aria-label="Close scanner" on:click={close}><X size={18} /></button>
      </div>
      <div class="modal-body">
        {#if stage === 'camera'}
          <div class="camera-frame"><video bind:this={video} playsinline muted></video></div>
          {#if error}<p class="scan-error">{error}</p>{/if}
          <div class="scanner-actions">
            <button class="btn btn-primary" disabled={!stream} on:click={capture}><Camera size={16} /> Capture</button>
            <button class="btn btn-secondary" on:click={chooseFile}><Upload size={16} /> Choose photo</button>
          </div>
        {:else if stage === 'phone-only'}
          <div class="scan-progress"><ScanLine size={28} /><strong>Use a phone to scan a delivery.</strong><span>The camera opens only on a phone. This computer view cannot take or upload a receiving photo.</span></div>
          <div class="scanner-actions"><button class="btn btn-primary" on:click={close}>Done</button></div>
        {:else if stage === 'review'}
          <img class="capture-preview" src={photo} alt="Package ready to scan" />
          {#if error}<p class="scan-error">{error}</p>{/if}
          <div class="scanner-actions"><button class="btn btn-secondary" on:click={startCamera}><RefreshCw size={16} /> Retake</button><button class="btn btn-primary" on:click={identify}><ScanLine size={16} /> Scan item</button></div>
        {:else if stage === 'identifying' || stage === 'checking-off'}
          <div class="scan-progress"><LoaderCircle class="spin" size={28} /><strong>{stage === 'identifying' ? 'Reading package details...' : 'Marking item delivered...'}</strong><span>This may take a moment.</span></div>
        {:else if stage === 'confirm'}
          <div class="confirmation-layout"><img class="confirmation-photo" src={photo} alt="Scanned package" /><div class="candidate-panel"><span class="eyebrow">Best match</span><strong>{selected?.name}</strong><span>{selected?.vendor || 'Vendor not recorded'}</span><span>Project {selected?.project_id || 'not recorded'} · Qty {selected?.quantity || 1}</span><span class="confidence">{Math.round((selected?.confidence || 0) * 100)}% match</span></div></div>
          {#if candidates.length > 1}<label class="form-label" for="scan-candidate">Choose a different match</label><select id="scan-candidate" class="form-select" value={selected?.id} on:change={(event) => selected = candidates.find((candidate) => String(candidate.id) === event.currentTarget.value) || selected}>{#each candidates as candidate}<option value={candidate.id}>{candidate.name} ({Math.round(candidate.confidence * 100)}%)</option>{/each}</select>{/if}
          {#if error}<p class="scan-error">{error}</p>{/if}
          <div class="scanner-actions"><button class="btn btn-secondary" on:click={() => stage = 'review'}>Use another photo</button><button class="btn btn-primary" on:click={checkoff}><PackageCheck size={16} /> Mark delivered</button></div>
        {:else if stage === 'unmatched'}
          <div class="scan-progress"><ScanLine size={28} /><strong>No purchasing item matched this photo.</strong><span>Try a clearer photo of the shipping label or packing slip.</span></div><div class="scanner-actions"><button class="btn btn-secondary" on:click={() => stage = 'review'}>Try another photo</button></div>
        {:else if stage === 'complete'}
          <div class="scan-progress scan-complete"><CheckCircle size={30} /><strong>Delivery checked off</strong><span>{selected?.name} is now marked delivered.</span></div><div class="scanner-actions"><button class="btn btn-primary" on:click={close}>Done</button></div>
        {/if}
        <input class="file-input" bind:this={fileInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" on:change={loadFile} />
      </div>
    </section>
  </div>
{/if}

<style>
  .receiving-modal { width: min(34rem, calc(100vw - 1rem)); max-height: calc(100dvh - 1rem); display: flex; flex-direction: column; }
  .receiving-modal .modal-header { align-items: flex-start; }
  .receiving-modal h3 { margin: 0; }
  .receiving-modal p { margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.85rem; line-height: 1.35; }
  .receiving-modal .modal-body { overflow: auto; display: grid; gap: 0.85rem; }
  .camera-frame { background: #151515; aspect-ratio: 3 / 4; border-radius: var(--radius-sm); overflow: hidden; }
  .camera-frame video, .capture-preview, .confirmation-photo { width: 100%; height: 100%; object-fit: cover; display: block; }
  .capture-preview { max-height: 58dvh; border-radius: var(--radius-sm); object-fit: contain; background: #151515; }
  .scanner-actions { display: flex; gap: 0.5rem; justify-content: flex-end; flex-wrap: wrap; }
  .scan-progress { min-height: 15rem; display: grid; place-content: center; justify-items: center; gap: 0.6rem; text-align: center; color: var(--text-muted); }
  .scan-progress strong { color: var(--text); }
  .scan-complete svg { color: var(--green-strong); }
  .confirmation-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 0.9fr); gap: 0.75rem; }
  .confirmation-photo { aspect-ratio: 1; border-radius: var(--radius-sm); }
  .candidate-panel { border: 1px solid var(--border); padding: 0.75rem; display: grid; align-content: start; gap: 0.4rem; border-radius: var(--radius-sm); }
  .candidate-panel strong { font-size: 1rem; }
  .candidate-panel span { font-size: 0.85rem; color: var(--text-muted); }
  .candidate-panel .confidence { color: var(--green-strong); font-weight: 700; }
  .eyebrow { color: var(--text-muted); font-size: 0.68rem; font-family: var(--font-mono-stack); text-transform: uppercase; letter-spacing: 0.08em; }
  .scan-error { color: var(--red-strong) !important; }
  .spin { animation: spin 0.85s linear infinite; }
  .file-input { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 420px) { .confirmation-layout { grid-template-columns: 1fr; } .confirmation-photo { aspect-ratio: 16 / 9; } .scanner-actions .btn { flex: 1 1 auto; justify-content: center; } }
</style>
