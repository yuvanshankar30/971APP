/**
 * Autocam utility functions for Spartans Hub
 * Handles automatic CAM processing for sheet stock parts
 */

import { supabase } from '$lib/supabase.js';
import stockData from '$lib/stock.json';
import { DISABLE_AUTOCAM } from '$lib/config/autocam.js';

/**
 * Check if a part is eligible for autocam (sheet stock with router workflow)
 * @param {Object} part - Part object from database
 * @returns {boolean} - True if eligible for autocam
 */
export function isAutocamEligible(part) {
  if (!part || part.workflow !== 'router') return false;
  
  // Check if stock assignment is a sheet type
  const stockId = part.stock_assignment;
  if (!stockId) return false;
  
  // Check router stocks for sheet dimension
  const routerStocks = stockData?.router || [];
  const stock = routerStocks.find(s => s.id === stockId);
  return stock?.dimensions === 'Sheet';
}

/**
 * Get stock configuration for a part
 * @param {Object} part - Part object
 * @returns {Object|null} - Stock configuration or null
 */
export function getStockConfig(part) {
  if (!part?.stock_assignment) return null;
  const routerStocks = stockData?.router || [];
  return routerStocks.find(s => s.id === part.stock_assignment) || null;
}

/**
 * Check if autocam is globally enabled
 * @returns {Promise<{enabled: boolean, settings: Object}>}
 */
export async function getAutocamSettings() {
  try {
    if (DISABLE_AUTOCAM) {
      return { enabled: false, settings: { _disabled: true } };
    }
    const { data, error } = await supabase
      .from('autocam_settings')
      .select('*')
      .eq('id', 'global')
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    
    return {
      enabled: data?.enabled ?? false,
      settings: data || {}
    };
  } catch (e) {
    console.error('Failed to get autocam settings:', e);
    return { enabled: false, settings: {} };
  }
}

/**
 * Get autocam profile for a stock type
 * @param {string} stockId - Stock type ID
 * @returns {Promise<Object|null>} - Profile configuration or null
 */
export async function getAutocamProfile(stockId) {
  if (!stockId) return null;
  
  try {
    const { data, error } = await supabase
      .from('autocam_profiles')
      .select('*')
      .eq('stock_id', stockId)
      .eq('enabled', true)
      .single();
    
    if (error && error.code !== 'PGRST116') return null;
    return data;
  } catch (e) {
    console.error('Failed to get autocam profile:', e);
    return null;
  }
}

/**
 * Trigger autocam processing for a part
 * @param {Object} part - Part object with Onshape or DXF information
 * @param {Object} options - Additional options
 * @returns {Promise<{success: boolean, jobId?: string, error?: string}>}
 */
