const { exec, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper function to format log messages with timestamp
function log(message) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  console.log(`[${timestamp}] ${message}`);
}

// Configuration
const USER_ID = process.argv[2]; // Get USER_ID from command line argument
const RESTART_HOUR = parseInt(process.argv[3]) || 2; // Hour to restart Chrome (default: 2am)
const SERVER_PORT = parseInt(process.argv[4]) || 9080; // Port for local web server
const REMOTE_PORTS = [9085, 9086, 9087]; // remote server ports
const UPLOAD_URL = (port) => `https://mobile.batterylab.dev:${port}/uploadCache`;
const QUERY_URL = (port) => `https://mobile.batterylab.dev:${port}/mellowquery`;
const UPLOAD_INTERVAL = 7 * 60 * 1000; // 7 minutes
const CHECK_INTERVAL = 60 * 1000;      // 1 minute
const QUERY_INTERVAL = 10 * 60 * 1000; // 10 minutes
const TIME_THRESHOLD = 10 * 60 * 1000; // 10 minutes 
const CACHE_DIR = path.join(__dirname, 'cache_data');
const SPEEDTEST_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// List of webpages to navigate to
const WEBPAGES = [
  'https://example.com/',
  'https://www.youtube.com',
  'https://www.wikipedia.org',
  'https://www.github.com'
];

let lastRestartDate = null; // Track last restart to ensure it happens once per day
let chromeOperationInProgress = false; // Lock to prevent concurrent Chrome operations
let restartJustHappened = false; // Flag to skip status check right after restart

// JSON versioning state
let currentJsonVersion = 1;
let uploadInProgress = false;
let versionBeingUploaded = null;

//public IP
let lastPublicIP = null;
let lastSpeedtestTime = 0;

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  log(`Created cache directory: ${CACHE_DIR}`);
}

// create a windows-service.bat file on this folder
const windowsServiceBatContent = `@echo off
pm2 start monitor.js -- ${USER_ID} ${RESTART_HOUR}`;
const windowsServiceBatPath = path.join(__dirname, 'windows-service.bat');
if (!fs.existsSync(windowsServiceBatPath)) {
  fs.writeFileSync(windowsServiceBatPath, windowsServiceBatContent);
  log(`Created Windows service batch file: ${windowsServiceBatPath}`);
}

// Function to list installed Chrome extensions
function listChromeExtensions() {
  log('=== LISTING CHROME EXTENSIONS ===');
  
  const platform = os.platform();
  let extensionsPath;
  
  if (platform === 'win32') {
    extensionsPath = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
  } else if (platform === 'darwin') {
    extensionsPath = path.join(process.env.HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions');
  } else {
    extensionsPath = path.join(process.env.HOME, '.config', 'google-chrome', 'Default', 'Extensions');
  }
  
  if (!fs.existsSync(extensionsPath)) {
    log('Extensions directory not found');
    return [];
  }
  
  try {
    const extensions = [];
    const extensionDirs = fs.readdirSync(extensionsPath);
    
    for (const extId of extensionDirs) {
      const extPath = path.join(extensionsPath, extId);
      const stat = fs.statSync(extPath);
      
      if (!stat.isDirectory()) continue;
      
      // Get version directories
      const versions = fs.readdirSync(extPath);
      if (versions.length === 0) continue;
      
      // Get the latest version (last in sorted order)
      const latestVersion = versions.sort().pop();
      const manifestPath = path.join(extPath, latestVersion, 'manifest.json');
      
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          extensions.push({
            id: extId,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description || '',
            permissions: manifest.permissions || []
          });
          log(`Found: ${manifest.name} (v${manifest.version}) - ID: ${extId}`);
        } catch (err) {
          log(`Error reading manifest for ${extId}: ${err.message}`);
        }
      }
    }
    
    log(`Total extensions found: ${extensions.length}`);
    log('=== EXTENSIONS LIST COMPLETED ===');
    
    // Optionally write to JSON
    const extensionsData = {
      timestamp: Date.now(),
      type: 'extensions',
      count: extensions.length,
      extensions: extensions
    };
    writeToJSON(extensionsData);
    
    return extensions;
  } catch (error) {
    log(`Error listing extensions: ${error.message}`);
    return [];
  }
}

