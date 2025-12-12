// Load saved user ID when popup opens
document.addEventListener('DOMContentLoaded', async () => {
  const result = await chrome.storage.local.get(['userId']);
  if (result.userId) {
    document.getElementById('userId').value = result.userId;
  }
});

// Save user ID when button is clicked
document.getElementById('saveBtn').addEventListener('click', async () => {
  const userId = document.getElementById('userId').value.trim();
  
  if (!userId) {
    alert('Please enter a user ID');
    return;
  }
  
  // Save to chrome storage
  await chrome.storage.local.set({ userId: userId });
  
  // Show success message
  const status = document.getElementById('status');
  status.textContent = 'User ID saved successfully!';
  status.className = 'status success';
  
  setTimeout(() => {
    status.style.display = 'none';
  }, 2000);
});

// Track scrolling state
let scrollingEnabled = false;

// Load scroll configuration
chrome.storage.local.get(['scrollConfig', 'scrollingEnabled'], (result) => {
  if (result.scrollConfig) {
    document.getElementById('minInterval').value = result.scrollConfig.minIntervalMs / 1000;
    document.getElementById('maxInterval').value = result.scrollConfig.maxIntervalMs / 1000;
    document.getElementById('minScroll').value = result.scrollConfig.minScrollAmount;
    document.getElementById('maxScroll').value = result.scrollConfig.maxScrollAmount;
  }
  
  if (result.scrollingEnabled) {
    scrollingEnabled = true;
    updateToggleButton();
  }
});

// Save scroll configuration
document.getElementById('saveScrollConfig').addEventListener('click', () => {
  const config = {
    minIntervalMs: parseInt(document.getElementById('minInterval').value) * 1000,
    maxIntervalMs: parseInt(document.getElementById('maxInterval').value) * 1000,
    minScrollAmount: parseInt(document.getElementById('minScroll').value),
    maxScrollAmount: parseInt(document.getElementById('maxScroll').value)
  };

  if (config.minIntervalMs > config.maxIntervalMs) {
    showScrollStatus('Min interval must be less than max!', false);
    return;
  }
  
  if (config.minScrollAmount > config.maxScrollAmount) {
    showScrollStatus('Min scroll must be less than max!', false);
    return;
  }

  chrome.storage.local.set({ scrollConfig: config }, () => {
    showScrollStatus('Scroll config saved!', true);
    
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'UPDATE_SCROLL_CONFIG',
          config: config
        }).catch(() => {});
      });
    });
  });
});

// Toggle scrolling
document.getElementById('toggleScroll').addEventListener('click', () => {
  scrollingEnabled = !scrollingEnabled;
  chrome.storage.local.set({ scrollingEnabled: scrollingEnabled });
  
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_SCROLLING',
        enabled: scrollingEnabled
      }).catch(() => {});
    });
  });
  
  updateToggleButton();
  showScrollStatus(scrollingEnabled ? 'Scrolling enabled!' : 'Scrolling disabled!', true);
});

function updateToggleButton() {
  const button = document.getElementById('toggleScroll');
  if (scrollingEnabled) {
    button.textContent = 'Disable Scrolling';
    button.classList.add('active');
  } else {
    button.textContent = 'Enable Scrolling';
    button.classList.remove('active');
  }
}

function showScrollStatus(message, isSuccess) {
  const statusDiv = document.getElementById('scrollStatus');
  statusDiv.textContent = message;
  statusDiv.className = 'status ' + (isSuccess ? 'success' : '');
  statusDiv.style.display = 'block';
  
  setTimeout(() => {
    statusDiv.style.display = 'none';
  }, 2000);
}