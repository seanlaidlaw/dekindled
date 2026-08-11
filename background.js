// DeKindled - Background service worker

// --- Logging helpers (toggle with DK_DEBUG) ---
const DK_DEBUG = false;
const _tag = '[DeKindled][bg]';
const dklog  = (...a) => { if (DK_DEBUG) console.log(_tag, ...a); };
const dkwarn = (...a) => console.warn(_tag, ...a);
const dkerr  = (...a) => console.error(_tag, ...a);

// Import ZIP utility
importScripts('zip-utils.js');

// Extension installed/updated
chrome.runtime.onInstalled.addListener(() => {
  dklog('extension installed/updated — ready to extract content from web readers');
});

// Conversion state management
const activeConversions = new Map();

// Log when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  dklog('icon clicked on tab', tab.id, ':', tab.url);

  // Inject the viewer overlay into the current tab
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['viewer-inject.js'],
    world: 'MAIN'
  }).then(() => {
    dklog('viewer overlay injected into tab', tab.id);
  }).catch(error => {
    dkerr('failed to inject viewer overlay (is this a Kindle Cloud Reader tab?):', error);
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dklog('message received:', message.action, '| from tab', sender.tab?.id);
  if (message.action === 'blobCaptured') {
    dklog(`content captured from ${sender.tab?.url || 'unknown'}`);
    sendResponse({ received: true });
  } else if (message.action === 'initEpubConversion') {
    handleInitEpubConversion(message, sender, sendResponse);
    return true; // Keep sendResponse callback alive for async operation
  } else if (message.action === 'sendPagesChunk') {
    handleSendPagesChunk(message, sender, sendResponse);
    return true; // Keep sendResponse callback alive for async operation
  } else if (message.action === 'startEpubProcessing') {
    handleStartEpubProcessing(message, sender, sendResponse);
    return true; // Keep sendResponse callback alive for async operation
  } else {
    dkwarn('unhandled message action:', message.action);
  }
  return false;
});

// Handle initialization of EPUB conversion
async function handleInitEpubConversion(message, sender, sendResponse) {
  try {
    const conversionId = generateUUID();
    
    // Initialize conversion state
    activeConversions.set(conversionId, {
      id: conversionId,
      tabId: sender.tab.id,
      bookTitle: message.bookTitle,
      bookAuthor: message.bookAuthor,
      totalPages: message.totalPages,
      totalChunks: message.totalChunks,
      receivedChunks: 0,
      pages: [],
      status: 'initialized',
      timestamp: Date.now()
    });
    
    console.log(`[DeKindled] Initialized conversion ${conversionId} for "${message.bookTitle}" with ${message.totalPages} pages in ${message.totalChunks} chunks`);
    
    sendResponse({ 
      success: true, 
      conversionId: conversionId,
      message: 'Conversion initialized successfully'
    });
  } catch (error) {
    console.error('[DeKindled] Error initializing conversion:', error);
    sendResponse({ 
      success: false, 
      error: error.message 
    });
  }
}

// Handle receiving pages chunks
async function handleSendPagesChunk(message, sender, sendResponse) {
  try {
    const { conversionId, chunkIndex, totalChunks, pages } = message;
    
    const conversion = activeConversions.get(conversionId);
    if (!conversion) {
      throw new Error(`Conversion ${conversionId} not found`);
    }
    
    if (conversion.tabId !== sender.tab.id) {
      throw new Error(`Conversion ${conversionId} belongs to different tab`);
    }
    
    // Add pages from this chunk
    conversion.pages.push(...pages);
    conversion.receivedChunks++;
    
    console.log(`[DeKindled] Received chunk ${chunkIndex + 1}/${totalChunks} for conversion ${conversionId} (${pages.length} pages, ${conversion.pages.length} total)`);
    
    // Validate chunk completion
    if (conversion.receivedChunks === conversion.totalChunks) {
      if (conversion.pages.length !== conversion.totalPages) {
        console.warn(`[DeKindled] Page count mismatch for conversion ${conversionId}: expected ${conversion.totalPages}, got ${conversion.pages.length}`);
      } else {
        console.log(`[DeKindled] All chunks received for conversion ${conversionId}, ready for processing`);
      }
      conversion.status = 'chunks_complete';
    }
    
    sendResponse({ 
      success: true,
      receivedChunks: conversion.receivedChunks,
      totalChunks: conversion.totalChunks,
      message: `Chunk ${chunkIndex + 1}/${totalChunks} received successfully`
    });
  } catch (error) {
    console.error('[DeKindled] Error receiving chunk:', error);
    sendResponse({ 
      success: false, 
      error: error.message 
    });
  }
}

