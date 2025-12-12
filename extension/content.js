// Store tracked iframe URLs and elements
const trackedIframeUrls = new Set();
const trackedIframeElements = new Map(); // Map of iframe element -> {url, iframeId, dataId}

// Scrolling configuration
let scrollingEnabled = false;
let scrollInterval = null;
const SCROLL_CONFIG = {
  minIntervalMs: 5000,    // Minimum time between scrolls (5 seconds)
  maxIntervalMs: 15000,   // Maximum time between scrolls (15 seconds)
  minScrollAmount: 100,   // Minimum pixels to scroll
  maxScrollAmount: 500,   // Maximum pixels to scroll
  directionChangeProbability: 0.5  // 50% chance to change direction
};

let currentScrollDirection = 1; // 1 for down, -1 for up

// only scroll if no mouse activity on the page
let lastMouseActivity = Date.now();

// Function to get random value between min and max
function getRandomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Function to perform random scroll
function performRandomScroll() {
  if (!scrollingEnabled) return;

  if (lastMouseActivity && (Date.now() - lastMouseActivity < SCROLL_CONFIG.minIntervalMs)) {
    scheduleNextScroll();
    return;
  }

  // Randomly decide to change direction
  if (Math.random() < SCROLL_CONFIG.directionChangeProbability) {
    currentScrollDirection *= -1;
  }

  // Calculate scroll amount
  const scrollAmount = getRandomBetween(
    SCROLL_CONFIG.minScrollAmount, 
    SCROLL_CONFIG.maxScrollAmount
  ) * currentScrollDirection;

  // Check if we're at the boundaries and adjust direction if needed
  const currentScrollY = window.scrollY;
  const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;

  if (currentScrollY <= 0 && scrollAmount < 0) {
    currentScrollDirection = 1;
  } else if (currentScrollY >= maxScrollY && scrollAmount > 0) {
    currentScrollDirection = -1;
  }

  // Recalculate with possibly adjusted direction
  const finalScrollAmount = Math.abs(scrollAmount) * currentScrollDirection;

  console.log('[IFrame Monitor] Performing random scroll');
  console.log('  Direction:', currentScrollDirection > 0 ? 'DOWN' : 'UP');
  console.log('  Amount:', Math.abs(finalScrollAmount), 'pixels');
  console.log('  Current position:', currentScrollY);
  console.log('  Max scroll position:', maxScrollY);

  // Perform the scroll
  window.scrollBy({
    top: finalScrollAmount,
    behavior: 'smooth'
  });

  scheduleNextScroll();
}

// Function to schedule the next scroll
function scheduleNextScroll() {
  if (scrollInterval) {
    clearTimeout(scrollInterval);
  }

  if (scrollingEnabled) {
    const nextScrollDelay = getRandomBetween(
      SCROLL_CONFIG.minIntervalMs,
      SCROLL_CONFIG.maxIntervalMs
    );

    console.log('[IFrame Monitor] Next scroll scheduled in', (nextScrollDelay / 1000).toFixed(1), 'seconds');
    scrollInterval = setTimeout(performRandomScroll, nextScrollDelay);
  }
}

// Function to start random scrolling
function startRandomScrolling() {
  if (!scrollingEnabled) {
    scrollingEnabled = true;
    console.log('[IFrame Monitor] Random scrolling ENABLED');
    console.log('  Interval range:', SCROLL_CONFIG.minIntervalMs / 1000, '-', SCROLL_CONFIG.maxIntervalMs / 1000, 'seconds');
    console.log('  Scroll range:', SCROLL_CONFIG.minScrollAmount, '-', SCROLL_CONFIG.maxScrollAmount, 'pixels');
    scheduleNextScroll();
  }
}

// Function to stop random scrolling
function stopRandomScrolling() {
  if (scrollingEnabled) {
    scrollingEnabled = false;
    if (scrollInterval) {
      clearTimeout(scrollInterval);
      scrollInterval = null;
    }
    console.log('[IFrame Monitor] Random scrolling DISABLED');
  }
}

// Function to check if iframe should be tracked
function shouldTrackIframe(iframe) {
  const dataId = iframe.getAttribute('data-id');
  const id = iframe.getAttribute('id');
  
  // Check if either id or data-id contains 'mllwtl'
  return (dataId && dataId.includes('mllwtl')) || (id && id.includes('mllwtl'));
}

// Function to check and log iframe URLs
function checkIframe(iframe) {
  if (shouldTrackIframe(iframe)) {
    const targetUrl = iframe.getAttribute('src');
    const dataId = iframe.getAttribute('data-id');
    const id = iframe.getAttribute('id');

    console.log('[IFrame Monitor] Detected iframe with "mllwtl" identifier');
    console.log('  ID:', id || 'none');
    console.log('  Data-ID:', dataId || 'none');
    console.log('  Target URL:', targetUrl);
    console.log('  Full element:', iframe);

    // Track this URL for network interception
    if (targetUrl && !trackedIframeUrls.has(targetUrl)) {
      trackedIframeUrls.add(targetUrl);

      // Store iframe element reference for removal detection
      trackedIframeElements.set(iframe, {
        url: targetUrl,
        iframeId: id,
        dataId: dataId
      });

      // Send message to background script to start monitoring this URL
      chrome.runtime.sendMessage({
        type: 'TRACK_IFRAME_URL',
        url: targetUrl,
        frameId: id || dataId || 'unknown',
        iframeId: id,
        dataId: dataId
      });
    }
  }
}

