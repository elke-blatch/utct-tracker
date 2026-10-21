// ─── UTCT 100km Tracker — Runner's Phone (iOS/Android) ───

let watchId = null;
let wakeLock = null;
let isTracking = false;
let pingCount = 0;
let lastSentLat = null;
let lastSentLon = null;
let lastSentTime = 0;
const MIN_INTERVAL_MS = 8000;       // minimum 12 seconds between pings
const MIN_DISTANCE_M = 5;          // minimum 10m movement to send
const PING_URL = '/api/ping';

// ─── Battery ───
let batteryLevel = null;
async function initBattery() {
  try {
    const bat = await navigator.getBattery();
    batteryLevel = bat.level;
    bat.addEventListener('levelchange', () => {
      batteryLevel = bat.level;
      updateBatteryDisplay();
    });
    updateBatteryDisplay();
  } catch(e) {
    // iOS Safari does not support Battery API — battery will show as "—"
  }
}

function updateBatteryDisplay() {
  const el = document.getElementById('stat-battery');
  if (batteryLevel !== null) {
    const pct = Math.round(batteryLevel * 100);
    el.textContent = pct + '%';
    el.style.color = pct < 30 ? '#ef4444' : pct < 50 ? '#f59e0b' : '#22c55e';
  }
}

// ─── Wake Lock ───
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('Wake Lock released');
        // Try to re-acquire on visibility change
        if (isTracking) {
          document.addEventListener('visibilitychange', reAcquireWakeLock);
        }
      });
      console.log('Wake Lock acquired');
    }
  } catch(e) {
    console.log('Wake Lock failed:', e.message);
    // Fallback: silent audio loop to keep app alive
    startNoSleepAudio();
  }
}

async function reAcquireWakeLock() {
  if (document.visibilityState === 'visible' && isTracking) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      document.removeEventListener('visibilitychange', reAcquireWakeLock);
    } catch(e) {}
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  document.removeEventListener('visibilitychange', reAcquireWakeLock);
  stopNoSleepAudio();
}

// ─── No-sleep audio fallback (keeps the app alive when screen is locked) ───
let noSleepAudio = null;
function startNoSleepAudio() {
  try {
    // Generate a short silent audio clip as a data URL
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = audioCtx.createBuffer(1, 4410, 44100); // 0.1s of silence
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audioCtx.destination);
    source.start();
    noSleepAudio = { ctx: audioCtx, source: source };
    console.log('No-sleep audio started');
  } catch(e) {
    console.log('No-sleep audio failed:', e.message);
  }
}

function stopNoSleepAudio() {
  if (noSleepAudio) {
    try {
      noSleepAudio.source.stop();
      noSleepAudio.ctx.close();
    } catch(e) {}
    noSleepAudio = null;
  }
}

// ─── GPS Tracking ───
function startTracking() {
  if (!navigator.geolocation) {
    alert('GPS not supported on this device');
    return;
  }

  isTracking = true;
  pingCount = 0;
  lastSentLat = null;
  lastSentLon = null;

  // Update UI
  document.getElementById('start-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'block';
  document.getElementById('status-circle').classList.add('active');
  document.getElementById('status-icon').innerHTML = '&#128994;';
  document.getElementById('status-text').textContent = 'Tracking active';
  document.getElementById('hint').textContent = 'Keep app open. Lock screen is OK. Do not close browser tab.';

  // Request wake lock
  requestWakeLock();

  // Start GPS watching
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000,
    }
  );

  console.log('GPS tracking started, watchId:', watchId);
}

function stopTracking() {
  isTracking = false;
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();

  document.getElementById('start-btn').style.display = 'block';
  document.getElementById('stop-btn').style.display = 'none';
  document.getElementById('status-circle').classList.remove('active');
  document.getElementById('status-icon').innerHTML = '&#128308;';
  document.getElementById('status-text').textContent = 'Not tracking';
  document.getElementById('hint').textContent = 'Tap Start, then keep this app open.';
}