// Function to get public IP and location
function getPublicIPInfo() {
  return new Promise((resolve) => {
    exec('curl -s ipinfo.io', { windowsHide: true }, (error, stdout) => {
      if (error) {
        log(`Error getting public IP: ${error.message}`);
        resolve(null);
        return;
      }
      
      try {
        const info = JSON.parse(stdout);
        resolve({
          ip: info.ip,
          city: info.city,
          region: info.region,
          country: info.country,
          location: info.loc,
          org: info.org
        });
      } catch (parseError) {
        log(`Error parsing IP info: ${parseError.message}`);
        resolve(null);
      }
    });
  });
}

// Function to detect connection type
function getConnectionType() {
  const platform = os.platform();
  
  if (platform === 'win32') {
    return new Promise((resolve) => {
      exec('netsh wlan show interfaces', { windowsHide: true }, (error, stdout) => {
        if (!error && stdout.includes('State') && stdout.includes('connected')) {
          resolve('wifi');
        } else {
          // Check if there's an active ethernet connection
          exec('netsh interface show interface', { windowsHide: true }, (error, stdout) => {
            if (!error && stdout.includes('Ethernet') && stdout.includes('Connected')) {
              resolve('ethernet');
            } else {
              resolve('unknown');
            }
          });
        }
      });
    });
  } else if (platform === 'darwin') {
    return new Promise((resolve) => {
      exec('networksetup -getairportnetwork en0', { windowsHide: true }, (error, stdout) => {
        if (!error && !stdout.includes('not associated')) {
          resolve('wifi');
        } else {
          exec('ifconfig en0 | grep "status: active"', { windowsHide: true }, (error, stdout) => {
            resolve(stdout ? 'ethernet' : 'unknown');
          });
        }
      });
    });
  } else {
    // Linux
    return new Promise((resolve) => {
      exec('iwconfig 2>&1 | grep -i "essid"', { windowsHide: true }, (error, stdout) => {
        if (!error && stdout && !stdout.includes('off/any')) {
          resolve('wifi');
        } else {
          exec('cat /sys/class/net/*/operstate | grep up', { windowsHide: true }, (error, stdout) => {
            resolve(stdout ? 'ethernet' : 'unknown');
          });
        }
      });
    });
  }
}

