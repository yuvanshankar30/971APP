// Deliberately does NOT import the Onshape credentials. This module runs in
// the browser (it is imported by the cad/* pages), and anything read from
// $env/static/public is inlined into the client bundle - so importing the
// secret key here published it to every visitor, whether or not it was used.
// It was in fact never used: every call below goes through /api/onshape, and
// only that server route signs requests. See GitHub issue #86.
import { PUBLIC_ONSHAPE_BASE_URL } from '$env/static/public';
import { partClassificationService } from './bom_classify.js';

const ENABLE_BBOX = false;

// Circuit breaker for Onshape rate limiting (HTTP 402). When Onshape reports
// the API limit is exceeded, firing more requests only makes it worse, so we
// pause document-info calls for a short cooldown instead of retrying.
let rateLimitedUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

function normalizeOnshapeWvmType(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'w' || normalized === 'workspace') return 'w';
    if (normalized === 'v' || normalized === 'version') return 'v';
    if (normalized === 'm' || normalized === 'microversion') return 'm';
    return normalized;
}

class OnShapeAPI {
    constructor() {
        this.baseUrl = PUBLIC_ONSHAPE_BASE_URL || 'https://cad.onshape.com';
        // Use our server-side API route to avoid CORS issues
        this.apiRoute = '/api/onshape';
    }