// ─── Position handler ───
function onPosition(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const accuracy = pos.coords.accuracy;
  const speed = pos.coords.speed;

  // Update GPS accuracy display
  const accEl = document.getElementById('stat-accuracy');
  if (accuracy) {
    accEl.textContent = Math.round(accuracy) + 'm';
    accEl.style.color = accuracy < 30 ? '#22c55e' : accuracy < 100 ? '#f59e0b' : '#ef4444';
  }

  // Check minimum interval
  const now = Date.now();
  if (now - lastSentTime < MIN_INTERVAL_MS) return;

  // Check minimum distance (skip if barely moved)
  if (lastSentLat !== null) {
    const dist = haversine(lat, lon, lastSentLat, lastSentLon);
    if (dist < MIN_DISTANCE_M) return;
  }

  // Send ping
  sendPing(lat, lon, accuracy, speed);
  lastSentLat = lat;
  lastSentLon = lon;
  lastSentTime = now;
}

function onPositionError(err) {
  console.log('GPS error:', err.message);
  document.getElementById('status-circle').classList.remove('active');
  document.getElementById('status-circle').classList.add('error');
  document.getElementById('status-icon').innerHTML = '&#9888;';
  document.getElementById('status-text').textContent = 'GPS error: ' + err.message;

  // Try to recover after 10 seconds
  setTimeout(() => {
    if (isTracking) {
      document.getElementById('status-circle').classList.remove('error');
      document.getElementById('status-circle').classList.add('active');
      document.getElementById('status-icon').innerHTML = '&#128994;';
      document.getElementById('status-text').textContent = 'Tracking (reconnecting...)';
    }
  }, 10000);
}

// ─── Send ping to server ───
function sendPing(lat, lon, accuracy, speed) {
  const data = {
    lat: lat,
    lon: lon,
    accuracy: accuracy,
    speed: speed,
    battery: batteryLevel,
    timestamp: Date.now(),
  };

  fetch(PING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(r => r.json()).then(res => {
    pingCount++;
    document.getElementById('stat-pings').textContent = pingCount;
    if (res.route_km) {
      document.getElementById('stat-km').textContent = res.route_km + ' km';
    }
  }).catch(err => {
    // Offline — cache ping in localStorage
    cachePing(data);
    console.log('Ping failed, cached locally:', err.message);
  });
}

// ─── Offline caching ───
function cachePing(data) {
  let cache = JSON.parse(localStorage.getItem('pendingPings') || '[]');
  cache.push(data);
  if (cache.length > 200) cache = cache.slice(-200); // keep last 200
  localStorage.setItem('pendingPings', JSON.stringify(cache));
}

function sendCachedPings() {
  const cache = JSON.parse(localStorage.getItem('pendingPings') || '[]');
  if (cache.length === 0) return;

  let sent = 0;
  cache.forEach((data, i) => {
    fetch(PING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => {
      sent++;
      if (sent === cache.length) {
        localStorage.removeItem('pendingPings');
        console.log('All cached pings sent:', sent);
      }
    }).catch(() => {
      // Still offline, keep cache
    });
  });
}

// ─── Try sending cached pings every 30 seconds ───
setInterval(() => {
  if (isTracking) sendCachedPings();
}, 30000);

// ─── Online/offline detection ───
window.addEventListener('online', () => {
  if (isTracking) {
    document.getElementById('status-text').textContent = 'Tracking active';
    sendCachedPings();
  }
});

window.addEventListener('offline', () => {
  if (isTracking) {
    document.getElementById('status-text').textContent = 'Offline — caching pings';
  }
});

// ─── Haversine ───
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── Init ───
initBattery();

// Prevent page unload warning while tracking
window.addEventListener('beforeunload', (e) => {
  if (isTracking) {
    e.preventDefault();
    e.returnValue = 'Tracking is active. Are you sure you want to leave?';
  }
});