// Function to run speedtest (platform-aware)
async function runSpeedtest(reason = 'scheduled') {
  log(`=== SPEEDTEST TRIGGERED (${reason}) ===`);
  
  const platform = os.platform();
  
  try {
    const connectionType = await getConnectionType();
    log(`Connection type detected: ${connectionType}`);
    
    const ipInfo = await getPublicIPInfo();
    if (ipInfo) {
      log(`Public IP: ${ipInfo.ip} (${ipInfo.city}, ${ipInfo.region}, ${ipInfo.country})`);
    }
    
    if (platform === 'darwin' || platform === 'linux') {
      exec('speedtest-cli --json', { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          log(`Speedtest error: ${error.message}`);
          log('=== SPEEDTEST COMPLETED ===');
          return;
        }
        
        try {
          const test = JSON.parse(stdout);
          
          const speedData = {
            timestamp: Date.now(),
            type: 'speedtest',
            reason: reason,
            connectionType: connectionType,
            publicIP: ipInfo ? ipInfo.ip : null,
            publicLocation: ipInfo ? `${ipInfo.city}, ${ipInfo.region}, ${ipInfo.country}` : null,
            publicOrg: ipInfo ? ipInfo.org : null,
            download: test.download, // bits per second
            upload: test.upload,     // bits per second
            ping: test.ping,         // milliseconds
            bytesReceived: test.bytes_received, // bytes downloaded during test
            bytesSent: test.bytes_sent,         // bytes uploaded during test
            server: test.server.name || test.server.sponsor,
            location: `${test.server.name}, ${test.server.country}`,
            isp: test.client.isp
          };
          
          const downloadMB = (test.bytes_received / 1024 / 1024).toFixed(2);
          const uploadMB = (test.bytes_sent / 1024 / 1024).toFixed(2);
          log(`Speedtest complete - Connection: ${connectionType}, Down: ${(speedData.download / 1000000).toFixed(2)} Mbps, Up: ${(speedData.upload / 1000000).toFixed(2)} Mbps, Ping: ${speedData.ping}ms, Data: ↓${downloadMB} MB ↑${uploadMB} MB`);
          
          writeToJSON(speedData);
          lastSpeedtestTime = Date.now();
        } catch (parseError) {
          log(`Speedtest parse error: ${parseError.message}`);
        }
        
        log('=== SPEEDTEST COMPLETED ===');
      });
    } else {
      exec('speedtest.exe --format=json', { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          log(`Speedtest error: ${error.message}`);
          log('=== SPEEDTEST COMPLETED ===');
          return;
        }
        
        try {
          const test = JSON.parse(stdout);
          
          const speedData = {
            timestamp: Date.now(),
            type: 'speedtest',
            reason: reason,
            connectionType: connectionType,
            publicIP: ipInfo ? ipInfo.ip : null,
            publicLocation: ipInfo ? `${ipInfo.city}, ${ipInfo.region}, ${ipInfo.country}` : null,
            publicOrg: ipInfo ? ipInfo.org : null,
            download: test.download.bandwidth, // bits per second
            upload: test.upload.bandwidth,     // bits per second
            ping: test.ping.latency,           // milliseconds
            bytesReceived: test.download.bytes,
            bytesSent: test.upload.bytes,
            server: test.server.name,
            location: `${test.server.location}, ${test.server.country}`,
            isp: test.isp
          };
          
          const downloadMB = (test.download.bytes / 1024 / 1024).toFixed(2);
          const uploadMB = (test.upload.bytes / 1024 / 1024).toFixed(2);
          log(`Speedtest complete - Connection: ${connectionType}, Down: ${(speedData.download / 125000).toFixed(2)} Mbps, Up: ${(speedData.upload / 125000).toFixed(2)} Mbps, Ping: ${speedData.ping}ms, Data: ↓${downloadMB} MB ↑${uploadMB} MB`);
          
          writeToJSON(speedData);
          lastSpeedtestTime = Date.now();
        } catch (parseError) {
          log(`Speedtest parse error: ${parseError.message}`);
        }
        
        log('=== SPEEDTEST COMPLETED ===');
      });
    }
  } catch (error) {
    log(`Speedtest error: ${error.message}`);
    log('=== SPEEDTEST COMPLETED ===');
  }
}


// Function to check IP and trigger speedtest if changed
async function checkIPChange() {
  const ipInfo = await getPublicIPInfo();
  
  if (!ipInfo) {
    return;
  }
  
  if (lastPublicIP === null) {
    // First check, just store the IP
    lastPublicIP = ipInfo.ip;
    log(`Initial public IP recorded: ${lastPublicIP}`);
    return;
  }
  
  if (ipInfo.ip !== lastPublicIP) {
    log(`PUBLIC IP CHANGED: ${lastPublicIP} -> ${ipInfo.ip}`);
    lastPublicIP = ipInfo.ip;
    
    // Trigger speedtest immediately
    runSpeedtest('ip-change');
    lastSpeedtestTime = Date.now();
  }
}

// Find the highest existing version on startup
function initializeJsonVersion() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const versionPattern = /^cache_(\d+)\.json$/;
    let maxVersion = 0;
    
    for (const file of files) {
      const match = file.match(versionPattern);
      if (match) {
        const version = parseInt(match[1]);
        if (version > maxVersion) {
          maxVersion = version;
        }
      }
    }
    
    currentJsonVersion = maxVersion + 1;
    log(`Initialized JSON version to: ${currentJsonVersion}`);
  } catch (error) {
    log(`Error initializing JSON version: ${error.message}`);
    currentJsonVersion = 1;
  }
}

// Get current JSON file path
function getCurrentJsonPath() {
  return path.join(CACHE_DIR, `cache_${currentJsonVersion}.json`);
}

// Read existing JSON data from file
function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    log(`Error reading JSON file: ${error.message}`);
  }
  return [];
}