// Listen for network data from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle scrolling commands
  if (message.type === 'TOGGLE_SCROLLING') {
    if (message.enabled) {
      startRandomScrolling();
    } else {
      stopRandomScrolling();
    }
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'UPDATE_SCROLL_CONFIG') {
    if (message.config) {
      Object.assign(SCROLL_CONFIG, message.config);
      console.log('[IFrame Monitor] Scroll configuration updated:', SCROLL_CONFIG);
    }
    sendResponse({ success: true });
    return true;
  }
  
  // Existing network data handling
  if (message.type === 'NETWORK_DATA') {
    console.log('[IFrame Monitor] Network Request Intercepted:');
    console.log('  URL:', message.url);
    console.log('  Method:', message.method);
    console.log('  Request Headers:', message.requestHeaders);
    
    if (message.requestBody) {
      console.log('  Request Body:', message.requestBody);
      
      if (message.requestBody.formData) {
        console.log('  Form Data (parsed):');
        for (const [key, value] of Object.entries(message.requestBody.formData)) {
          console.log(`    ${key}:`, value);
        }
      }
      
      if (message.requestBody.raw) {
        console.log('  Raw Request Data:', message.requestBody.raw);
      }
    }
    
    console.log('  Response Headers:', message.responseHeaders);
    console.log('  Status:', message.statusCode);
    console.log('  Remote Address:', message.remoteAddress);
    console.log('---');
  }
  
  if (message.type === 'NETWORK_ERROR') {
    console.log('[IFrame Monitor] Network Error:');
    console.log('  URL:', message.url);
    console.log('  Error:', message.error);
    console.log('---');
  }
});


// Check existing iframes on page load
function checkExistingIframes() {
  // Find all iframes
  const allIframes = document.querySelectorAll('iframe');
  allIframes.forEach(iframe => {
    if (shouldTrackIframe(iframe)) {
      checkIframe(iframe);
    }
  });
}

// Function to handle iframe removal
function handleIframeRemoval(iframe) {
  const iframeData = trackedIframeElements.get(iframe);
  if (iframeData) {
    console.log('[IFrame Monitor] Iframe removed from DOM');
    console.log('  URL:', iframeData.url);
    console.log('  ID:', iframeData.iframeId || 'none');
    console.log('  Data-ID:', iframeData.dataId || 'none');

    // Notify background script that iframe was removed
    chrome.runtime.sendMessage({
      type: 'IFRAME_REMOVED',
      url: iframeData.url,
      iframeId: iframeData.iframeId,
      dataId: iframeData.dataId
    });

    // Clean up local tracking
    trackedIframeElements.delete(iframe);
    trackedIframeUrls.delete(iframeData.url);
  }
}

// Set up MutationObserver to watch for new iframes and removed iframes
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    // Check added nodes
    mutation.addedNodes.forEach((node) => {
      // Check if the added node is an iframe with mllwtl identifier
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'IFRAME' && shouldTrackIframe(node)) {
          checkIframe(node);
        }

        // Also check if any child nodes are iframes with mllwtl identifier
        const childIframes = node.querySelectorAll ? node.querySelectorAll('iframe') : [];
        childIframes.forEach(iframe => {
          if (shouldTrackIframe(iframe)) {
            checkIframe(iframe);
          }
        });
      }
    });

    // Check removed nodes for tracked iframes
    mutation.removedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // Check if the removed node is a tracked iframe
        if (node.tagName === 'IFRAME' && trackedIframeElements.has(node)) {
          handleIframeRemoval(node);
        }

        // Also check if any child nodes are tracked iframes
        const childIframes = node.querySelectorAll ? node.querySelectorAll('iframe') : [];
        childIframes.forEach(iframe => {
          if (trackedIframeElements.has(iframe)) {
            handleIframeRemoval(iframe);
          }
        });
      }
    });

    // Check for attribute changes on existing iframes
    if (mutation.type === 'attributes' && mutation.target.tagName === 'IFRAME') {
      const iframe = mutation.target;
      if (shouldTrackIframe(iframe)) {
        checkIframe(iframe);
      }
    }
  });
});

// Start observing
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-id', 'id', 'src']
});

// Check for existing iframes when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkExistingIframes);
} else {
  checkExistingIframes();
}

console.log('[IFrame Monitor] Extension loaded and monitoring for iframes...');


// Load scrolling state from storage when page loads
chrome.storage.local.get(['scrollingEnabled', 'scrollConfig'], (result) => {
  if (result.scrollingEnabled) {
    scrollingEnabled = true;
    console.log('[IFrame Monitor] Restoring scrolling state: ENABLED');
    
    // Load custom config if available
    if (result.scrollConfig) {
      Object.assign(SCROLL_CONFIG, result.scrollConfig);
      console.log('[IFrame Monitor] Loaded scroll config:', SCROLL_CONFIG);
    }
    
    // Start scrolling
    scheduleNextScroll();
  }
});

// mouse activity listener to reset lastMouseActivity
window.addEventListener('mousemove', () => {
  lastMouseActivity = Date.now();
});