export async function triggerAutocam(part, options = {}) {
  try {
    // Quick disable check
    if (DISABLE_AUTOCAM) return { success: false, error: 'Autocam disabled by config' };

    // Check if autocam is enabled in settings
    const { enabled, settings } = await getAutocamSettings();
    if (!enabled) {
      return { success: false, error: 'Autocam is disabled' };
    }
    
    // Check if part is eligible
    if (!isAutocamEligible(part)) {
      return { success: false, error: 'Part is not eligible for autocam' };
    }
    
    // Get the autocam profile
    const profile = await getAutocamProfile(part.stock_assignment);
    if (!profile) {
      return { success: false, error: 'No autocam profile configured for this stock type' };
    }
    
    // Get stock config for material thickness
    const stockConfig = getStockConfig(part);
    if (!stockConfig?.thickness) {
      return { success: false, error: 'Stock thickness not configured' };
    }
    
    // Build the autocam request
    const autocamRequest = {
      part_id: part.id,
      part_name: part.name || 'part',
      material_preset: profile.material_preset || 'aluminum',
      material_thickness: stockConfig.thickness,
      tool_diameter: profile.tool_diameter || settings.default_tool_diameter || 0.25,
      stock_id: part.stock_assignment,
      
      // Optional overrides from profile
      feed_rate: profile.feed_rate,
      ramp_feed_rate: profile.ramp_feed_rate,
      plunge_rate: profile.plunge_rate,
      spindle_speed: profile.spindle_speed,
      ramp_angle: profile.ramp_angle,
      stepover_percentage: profile.stepover_percentage,
      tab_width: profile.tab_width,
      tab_height: profile.tab_height,
      tab_spacing: profile.tab_spacing
    };
    
    // Determine DXF source
    if (part.is_onshape_part || part.source_type === 'onshape_api') {
      // Onshape part - need to export DXF
      autocamRequest.dxf_source = 'onshape';
      autocamRequest.onshape_document_id = part.onshape_document_id;
      autocamRequest.onshape_workspace_id = part.onshape_wvmid;
      autocamRequest.onshape_element_id = part.onshape_element_id;
      autocamRequest.onshape_part_id = part.onshape_part_id;
    } else {
      // Check for DXF in file_url metadata or file_name
      const meta = parsePartMeta(part);
      if (meta?.dxf_url) {
        autocamRequest.dxf_source = 'url';
        autocamRequest.dxf_url = meta.dxf_url;
      } else if (part.file_name?.toLowerCase().endsWith('.dxf')) {
        // DXF file in storage
        autocamRequest.dxf_source = 'url';
        // Construct the storage URL
        const { data: signedUrl } = await supabase.storage
          .from('manufacturing-files')
          .createSignedUrl(part.file_name, 3600);
        if (signedUrl?.signedUrl) {
          autocamRequest.dxf_url = signedUrl.signedUrl;
        } else {
          return { success: false, error: 'Could not get DXF file URL' };
        }
      } else {
        return { success: false, error: 'No DXF file available for autocam' };
      }
    }
    
    // Create the autocam job record
    const { data: job, error: jobError } = await supabase
      .from('autocam_jobs')
      .insert({
        part_id: part.id,
        status: 'pending',
        dxf_source: autocamRequest.dxf_source,
        dxf_url: autocamRequest.dxf_url,
        stock_id: part.stock_assignment,
        profile_id: profile.id,
        material_thickness: stockConfig.thickness
      })
      .select()
      .single();
    
    if (jobError) throw jobError;
    
    // Call the autocam API
    const response = await fetch('/api/autocam?action=generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(autocamRequest)
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Update the job with results
      await supabase
        .from('autocam_jobs')
        .update({
          status: 'completed',
          gcode: result.gcode,
          gcode_file_name: result.filename,
          processing_time_ms: result.processing_time_ms,
          warnings: result.warnings || [],
          stats: result.stats || {}
        })
        .eq('id', job.id);
      
      // Update part status to 'autocammed', remembering the stage it was at.
      //
      // 'autocammed' replaces whatever the part's status was, and AutoCAM
      // does not move a part along the shop route - a person still has to
      // review the G-code, starting from where the part already was. The
      // manufacture list therefore shows "Autocammed" while leaving the
      // progress bar where it is, and that needs the stage this overwrote.
      // Read from the row rather than the caller's copy, which can be stale.
      const { data: current, error: currentError } = await supabase
        .from('parts')
        .select('status, file_url')
        .eq('id', part.id)
        .single();

      const statusUpdate = { status: 'autocammed', updated_at: new Date().toISOString() };

      // file_url is one JSON blob that also holds step_file/step_valid, so it
      // is only rewritten from a row we actually read back. Writing a fresh
      // object built from a failed read would drop the STEP file with it -
      // losing the part's CAD is far worse than losing the progress bar's
      // starting stage, which falls back to pending on its own.
      if (!currentError && current) {
        let fileMeta = {};
        try {
          fileMeta = JSON.parse(current.file_url || '{}') || {};
        } catch {
          fileMeta = {};
        }
        const previousStatus = current.status || 'pending';
        // Re-running AutoCAM on an already-autocammed part must not record
        // 'autocammed' as the stage it came from - keep the original.
        if (previousStatus !== 'autocammed') {
          fileMeta.router_meta = { ...(fileMeta.router_meta || {}), autocam_from_status: previousStatus };
          statusUpdate.file_url = JSON.stringify(fileMeta);
        }
      }

      await supabase.from('parts').update(statusUpdate).eq('id', part.id);
      
      return { success: true, jobId: job.id };
    } else {
      // Update job with failure
      await supabase
        .from('autocam_jobs')
        .update({
          status: 'failed',
          errors: result.errors || [result.error || 'Unknown error'],
          processing_time_ms: result.processing_time_ms
        })
        .eq('id', job.id);
      
      return { success: false, error: result.errors?.[0] || result.error || 'Autocam failed' };
    }
  } catch (e) {
    console.error('Autocam trigger failed:', e);
    return { success: false, error: e.message || 'Autocam processing failed' };
  }
}

/**
 * Parse part file_url metadata
 * @param {Object} part - Part object
 * @returns {Object} - Parsed metadata
 */
function parsePartMeta(part) {
  try {
    return JSON.parse(part?.file_url || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * Process new pending sheet stock parts for autocam
 * This can be called periodically or when new parts are added
 * @returns {Promise<{processed: number, failed: number, errors: string[]}>}
 */
export async function processQueuedAutocamParts() {
  const results = {
    processed: 0,
    failed: 0,
    errors: []
  };
  
  try {
    // Quick disable check
    if (DISABLE_AUTOCAM) return results;

    // Check if autocam is enabled in settings
    const { enabled } = await getAutocamSettings();
    if (!enabled) {
      return results;
    }
    
    // Get pending router parts that are sheet stock
    const { data: parts, error } = await supabase
      .from('parts')
      .select('*')
      .eq('workflow', 'router')
      .eq('status', 'pending');
    
    if (error) throw error;
    
    // Filter to only sheet stock parts
    const eligibleParts = (parts || []).filter(isAutocamEligible);
    
    for (const part of eligibleParts) {
      const result = await triggerAutocam(part);
      if (result.success) {
        results.processed++;
      } else {
        results.failed++;
        results.errors.push(`Part ${part.name}: ${result.error}`);
      }
    }
  } catch (e) {
    console.error('Failed to process autocam queue:', e);
    results.errors.push(e.message);
  }
  
  return results;
}

export default {
  isAutocamEligible,
  getStockConfig,
  getAutocamSettings,
  getAutocamProfile,
  triggerAutocam,
  processQueuedAutocamParts
};