    // Parse OnShape URL to extract document info
    parseOnShapeUrl(url) {
        // Support both standard and enterprise OnShape URLs and both workspace (/w/) and version (/v/) paths
        // Examples:
        // https://cad.onshape.com/documents/<documentId>/w/<workspaceId>/e/<elementId>
        // https://<org>.onshape.com/documents/<documentId>/v/<versionId>/e/<elementId>
        const regex = /https:\/\/[^\/]+\.onshape\.com\/documents\/([a-f0-9]{24})\/(w|v)\/([a-f0-9]{24})\/e\/([a-f0-9]{24})/i;
        const match = url.match(regex);

        if (match) {
            const documentId = match[1];
            const kind = match[2].toLowerCase();
            const id = match[3];
            const elementId = match[4];

            const result = { documentId, elementId };
            if (kind === 'w') {
                result.workspaceId = id;
            } else if (kind === 'v') {
                result.versionId = id;
            }
            return result;
        }

        // Fallback: also accept URLs that omit the /e/<elementId> (rare) or use slightly different path casing
        const looseRegex = /https:\/\/[^\/]+\.onshape\.com\/documents\/([a-f0-9]{24})(?:\/(w|v)\/([a-f0-9]{24}))?/i;
        const looseMatch = url.match(looseRegex);
        if (looseMatch) {
            const documentId = looseMatch[1];
            const result = { documentId };
            if (looseMatch[2] && looseMatch[3]) {
                if (looseMatch[2].toLowerCase() === 'w') result.workspaceId = looseMatch[3];
                else result.versionId = looseMatch[3];
            }
            return result;
        }

        return null;
    }    // Get document information
    async getDocumentInfo(documentId) {
        // Skip the request entirely while we're in the rate-limit cooldown.
        if (Date.now() < rateLimitedUntil) {
            throw new Error('Onshape API rate limited (402) — cooling down');
        }
        try {
            const response = await fetch(`${this.apiRoute}?action=document-info&documentId=${documentId}`);

            // Onshape API limit exceeded — start a cooldown and stop retrying.
            if (response.status === 402) {
                rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                throw new Error('Onshape API limit exceeded (402)');
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching document info:', error);
            throw error;
        }
    }

    // Get assembly information (replaces releases/versions for now)
    async getAssemblyInfo(documentId, workspaceId, elementId) {
        if (Date.now() < rateLimitedUntil) {
            throw new Error('Onshape API rate limited (402) — cooling down');
        }
        try {
            const params = new URLSearchParams({
                action: 'assembly-info',
                documentId,
                workspaceId,
                elementId
            });

            const response = await fetch(`${this.apiRoute}?${params}`);

            if (response.status === 402) {
                rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                throw new Error('Onshape API limit exceeded (402)');
            }
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching assembly info:', error);
            throw error;
        }
    }    // Get document releases (placeholder - endpoint may not exist)
    async getDocumentReleases(documentId) {
        console.warn('Document releases endpoint may not be available in OnShape API v11. Using empty array.');
        return [];
    }

    // Get document versions
    async getDocumentVersions(documentId) {
        if (Date.now() < rateLimitedUntil) {
            throw new Error('Onshape API rate limited (402) — cooling down');
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second client timeout

            const response = await fetch(`${this.apiRoute}?action=versions&documentId=${documentId}`, {
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.status === 402) {
                rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                throw new Error('Onshape API limit exceeded (402)');
            }
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout - OnShape API is taking too long to respond');
            }
            console.error('Error fetching document versions:', error);
            throw error;
        }
    }

    // Get version details to check if it's a release
    async getVersionDetails(documentId, versionId) {
        if (Date.now() < rateLimitedUntil) {
            throw new Error('Onshape API rate limited (402) — cooling down');
        }
        try {
            const params = new URLSearchParams({
                action: 'version-details',
                documentId,
                versionId
            });

            const response = await fetch(`${this.apiRoute}?${params}`);

            if (response.status === 402) {
                rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                throw new Error('Onshape API limit exceeded (402)');
            }
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching version details:', error);
            throw error;
        }
    }    // Get assembly BOM for a specific version
    async getAssemblyBOM(documentId, workspaceId, elementId, versionId = null) {
        if (Date.now() < rateLimitedUntil) {
            throw new Error('Onshape API rate limited (402) — cooling down');
        }
        try {
            const params = new URLSearchParams({
                action: 'assembly-bom',
                documentId,
                workspaceId,
                elementId,
                indented: 'false'  // Return flattened BOM with all rows collapsed
            });

            // If versionId is provided, use version mode, otherwise use workspace mode
            if (versionId) {
                params.append('wvm', 'v');
                params.append('wvmid', versionId);
            } else {
                params.append('wvm', 'w');
                params.append('wvmid', workspaceId);
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for BOM
            
            const response = await fetch(`${this.apiRoute}?${params}`, {
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.status === 402) {
                rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                throw new Error('Onshape API limit exceeded (402)');
            }
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
            }
              return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout - OnShape BOM API is taking too long to respond');
            }
            console.error('Error fetching assembly BOM:', error);
            throw error;
        }
    }// Get part bounding box
    async getPartBoundingBox(documentId, wvm, wvmId, elementId, partId) {
        try {            const params = new URLSearchParams({
                action: 'part-bounding-box',
                documentId,
                wvm,
                wvmId,
                elementId,
                partId
            });
            
            console.log('Bounding box request params:', {
                documentId, wvm, wvmId, elementId, partId
            });
            
            const response = await fetch(`${this.apiRoute}?${params}`);
              if (!response.ok) {
                const errorText = await response.text();
                console.error(`Bounding box API error ${response.status}:`, errorText);
                console.error('Request URL:', `${this.apiRoute}?${params}`);
                throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching part bounding box:', error);
            throw error;
        }
    }

    // Placeholder for part properties (not available in current API endpoint structure)
    async getPartProperties(documentId, workspaceId, elementId, partId) {
        console.warn('Part properties endpoint not available in current OnShape API structure. Using empty object.');
        return {};
    }    // Analyze BOM and categorize parts using manual classification rules
    async analyzeBOM(bom, workspaceId = null) {
        try {
            const analyzedParts = [];
        
        // BOM data structure:
        // - headers: array of {id, name, propertyName, valueType}
        // - rows: array of objects with headerIdToValue mapping
        const bomItems = bom.rows || [];
        const headers = bom.headers || [];
        
        console.log('Processing BOM items:', bomItems.length);
        console.log('BOM headers:', headers);
        console.log('BOM structure sample:', bom);
        
        // Create a map of header IDs to property information
        const headerMap = {};
        headers.forEach(header => {
            headerMap[header.id] = {
                propertyName: header.propertyName,
                name: header.name,
                valueType: header.valueType
            };
        });
        
        console.log('Header map:', headerMap);
        
        // Debug: log the first few items to see their structure
        if (bomItems.length > 0) {
            console.log('First BOM item structure:', bomItems[0]);
            console.log('Header ID to value mapping:', bomItems[0].headerIdToValue);
        }
        
        // Debug: show all available headers to understand the structure
        if (headers.length > 0) {
            console.log('=== AVAILABLE HEADERS ===');
            headers.forEach(header => {
                console.log(`Header ID: ${header.id}`);
                console.log(`  - Name: "${header.name}"`);
                console.log(`  - Property Name: "${header.propertyName}"`);
                console.log(`  - Value Type: "${header.valueType}"`);
                console.log('---');
            });
        }

        // Debug: show first item's actual values
        if (bomItems.length > 0) {
            console.log('=== FIRST ITEM VALUES ===');
            const firstItem = bomItems[0];
            const headerValues = firstItem.headerIdToValue || {};
            Object.entries(headerValues).forEach(([headerId, value]) => {
                const header = headerMap[headerId];
                console.log(`Header ${headerId} (${header?.name || 'unknown'}): "${value}"`);
            });
        }        // Get workspace ID from multiple possible sources
        const resolvedWorkspaceId = workspaceId || 
                                  bom.bomSource?.workspace?.id || 
                                  bom.workspaceId || 
                                  bom.bomSource?.workspaceId ||
                                  bom.bomSource?.documentVersion?.microversion?.documentId; // Try document ID as fallback
        
        console.log('Workspace ID parameter passed:', workspaceId);
        console.log('BOM Source workspace:', bom.bomSource?.workspace?.id);
        console.log('BOM workspaceId:', bom.workspaceId);
        console.log('BOM Source workspaceId:', bom.bomSource?.workspaceId);
        console.log('BOM Document ID:', bom.bomSource?.document?.id);
        console.log('Final resolved workspace ID:', resolvedWorkspaceId);
        
        // Prepare data for manual classification analysis
        const bomDataForAI = [];
        
        for (const item of bomItems) {
            try {
                console.log('Processing BOM item:', item);
                
                // Skip items that are excluded from BOM
                if (item.excludeFromBom === true) {
                    console.log('Skipping item excluded from BOM');
                    continue;
                }
                
                // Extract part information using OnShape's headerIdToValue structure
                const headerValues = item.headerIdToValue || {};
                
                let partName = 'Unknown Part';
                let partNumber = '';
                let quantity = 1;
                let partId = '';
                let description = '';
                let material = '';
                let vendor = '';                // Map the row data using headers - try different property name variations
                for (const [headerId, value] of Object.entries(headerValues)) {
                    const header = headerMap[headerId];
                    if (!header) continue;
                    
                    console.log(`Processing header ${headerId} (${header.propertyName || header.name}):`, value);
                    
                    const propName = (header.propertyName || header.name || '').toLowerCase();
                    
                    // More flexible matching for part names - PRIORITIZE "name" over "item"
                    // "name" is the actual part name, "item" is just the BOM position number
                    if (propName === 'name' || propName === 'part name') {
                        if (value && String(value).trim() !== '' && String(value) !== 'Unknown Part') {
                            partName = String(value);
                            console.log(`Found part name "${partName}" from header "${propName}"`);
                        }
                    }
                    // Secondary name matches - but only if we haven't found a good name yet
                    else if ((propName.includes('name') || propName.includes('component')) && partName === 'Unknown Part') {
                        if (value && String(value).trim() !== '' && String(value) !== 'Unknown Part') {
                            partName = String(value);
                            console.log(`Found part name "${partName}" from secondary header "${propName}"`);
                        }
                    }
                    // Part number matching
                    else if (propName.includes('partnumber') || propName.includes('part number') || propName === 'part number' || 
                             propName.includes('part_number') || propName.includes('number')) {
                        if (value) {
                            partNumber = String(value);
                            console.log(`Found part number "${partNumber}" from header "${propName}"`);
                        }
                    }
                    // Quantity matching
                    else if (propName.includes('quantity') || propName.includes('qty')) {
                        if (value) {
                            quantity = parseFloat(value) || 1;
                            console.log(`Found quantity ${quantity} from header "${propName}"`);
                        }
                    }
                    // Description matching
                    else if (propName.includes('description') || propName.includes('desc')) {
                        if (value) {
                            description = String(value);
                            console.log(`Found description "${description}" from header "${propName}"`);
                        }
                    }
                    // Vendor matching
                    else if (propName.includes('vendor') || propName.includes('supplier')) {
                        if (value) {
                            vendor = String(value);
                            console.log(`Found vendor "${vendor}" from header "${propName}"`);
                        }
                    }
                    // Material matching
                    else if (propName.includes('material')) {
                        if (value && typeof value === 'object') {
                            material = value.displayName || value.name || String(value);
                        } else if (value) {
                            material = String(value);
                        }
                        if (material) {
                            console.log(`Found material "${material}" from header "${propName}"`);
                        }
                    }
                }

                // Get part ID and Part Studio element ID from item source
                let partStudioElementId = '';
                let sourceDocumentId = '';
                let sourceWvmId = '';
                let sourceWvmType = '';
                if (item.itemSource && item.itemSource.partId) {
                    partId = item.itemSource.partId;
                }
                if (item.itemSource && item.itemSource.elementId) {
                    partStudioElementId = item.itemSource.elementId;
                }
                if (item.itemSource && item.itemSource.documentId) {
                    sourceDocumentId = item.itemSource.documentId;
                }
                if (item.itemSource && item.itemSource.wvmId) {
                    sourceWvmId = item.itemSource.wvmId;
                }
                if (item.itemSource && item.itemSource.wvmType) {
                    sourceWvmType = normalizeOnshapeWvmType(item.itemSource.wvmType);
                }
                
                console.log('Part source info:', {
                    partId,
                    partStudioElementId,
                    sourceDocumentId,
                    sourceWvmId,
                    sourceWvmType,
                    itemSource: item.itemSource
                });
                
                console.log('Extracted data:', { 
                    partName, 
                    partNumber, 
                    quantity, 
                    partId, 
                    description, 
                    material, 
                    vendor 
                });

                let boundingBox = null;
                let boundingBoxX = null;
                let boundingBoxY = null;
                let boundingBoxZ = null;

                if (ENABLE_BBOX) {
                    // Bounding box fetch logic would go here
                    console.log('Bounding box fetch enabled');
                } else {
                    console.log('Bounding box fetch disabled; skipping bounding box lookup for all parts');
                }
                
                // Add to data for AI analysis
                bomDataForAI.push({
                    name: partName,
                    description: description,
                    vendor: vendor,
                    material: material,
                    part_number: partNumber,
                    bounding_box: boundingBox || 'Unknown',
                    bounding_box_x: boundingBoxX,
                    bounding_box_y: boundingBoxY,
                    bounding_box_z: boundingBoxZ,
                    quantity: quantity,
                    onshape_document_id: sourceDocumentId,
                    onshape_wvm: sourceWvmType,
                    onshape_wvmid: sourceWvmId,
                    onshape_element_id: partStudioElementId,
                    onshape_part_id: partId,
                    onshape_part_studio_element_id: partStudioElementId
                });
                
            } catch (error) {
                console.error('Error processing BOM item:', error);
            }
        }
        
        console.log('BOM data prepared for AI:', bomDataForAI);        
        // Use manual classification rules
        let classifications = [];
        try {
            console.log('Classifying BOM data using manual rules...');
            classifications = await partClassificationService.classifyParts(bomDataForAI);
            console.log('Manual classifications completed:', classifications);
        } catch (classificationError) {
            console.error('Manual classification failed:', classificationError);
            // Fallback to basic classification
            classifications = bomDataForAI.map(item => ({
                part_name: item.name || item.part_name || 'Unknown',
                classification: 'COTS',
                manufacturing_process: null
            }));
        }
        
        // Combine BOM data with AI classifications
        for (let i = 0; i < bomDataForAI.length; i++) {
            const bomItem = bomDataForAI[i];
            const classification = classifications[i] || {
                classification: 'manufactured',
                manufacturing_process: 'mill'
            };
            
            // Map classification to our part type system
            let partType = classification.classification === 'COTS' ? 'COTS' : 'manufactured';
            let workflow = classification.manufacturing_process || 'mill';
              analyzedParts.push({
                part_name: bomItem.name,
                part_number: bomItem.part_number,
                quantity: bomItem.quantity,
                part_type: partType,
                material: bomItem.material,
                workflow: workflow,
                onshape_document_id: bomItem.onshape_document_id,
                onshape_wvm: bomItem.onshape_wvm,
                onshape_wvmid: bomItem.onshape_wvmid,
                onshape_element_id: bomItem.onshape_element_id,
                onshape_part_id: bomItem.onshape_part_id,
                onshape_part_studio_element_id: bomItem.onshape_part_studio_element_id,
                bounding_box_x: bomItem.bounding_box_x,
                bounding_box_y: bomItem.bounding_box_y,
                bounding_box_z: bomItem.bounding_box_z,
                stock_assignment: '',
                status: 'pending',
                vendor: bomItem.vendor,
                description: bomItem.description
            });}
          console.log('Final analyzed parts:', analyzedParts);
        console.log('About to return analyzedParts, length:', analyzedParts.length);
        return analyzedParts;
        } catch (error) {
            console.error('Error in analyzeBOM:', error);            throw error;
        }
    }

    // Auto-assign stock based on part properties and available stock
    async autoAssignStock(parts, stockTypes) {
        for (const part of parts) {
            if (part.part_type === 'manufactured' && part.material) {
                // Find matching stock type
                const matchingStock = stockTypes.find(stock => 
                    stock.material.toLowerCase().includes(part.material.toLowerCase()) &&
                    stock.workflow === part.workflow
                );
                
                if (matchingStock) {
                    part.stock_assignment = `${matchingStock.material} - ${matchingStock.stock_type}`;
                }
            }
        }
        
        return parts;
    }
}

export const onShapeAPI = new OnShapeAPI();
