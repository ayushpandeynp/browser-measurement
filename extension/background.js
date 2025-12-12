// Store tracked iframe URLs
const trackedUrls = new Map(); // Map of URL -> {frameId, tabId}
const trackedDomains = new Set(); // Set of domains to monitor
// Store request data temporarily to correlate with responses
const requestDataCache = new Map(); // Map of requestId -> {requestHeaders, method, etc}
// Store aggregated data per iframe - will be sent when iframe is removed
const aggregatedData = new Map(); // Map of iframeKey -> Array of request data objects

// Always monitor this specific domain
const ALWAYS_MONITOR_DOMAINS = ['request.mellow.tel'];

// Server configuration for data collection
const CACHE_URL = 'http://127.0.0.1:9080/cache';
const ENABLE_SERVER_UPLOAD = true; // Set to false to disable server uploads

// // Generate a unique session ID for this browser session
// const SESSION_ID = generateSessionId();

// function generateSessionId() {
//   const timestamp = Date.now();
//   const random = Math.random().toString(36).substring(2, 15);
//   return `${timestamp}-${random}`;
// }

// User ID will be loaded from storage
let USER_ID = null;

// Load user ID from storage on startup
async function loadUserId() {
  const result = await chrome.storage.local.get(['userId']);
  USER_ID = result.userId || 'anonymous';
  console.log('[Background] Loaded User ID:', USER_ID);
}

// Initialize on startup
loadUserId();

// Listen for changes to user ID
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.userId) {
    USER_ID = changes.userId.newValue;
    console.log('[Background] User ID updated to:', USER_ID);
  }
});


// Function to send data to remote server
async function sendToServer(data) {
  if (!ENABLE_SERVER_UPLOAD) {
    return;
  }

  const body = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json' };
  fetch(CACHE_URL, {
    method: 'POST',
    headers: headers,
    body: body
  }).then(response => response.json()).then(data => {
    console.log('[Background] Data cached locally:', data);
  }).catch(err => {
    console.log('[Background] Failed to cache data locally:', err.message);
  });
}

// Helper function to generate a unique key for each iframe
function getIframeKey(iframeUrl, iframeId) {
  return `${iframeUrl}_${iframeId || 'unknown'}`;
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRACK_IFRAME_URL') {
    const url = message.url;
    const tabId = sender.tab?.id;

    console.log('[Background] Tracking iframe URL:', url);

    // Extract and store the domain
    try {
      const domain = new URL(url).hostname;
      trackedDomains.add(domain);
      console.log('[Background] Now monitoring domain:', domain);
    } catch (e) {
      console.log('[Background] Could not parse URL:', url);
    }

    // Store the URL and associated tab with iframe details
    if (!trackedUrls.has(url)) {
      trackedUrls.set(url, {
        frameId: message.frameId,
        iframeId: message.iframeId,
        dataId: message.dataId,
        tabId: tabId
      });
    }

    // Initialize aggregated data storage for this iframe
    const iframeKey = getIframeKey(url, message.iframeId);
    if (!aggregatedData.has(iframeKey)) {
      aggregatedData.set(iframeKey, []);
      console.log('[Background] Initialized aggregation for iframe:', iframeKey);
    }
  }

  if (message.type === 'IFRAME_REMOVED') {
    const iframeKey = getIframeKey(message.url, message.iframeId);
    console.log('[Background] Iframe removed, sending aggregated data for:', iframeKey);

    // Get all aggregated requests for this iframe
    const requests = aggregatedData.get(iframeKey);

    if (requests && requests.length > 0) {
      const aggregatedPayload = {
        user_id: USER_ID,
        session_id: USER_ID,
        timestamp: Date.now(),
        iframe_id: message.iframeId,
        iframe_url: message.url,
        request_count: requests.length,
        requests: requests,
        user_agent: navigator.userAgent
      };

      console.log(`[Background] Sending ${requests.length} aggregated requests for iframe:`, iframeKey);
      sendToServer(aggregatedPayload);

      // Clean up aggregated data for this iframe
      aggregatedData.delete(iframeKey);
    } else {
      console.log('[Background] No requests to send for iframe:', iframeKey);
    }

    // Clean up tracked URL and domain
    trackedUrls.delete(message.url);

    // Only remove domain if no other iframes are using it
    try {
      const domain = new URL(message.url).hostname;
      let domainStillInUse = false;
      for (const [url] of trackedUrls) {
        try {
          if (new URL(url).hostname === domain) {
            domainStillInUse = true;
            break;
          }
        } catch (e) {}
      }
      if (!domainStillInUse) {
        trackedDomains.delete(domain);
        console.log('[Background] Stopped monitoring domain:', domain);
      }
    } catch (e) {}
  }
});