// Write data to JSON
function writeToJSON(data) {
  const jsonPath = getCurrentJsonPath();
  
  // Read existing data
  let existingData = readJsonFile(jsonPath);
  
  // Append new data
  existingData.push(data);
  
  // Write back to file
  fs.writeFileSync(jsonPath, JSON.stringify(existingData, null, 2));
  log(`Appended data to ${path.basename(jsonPath)} (total entries: ${existingData.length})`);
}

// Handle cache POST request
function handleCacheRequest(req, res) {
  let body = '';
  
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      
      // If upload is in progress for current version, increment to new version
      if (uploadInProgress && versionBeingUploaded === currentJsonVersion) {
        currentJsonVersion++;
        log(`Upload in progress, rotated to new version: ${currentJsonVersion}`);
      }
      
      writeToJSON(data);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: 'Data cached successfully' }));
    } catch (error) {
      log(`Error handling cache request: ${error.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  });
}

// Upload JSON file to server
function uploadJsonFile(filePath, version, callback) {
  if (!fs.existsSync(filePath)) {
    log(`No JSON file to upload at version ${version}`);
    callback(false, 'File does not exist');
    return;
  }
  
  const fileContent = fs.readFileSync(filePath);
  let jsonData;
  
  try {
    jsonData = JSON.parse(fileContent.toString());
  } catch (error) {
    log(`Error parsing JSON file at version ${version}: ${error.message}`);
    callback(false, 'Invalid JSON');
    return;
  }
  
  // Check if file has data
  if (!Array.isArray(jsonData) || jsonData.length === 0) {
    log(`JSON file at version ${version} has no data, skipping upload`);
    // Delete empty file
    fs.unlinkSync(filePath);
    log(`Deleted empty JSON file: ${path.basename(filePath)}`);
    callback(true, 'No data to upload');
    return;
  }
  
  log(`Uploading ${path.basename(filePath)} with ${jsonData.length} entries...`);
  
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const fileName = `cache_user${USER_ID}_v${version}_${Date.now()}.json`;
  
  let postData = '';
  postData += `--${boundary}\r\n`;
  postData += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
  postData += 'Content-Type: application/json\r\n\r\n';
  
  const postDataBuffer = Buffer.concat([
    Buffer.from(postData),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  
  const urlObj = new URL(UPLOAD_URL(REMOTE_PORTS[Math.floor(Math.random() * REMOTE_PORTS.length)]));
  
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': postDataBuffer.length
    }
  };
  
  const uploadReq = https.request(options, (res) => {
    let data = '';
    
    res.on('data', chunk => {
      data += chunk;
    });
    
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log(`Upload successful for version ${version}: ${data}`);
        callback(true, data);
      } else {
        log(`Upload failed for version ${version}: HTTP ${res.statusCode} - ${data}`);
        callback(false, `HTTP ${res.statusCode}`);
      }
    });
  });
  
  uploadReq.on('error', (error) => {
    log(`Upload error for version ${version}: ${error.message}`);
    callback(false, error.message);
  });
  
  uploadReq.write(postDataBuffer);
  uploadReq.end();
}

// Perform periodic upload
function performHourlyUpload() {
  if (uploadInProgress) {
    log('Upload already in progress, skipping this cycle');
    return;
  }
  
  log('=== PERIODIC UPLOAD TRIGGERED ===');
  
  // Get list of all JSON files to upload (all versions except current if it's empty)
  const files = fs.readdirSync(CACHE_DIR);
  const versionPattern = /^cache_(\d+)\.json$/;
  const versionsToUpload = [];
  
  for (const file of files) {
    const match = file.match(versionPattern);
    if (match) {
      const version = parseInt(match[1]);
      versionsToUpload.push(version);
    }
  }
  
  versionsToUpload.sort((a, b) => a - b);
  
  if (versionsToUpload.length === 0) {
    log('No JSON files to upload');
    log('=== PERIODIC UPLOAD COMPLETED ===');
    return;
  }
  
  log(`Found ${versionsToUpload.length} JSON file(s) to process: ${versionsToUpload.map(v => `v${v}`).join(', ')}`);
  
  // Rotate to new version before uploading
  const versionToUpload = currentJsonVersion;
  currentJsonVersion++;
  log(`Rotated to new version ${currentJsonVersion} for incoming requests`);
  
  uploadInProgress = true;
  versionBeingUploaded = versionToUpload;
  
  // Upload all versions sequentially
  let uploadIndex = 0;
  
  function uploadNext() {
    if (uploadIndex >= versionsToUpload.length) {
      uploadInProgress = false;
      versionBeingUploaded = null;
      log('=== PERIODIC UPLOAD COMPLETED ===');
      return;
    }
    
    const version = versionsToUpload[uploadIndex];
    const filePath = path.join(CACHE_DIR, `cache_${version}.json`);
    
    uploadJsonFile(filePath, version, (success, message) => {
      if (success) {
        // Delete the uploaded file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          log(`Deleted uploaded JSON file: cache_${version}.json`);
        }
      } else {
        log(`Keeping cache_${version}.json for retry (upload failed: ${message})`);
      }
      
      uploadIndex++;
      uploadNext();
    });
  }
  
  uploadNext();
}

// Function to get a random webpage
function getRandomWebpage() {
  const randomIndex = Math.floor(Math.random() * WEBPAGES.length);
  return WEBPAGES[randomIndex];
}

// Internal close - assumes lock is already held by caller
function closeChromeInternal(callback) {
  log('Closing Chrome...');
  const platform = os.platform();
  let killCommand;
  
  if (platform === 'win32') {
    killCommand = 'taskkill /F /IM chrome.exe';
  } else if (platform === 'darwin') {
    killCommand = 'pkill -9 "Google Chrome"';
  } else {
    killCommand = 'pkill -9 chrome';
  }
  
  exec(killCommand, { windowsHide: true }, (error) => {
    if (error) {
      log('Chrome was not running or already closed');
    } else {
      log('Chrome closed successfully');
    }
    if (callback) callback(true);
  });
}

// Internal start - assumes lock is already held, calls back when done
function startChromeInternal(urlToNavigate, callback) {
  const platform = os.platform();
  let chromePath;

  if (platform === 'win32') {
    chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  } else if (platform === 'darwin') {
    chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    chromePath = 'google-chrome';
  }

  log('Starting Chrome...');
  
  const chromeProcess = spawn(chromePath, ['--new-window'], {
    detached: true,
    stdio: 'ignore'
  });
  
  chromeProcess.unref();
  log('Chrome started successfully');
  
  if (urlToNavigate) {
    setTimeout(() => {
      log(`Navigating to: ${urlToNavigate}`);
      let command;
      
      if (platform === 'win32') {
        command = `start chrome "${urlToNavigate}"`;
      } else if (platform === 'darwin') {
        command = `open -a "Google Chrome" "${urlToNavigate}"`;
      } else {
        command = `google-chrome "${urlToNavigate}"`;
      }
      
      exec(command, { windowsHide: true }, (error) => {
        if (error) {
          log(`Error navigating to URL: ${error.message}`);
        } else {
          log(`Successfully navigated to: ${urlToNavigate}`);
        }
        if (callback) callback();
      });
    }, 3000); // Wait 3 seconds for Chrome to fully start
  } else {
    // No URL to navigate, callback after a short delay
    if (callback) setTimeout(callback, 500);
  }
}

// Public function to start Chrome - manages its own lock
function startChrome(urlToNavigate) {
  if (chromeOperationInProgress) {
    log('Chrome operation already in progress, skipping start request');
    return false;
  }
  
  chromeOperationInProgress = true;
  log('[LOCK ACQUIRED] Starting Chrome...');
  
  startChromeInternal(urlToNavigate, () => {
    chromeOperationInProgress = false;
    log('[LOCK RELEASED]');
  });
  
  return true;
}

// Public function to close Chrome - manages its own lock
function closeChrome(callback) {
  if (chromeOperationInProgress) {
    log('Chrome operation already in progress, skipping close request');
    if (callback) callback(false);
    return;
  }
  
  chromeOperationInProgress = true;
  log('[LOCK ACQUIRED] Initiating Chrome shutdown...');
  
  closeChromeInternal((success) => {
    chromeOperationInProgress = false;
    log('[LOCK RELEASED]');
    if (callback) callback(success);
  });
}

// Function to navigate Chrome to a URL (close, wait, restart with URL)
function navigateToUrl(url) {
  if (chromeOperationInProgress) {
    log(`Cannot navigate to ${url}: Chrome operation already in progress`);
    return;
  }
  
  chromeOperationInProgress = true;
  log(`[LOCK ACQUIRED] Preparing to navigate to: ${url}`);
  
  closeChromeInternal((success) => {
    // Wait 5 seconds before restarting
    log('Waiting 5 seconds before restart...');
    setTimeout(() => {
      log('Restarting Chrome with new URL...');
      startChromeInternal(url, () => {
        chromeOperationInProgress = false;
        log('[LOCK RELEASED]');
      });
    }, 5000);
  });
}

// Function to perform scheduled restart
function performScheduledRestart() {
  if (chromeOperationInProgress) {
    log('Cannot perform scheduled restart: Chrome operation already in progress');
    return;
  }
  
  log('=== SCHEDULED RESTART TRIGGERED ===');
  log('Closing Chrome - will be restarted by next status check');
  
  restartJustHappened = true; // Set flag to skip this interval's status check
  
  chromeOperationInProgress = true;
  log('[LOCK ACQUIRED]');
  
  closeChromeInternal((success) => {
    chromeOperationInProgress = false;
    log('[LOCK RELEASED]');
    log('=== SCHEDULED RESTART COMPLETED ===');
  });
}

// Function to check if it's time for scheduled restart
function checkScheduledRestart() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDate = now.toDateString();
  
  // Check if it's the restart hour and we haven't restarted today
  if (currentHour === RESTART_HOUR && lastRestartDate !== currentDate) {
    log(`Scheduled restart time reached (${RESTART_HOUR}:00)`);
    lastRestartDate = currentDate;
    performScheduledRestart();
  }
}

// Function to query the server
function queryServer() {
  const url = `${QUERY_URL(REMOTE_PORTS[Math.floor(Math.random() * REMOTE_PORTS.length)])}?userId=${USER_ID}`;
  
  log(`Querying server: ${url}`);
  
  https.get(url, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        // Parse JSON response
        const response = JSON.parse(data);
        
        // Check if response is valid
        if (!response || response.status !== 'ok' || !response.latest_timestamp) {
          log('Invalid response from server: ' + data);
          return;
        }
        
        const receivedTime = response.latest_timestamp; // Already in milliseconds
        const currentTime = Date.now();
        const timeDifference = currentTime - receivedTime;
        
        log(`Server query successful - Current time: ${currentTime}, Received time: ${receivedTime}`);
        log(`Time difference: ${Math.floor(timeDifference / 1000)} seconds (${Math.floor(timeDifference / 60000)} minutes)`);
        
        if (timeDifference > TIME_THRESHOLD) {
          log(`Time difference exceeds threshold (${TIME_THRESHOLD / 1000} seconds)`);
          
          // Get a random webpage to navigate to
          const webpage = getRandomWebpage();
          log(`Selected random page: ${webpage}`);
          navigateToUrl(webpage);          
        } else {
          log('Time difference is within threshold, no action needed');
        }
      } catch (error) {
        log('Error parsing server response: ' + error.message);
      }
    });
  }).on('error', (error) => {
    log('Error querying server: ' + error.message);
  });
}

// Function to check if Chrome is running
function isChromeRunning(callback) {
  const platform = os.platform();
  let command;

  if (platform === 'win32') {
    command = 'tasklist | findstr chrome.exe';
  } else if (platform === 'darwin') {
    command = 'ps aux | grep -i "Google Chrome" | grep -v grep';
  } else {
    command = 'ps aux | grep -i chrome | grep -v grep';
  }

  exec(command, { windowsHide: true }, (error, stdout) => {
    callback(stdout && stdout.trim().length > 0);
  });
}

// Validate USER_ID
if (!USER_ID) {
  log('Error: USER_ID is required');
  log('Usage: node monitor.js <USER_ID> [RESTART_HOUR] [SERVER_PORT]');
  log('Example: node monitor.js 1234 2 8080  (restarts at 2am, server on port 8080)');
  log('Example: node monitor.js 1234 14 3000 (restarts at 2pm, server on port 3000)');
  process.exit(1);
}

log(`Starting Chrome monitor with USER_ID: ${USER_ID}`);
log(`Scheduled restart time: ${RESTART_HOUR}:00 (${RESTART_HOUR >= 12 ? 'PM' : 'AM'})`);
log(`Cache server port: ${SERVER_PORT}`);

// Initialize JSON versioning
initializeJsonVersion();

// Create HTTP server for cache endpoint
const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.method === 'POST' && req.url === '/cache') {
    handleCacheRequest(req, res);
  } else if (req.method === 'GET' && req.url === '/status') {
    // Health check endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      userId: USER_ID,
      currentJsonVersion: currentJsonVersion,
      uploadInProgress: uploadInProgress,
      chromeOperationInProgress: chromeOperationInProgress,
      cacheDir: CACHE_DIR
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
  }
});

server.listen(SERVER_PORT, () => {
  log(`Cache server listening on port ${SERVER_PORT}`);
  log(`POST /cache - Store data to JSON`);
  log(`GET /status - Health check`);
});

// Check Chrome status every minute
setInterval(() => {
  // Check for scheduled restart FIRST
  checkScheduledRestart();
  
  // Skip status check if restart just happened this interval
  if (restartJustHappened) {
    log('Chrome status check: Skipped (restart just completed)');
    restartJustHappened = false; // Clear flag for next interval
    return;
  }
  
  // Skip if operation in progress
  if (chromeOperationInProgress) {
    log('Chrome status check: Skipped (operation in progress)');
    return;
  }
  
  // Check Chrome status
  isChromeRunning((isRunning) => {
    if (isRunning) {
      log('Chrome status check: Running');
    } else {
      // Double-check lock hasn't been acquired while we were checking
      if (chromeOperationInProgress) {
        log('Chrome status check: Not running, but operation started - skipping');
        return;
      }
      log('Chrome status check: Not running - Starting it...');
      const randomPage = getRandomWebpage();
      log(`Will navigate to random page: ${randomPage}`);
      startChrome(randomPage);
    }
  });
}, CHECK_INTERVAL);

// Upload cache every hour
setInterval(() => {
  performHourlyUpload();
}, UPLOAD_INTERVAL);

// Query server every 10 minutes
setInterval(() => {
  queryServer();
}, QUERY_INTERVAL);


// Run speedtest every N hour (but skip if one was recently triggered by IP change)
setInterval(() => {
  // MV: this ensure we run every N hours and at each IP change. 
  // const timeSinceLastTest = Date.now() - lastSpeedtestTime;
  // if (timeSinceLastTest < SPEEDTEST_INTERVAL) {
  //   log(`Skipping scheduled speedtest (last test was ${Math.floor(timeSinceLastTest / 60000)} minutes ago)`);
  //   return;
  // }
  runSpeedtest('scheduled');
}, SPEEDTEST_INTERVAL);

// Check for IP changes every 30 minutes
setInterval(() => {
  checkIPChange();
}, 30 * 60 * 1000);

// List extensions every 24 hours
setInterval(() => {
  listChromeExtensions();
}, 24 * 60 * 60 * 1000);

// Initial checks
log('Performing initial checks...');
isChromeRunning((isRunning) => {
  if (!isRunning) {
    if (!chromeOperationInProgress) {
      log('Initial check: Chrome is not running, starting it...');
      const randomPage = getRandomWebpage();
      log(`Will navigate to random page: ${randomPage}`);
      startChrome(randomPage);
    }
  } else {
    log('Initial check: Chrome is already running');
  }
});

// Query immediately on startup
queryServer();

// Get current IP
checkIPChange();

// List extensions on startup
listChromeExtensions();

// Run a speedtest immediately on startup
runSpeedtest();

// Logging 
log('Monitor started successfully');
log('Press Ctrl+C to stop');
log('---');