// Handle starting EPUB processing
async function handleStartEpubProcessing(message, sender, sendResponse) {
  try {
    const { conversionId } = message;
    
    const conversion = activeConversions.get(conversionId);
    if (!conversion) {
      throw new Error(`Conversion ${conversionId} not found`);
    }
    
    if (conversion.tabId !== sender.tab.id) {
      throw new Error(`Conversion ${conversionId} belongs to different tab`);
    }
    
    if (conversion.status !== 'chunks_complete') {
      throw new Error(`Conversion ${conversionId} is not ready for processing (status: ${conversion.status})`);
    }
    
    conversion.status = 'processing';
    
    console.log(`[DeKindled] Starting processing for conversion ${conversionId} with ${conversion.pages.length} pages`);
    
    // Send immediate acknowledgment
    sendResponse({ 
      success: true, 
      message: 'Processing started successfully' 
    });
    
    // Start the actual image download asynchronously
    processImageDownload(conversion);
    
  } catch (error) {
    console.error('[DeKindled] Error starting processing:', error);
    sendResponse({ 
      success: false, 
      error: error.message 
    });
  }
}

// Process image download (async, doesn't use sendResponse)
// Bundles all captured page images into a single ZIP and downloads it.
async function processImageDownload(conversion) {
  try {
    const pages = conversion.pages;
    dklog(`bundling ${pages.length} captured images into a ZIP (conversion ${conversion.id})`);

    if (!pages.length) {
      throw new Error('No pages were received to download');
    }

    const zip = new SimpleZip();

    // Folder inside the ZIP named after the book, so images stay grouped
    const folderName = sanitizeFilename(conversion.bookTitle) || 'DeKindled_Images';
    const padWidth = String(pages.length).length;
    let totalBytes = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];

      // Report progress to the viewer overlay
      chrome.tabs.sendMessage(conversion.tabId, {
        action: 'conversionProgress',
        current: i + 1,
        total: pages.length
      }).catch(error => {
        dkwarn('failed to send progress update:', error);
      });

      if (!page.base64) {
        dkwarn(`page ${i + 1} has no base64 data — skipping (type=${page.type}, size=${page.size})`);
        continue;
      }

      let bytes;
      try {
        bytes = dataUrlToUint8Array(page.base64);
      } catch (decodeErr) {
        dkerr(`page ${i + 1} base64 decode failed — skipping:`, decodeErr);
        continue;
      }
      const ext = extensionForType(page.type);
      const pageNumber = String(i + 1).padStart(padWidth, '0');
      // Stamp each entry with when its page was captured (blob-creation time),
      // so extracted files sort by capture order instead of the 1979 default.
      const mtime = page.timestamp ? new Date(page.timestamp) : undefined;
      zip.file(`${folderName}/page-${pageNumber}.${ext}`, bytes, mtime);
      totalBytes += bytes.length;
      dklog(`added page ${i + 1}/${pages.length} -> page-${pageNumber}.${ext} (${bytes.length} bytes, mime=${page.type})`);
    }

    // Generate the ZIP blob
    dklog(`generating ZIP (${totalBytes} bytes of image data)...`);
    const zipBlob = await zip.generateAsync({ mimeType: 'application/zip' });
    dklog(`ZIP generated: ${zipBlob.size} bytes`);

    // Convert blob to data URL for download (URL.createObjectURL not available in service workers)
    const arrayBuffer = await zipBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const base64String = uint8ArrayToBase64(uint8Array);
    const dataUrl = `data:application/zip;base64,${base64String}`;

    const filename = `${folderName}.zip`;

    dklog(`starting download: ${filename}`);
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      conflictAction: 'uniquify'
    });
    dklog(`chrome.downloads.download returned id:`, downloadId);

    // Send completion notification
    chrome.tabs.sendMessage(conversion.tabId, {
      action: 'conversionComplete',
      success: true,
      filename: filename
    }).catch(err => dkwarn('failed to send completion message:', err));

    // Clean up conversion state
    activeConversions.delete(conversion.id);
    dklog(`image download ${conversion.id} completed successfully (${pages.length} images)`);

  } catch (error) {
    dkerr('image download error:', error);

    // Send error notification
    chrome.tabs.sendMessage(conversion.tabId, {
      action: 'conversionComplete',
      success: false,
      error: error.message
    }).catch(err => dkwarn('failed to send error message:', err));

    // Clean up conversion state
    activeConversions.delete(conversion.id);
  }
}

// Decode a base64 data URL (e.g. "data:image/jpeg;base64,....") into raw bytes
function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Map a MIME type to a sensible file extension
function extensionForType(type) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
  };
  if (type && map[type.toLowerCase()]) {
    return map[type.toLowerCase()];
  }
  // Fallback: derive from the "image/xxx" subtype, else default to png
  if (type && type.indexOf('/') !== -1) {
    return type.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
  }
  return 'png';
}

// Utility functions
function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9\-_\s]/gi, '').replace(/\s+/g, '_').substring(0, 100);
}


function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}



// Convert uint8Array to base64 using chunked approach to avoid stack overflow
function uint8ArrayToBase64(uint8Array) {
  console.log(`[DeKindled] Converting ${uint8Array.length} bytes to base64 using chunked approach`);
  
  let binaryString = '';
  const chunkSize = 16384; // 16KB chunks - better browser compatibility
  
  try {
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, i + chunkSize);
      binaryString += String.fromCharCode.apply(null, chunk);
    }
    
    console.log(`[DeKindled] Successfully converted to binary string, applying base64 encoding`);
    return btoa(binaryString);
    
  } catch (error) {
    console.error('[DeKindled] Error in chunked base64 conversion:', error);
    throw new Error(`Base64 conversion failed: ${error.message}`);
  }
}