// Helper function to check if a URL should be monitored
function shouldMonitorUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Check if it matches any always-monitor domains
    for (const domain of ALWAYS_MONITOR_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    
    // Check if it matches any tracked iframe domains
    for (const domain of trackedDomains) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

// Intercept requests BEFORE they are sent - capture request body for POST
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    
    // Only monitor if URL matches tracked domains or always-monitor domains
    if (!shouldMonitorUrl(url)) {
      return;
    }
    
    console.log('[Background] Request Body/Form Data for tracked iframe:');
    console.log('  URL:', url);
    console.log('  Method:', details.method);
    console.log('  Type:', details.type);
    
    // Capture POST data
    if (details.requestBody) {
      console.log('  Request Body:', details.requestBody);
      
      // Parse form data if available
      if (details.requestBody.formData) {
        console.log('  Form Data (parsed):', details.requestBody.formData);
      }
      
      // Parse raw data if available
      if (details.requestBody.raw) {
        console.log('  Raw Data:', details.requestBody.raw);
        // Try to decode raw data
        details.requestBody.raw.forEach((item, index) => {
          if (item.bytes) {
            try {
              const decoder = new TextDecoder('utf-8');
              const decoded = decoder.decode(item.bytes);
              console.log(`  Raw Data [${index}] Decoded:`, decoded);
            } catch (e) {
              console.log(`  Raw Data [${index}] (binary):`, item.bytes);
            }
          }
        });
      }
    }
    
    // Store request body data
    if (!requestDataCache.has(details.requestId)) {
      requestDataCache.set(details.requestId, {});
    }
    const cache = requestDataCache.get(details.requestId);
    cache.requestBody = details.requestBody;
    cache.method = details.method;
    cache.type = details.type;
    cache.tabId = details.tabId;
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// Intercept requests BEFORE they are sent - capture headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const url = details.url;
    
    // Only monitor if URL matches tracked domains or always-monitor domains
    if (!shouldMonitorUrl(url)) {
      return;
    }
    
    console.log('[Background] Request Headers for tracked iframe:');
    console.log('  URL:', url);
    console.log('  Method:', details.method);
    console.log('  Type:', details.type);
    console.log('  Request Headers:', details.requestHeaders);
    
    // Update or create cache entry
    if (!requestDataCache.has(details.requestId)) {
      requestDataCache.set(details.requestId, {});
    }
    const cache = requestDataCache.get(details.requestId);
    cache.requestHeaders = details.requestHeaders;
    cache.method = details.method;
    cache.type = details.type;
    cache.tabId = details.tabId;
    cache.url = url;

    // Find which iframe this request belongs to
    cache.iframeInfo = findIframeForUrl(url);

    return { requestHeaders: details.requestHeaders };
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// Helper function to find which iframe a request belongs to
function findIframeForUrl(requestUrl) {
  try {
    const requestDomain = new URL(requestUrl).hostname;

    // Check if this domain matches any tracked iframe
    for (const [iframeUrl, iframeData] of trackedUrls.entries()) {
      try {
        const iframeDomain = new URL(iframeUrl).hostname;
        if (requestDomain === iframeDomain || requestDomain.endsWith('.' + iframeDomain)) {
          return {
            iframeUrl: iframeUrl,
            iframeId: iframeData.iframeId,
            dataId: iframeData.dataId,
            frameId: iframeData.frameId
          };
        }
      } catch (e) {
        // Skip invalid URLs
      }
    }

    // Check if it's to the always-monitored domain
    for (const domain of ALWAYS_MONITOR_DOMAINS) {
      if (requestDomain === domain || requestDomain.endsWith('.' + domain)) {
        return {
          iframeUrl: domain,
          iframeId: 'always-monitored',
          dataId: domain,
          frameId: 'always-monitored'
        };
      }
    }
  } catch (e) {
    // Invalid URL
  }

  return null;
}

// Intercept response headers
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const url = details.url;
    
    // Only monitor if URL matches tracked domains or always-monitor domains
    if (!shouldMonitorUrl(url)) {
      return;
    }
    
    // Get cached request data
    const requestData = requestDataCache.get(details.requestId);
    
    console.log('[Background] Response Headers for tracked iframe:');
    console.log('  URL:', url);
    console.log('  Status:', details.statusCode, details.statusLine);
    console.log('  Response Headers:', details.responseHeaders);
    
    // Send data back to content script for consolidated logging
    const tabId = requestData?.tabId || details.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'NETWORK_DATA',
        url: url,
        method: requestData?.method || 'UNKNOWN',
        requestHeaders: requestData?.requestHeaders || [],
        requestBody: requestData?.requestBody || null,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        responseHeaders: details.responseHeaders,
        remoteAddress: details.ip
      }).catch(err => {
        // Tab might be closed, ignore error
        console.log('[Background] Could not send message to tab:', err.message);
      });
    }

    // Aggregate data instead of sending immediately
    if (requestData && requestData.iframeInfo) {
      const iframeKey = getIframeKey(requestData.iframeInfo.iframeUrl, requestData.iframeInfo.iframeId);

      const requestDataObj = {
        timestamp: Date.now(),
        request_url: url,
        request_method: requestData.method || 'UNKNOWN',
        request_type: requestData.type || null,
        request_headers: requestData.requestHeaders || [],
        request_body: requestData.requestBody || null,
        response_headers: details.responseHeaders || [],
        status_code: details.statusCode,
        status_line: details.statusLine,
        remote_address: details.ip,
        error_message: null
      };

      // Add to aggregated data
      if (!aggregatedData.has(iframeKey)) {
        aggregatedData.set(iframeKey, []);
      }
      aggregatedData.get(iframeKey).push(requestDataObj);

      console.log(`[Background] Aggregated request for ${iframeKey} (total: ${aggregatedData.get(iframeKey).length})`);
    }

    // Clean up cache after processing
    requestDataCache.delete(details.requestId);
    
    return { responseHeaders: details.responseHeaders };
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

// Intercept completed requests (includes all data)
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    
    // Only monitor if URL matches tracked domains or always-monitor domains
    if (!shouldMonitorUrl(url)) {
      return;
    }
    
    console.log('[Background] Request Completed for tracked iframe:');
    console.log('  URL:', url);
    console.log('  Status:', details.statusCode);
    console.log('  From Cache:', details.fromCache);
    console.log('  IP:', details.ip);
  },
  { urls: ["<all_urls>"] }
);

// Intercept errors
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const url = details.url;

    // Only monitor if URL matches tracked domains or always-monitor domains
    if (!shouldMonitorUrl(url)) {
      return;
    }

    console.log('[Background] Request Error for tracked iframe:');
    console.log('  URL:', url);
    console.log('  Error:', details.error);

    const tabId = details.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'NETWORK_ERROR',
        url: url,
        error: details.error
      }).catch(err => {
        console.log('[Background] Could not send error message to tab:', err.message);
      });
    }

    // Get cached request data if available
    const requestData = requestDataCache.get(details.requestId);

    // Aggregate error data instead of sending immediately
    const iframeInfo = requestData?.iframeInfo || findIframeForUrl(url);
    if (iframeInfo) {
      const iframeKey = getIframeKey(iframeInfo.iframeUrl, iframeInfo.iframeId);

      const errorDataObj = {
        timestamp: Date.now(),
        request_url: url,
        request_method: requestData?.method || 'UNKNOWN',
        request_type: requestData?.type || null,
        request_headers: requestData?.requestHeaders || [],
        request_body: requestData?.requestBody || null,
        response_headers: [],
        status_code: null,
        status_line: null,
        remote_address: null,
        error_message: details.error
      };

      // Add to aggregated data
      if (!aggregatedData.has(iframeKey)) {
        aggregatedData.set(iframeKey, []);
      }
      aggregatedData.get(iframeKey).push(errorDataObj);

      console.log(`[Background] Aggregated error for ${iframeKey} (total: ${aggregatedData.get(iframeKey).length})`);
    }

    // Clean up cache
    if (requestData) {
      requestDataCache.delete(details.requestId);
    }
  },
  { urls: ["<all_urls>"] }
);

console.log('[Background] Service worker started - ready to intercept iframe requests');
