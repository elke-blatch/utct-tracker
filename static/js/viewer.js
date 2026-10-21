// ─── UTCT 100km Live Tracker — Viewer Dashboard (Polling) ───

let map, routeLine, runnerMarker, trailLine, elevationCanvas;
let aidStationMarkers = [];
let autoFollow = true;
let trackPoints = [];
let aidStations = [];
let totalKm = 99.21;
let lastAlertId = 0;
let routeLoaded = false;

// ─── Initialize map ───
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    minZoom: 8,
    maxZoom: 18,
  }).setView([-33.95, 18.42], 12);

  // OpenStreetMap standard tiles — free, no API key required
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: ['a','b','c'],
    maxZoom: 19,
  }).addTo(map);



  elevationCanvas = document.getElementById('elevation-canvas');
}

// ─── Load route data on startup ───
function loadRoute() {
  fetch('/api/route')
    .then(r => r.json())
    .then(data => {
      trackPoints = data.track_points || [];
      aidStations = data.aid_stations || [];
      totalKm = data.total_km || 99.21;

      // Draw route polyline
      const latlngs = trackPoints.map(p => [p.lat, p.lon]);
      routeLine = L.polyline(latlngs, {
        color: '#3b82f6',
        weight: 3,
        opacity: 0.7,
      }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

      // Draw aid station markers
      aidStationMarkers.forEach(m => map.removeLayer(m));
      aidStationMarkers = [];

      aidStations.forEach((st, i) => {
        if (!st.lat || !st.lon) return;

        let color, icon;
        if (st.type === 'start') { color = '#22c55e'; icon = 'S'; }
        else if (st.type === 'finish') { color = '#8b5cf6'; icon = 'F'; }
        else if (st.type === 'tp') { color = '#f97316'; icon = 'T'; }
        else { color = '#6366f1'; icon = 'A'; }

        const markerHtml = '<div style="' +
          'width:28px;height:28px;border-radius:50%;' +
          'background:' + color + ';border:2px solid rgba(255,255,255,0.3);' +
          'display:flex;align-items:center;justify-content:center;' +
          'font-size:12px;font-weight:700;color:#fff;">' + icon + '</div>';

        const marker = L.marker([st.lat, st.lon], {
          icon: L.divIcon({
            className: 'aid-station-marker',
            html: markerHtml,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(map);

        const cutoffText = st.cutoff ? '<br><span style="color:#f59e0b;font-weight:600;">Cutoff: ' + st.cutoff + '</span>' : '';
        const supportText = st.support ? '<br><span style="color:#22c55e;">Support crew</span>' : '';
        const dropText = st.drop_bag ? '<br>Drop bag' : '';
        const busText = st.return_bus ? ' | Return bus' : '';
        const toiletText = st.toilets ? ' | Toilets' : '';

        marker.bindPopup(
          '<div style="font-size:13px;min-width:180px;">' +
          '<div style="font-weight:700;margin-bottom:4px;">' + st.name + '</div>' +
          '<div style="color:#7a85a0;font-size:11px;">' +
          'KM ' + st.total_km.toFixed(1) + ' | Elev ' + Math.round(st.elevation || 0) + 'm' + cutoffText + supportText +
          '</div>' +
          '<div style="margin-top:4px;font-size:11px;color:#7a85a0;">' +
          'Planned: ' + st.arrival + ' - ' + st.departure +
          '</div>' +
          (dropText || busText || toiletText ? '<div style="margin-top:2px;font-size:11px;color:#7a85a0;">' + dropText + busText + toiletText + '</div>' : '') +
          '</div>'
        );

        aidStationMarkers.push(marker);
      });

      // Draw elevation profile
      drawElevationProfile(undefined);

      routeLoaded = true;
      console.log('Route loaded: ' + trackPoints.length + ' points, ' + aidStations.length + ' stations, ' + totalKm + ' km');
    })
    .catch(err => {
      console.error('Failed to load route:', err);
      document.getElementById('stat-distance').innerHTML = '<span style="color:#ef4444;">Failed to load</span>';
    });
}

// ─── Update runner position on map ───
// Smooth marker animation
var animTimer = null;
function animateMarker(marker, fromLat, fromLon, toLat, toLon, duration) {
  if (animTimer) clearInterval(animTimer);
  var start = Date.now();
  var frames = 30;
  var interval = duration / frames;
  var frame = 0;
  animTimer = setInterval(function() {
    frame++;
    var t = Math.min(frame / frames, 1);
    var eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    var lat = fromLat + (toLat - fromLat) * eased;
    var lon = fromLon + (toLon - fromLon) * eased;
    marker.setLatLng([lat, lon]);
    if (t >= 1) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }, interval);
}

function updateRunnerPosition(lat, lon, km) {
  if (!runnerMarker) {
    const runnerHtml =
      '<div style="position:relative;">' +
      '<div class="runner-marker-pulse"></div>' +
      '<div style="' +
      'width:16px;height:16px;border-radius:50%;' +
      'background:#22c55e;border:3px solid #fff;' +
      'box-shadow:0 0 12px rgba(34,197,94,0.6);' +
      'position:relative;z-index:1;"></div></div>';

    runnerMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'runner-marker',
        html: runnerHtml,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      zIndexOffset: 1000,
    }).addTo(map);

    document.getElementById('runner-info-bar').style.display = 'flex';
  } else {
    var current = runnerMarker.getLatLng();
    animateMarker(runnerMarker, current.lat, current.lng, lat, lon, 1500);
  }

  // Auto-follow: recenter map on runner
  if (autoFollow) {
    map.panTo([lat, lon], { animate: true, duration: 0.5 });
  }

  // Update trail
  if (window._recentPositions && window._recentPositions.length > 1) {
    if (trailLine) map.removeLayer(trailLine);
    trailLine = L.polyline(window._recentPositions.map(p => [p.lat, p.lon]), {
      color: '#22c55e',
      weight: 2,
      opacity: 0.4,
      dashArray: '4,4',
    }).addTo(map);
  }

  drawElevationMarker(km);
}

// ─── Elevation profile ───
function drawElevationProfile(runnerKm) {
  if (!elevationCanvas || !trackPoints.length) return;
  var ctx = elevationCanvas.getContext('2d');
  var w = elevationCanvas.width;
  var h = elevationCanvas.height;
  ctx.clearRect(0, 0, w, h);

  var elevs = trackPoints.map(function(p) { return p.ele || 0; });
  var maxE = Math.max.apply(null, elevs);
  var minE = Math.min.apply(null, elevs);
  var range = maxE - minE || 1;
  var padTop = 14, padBot = 14, padL = 30;
  var drawW = w - padL - 2;
  var drawH = h - padTop - padBot;

  // Background grid lines (horizontal)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '8px -apple-system, sans-serif';
  ctx.fillStyle = '#4a5375';
  for (var g = 0; g <= 4; g++) {
    var gy = padTop + (drawH * g / 4);
    var gv = Math.round(maxE - (range * g / 4));
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
    ctx.fillText(gv + 'm', 2, gy + 3);
  }

  // Fill gradient under the curve
  ctx.beginPath();
  ctx.moveTo(padL, h - padBot);
  for (var i = 0; i < trackPoints.length; i++) {
    var x = padL + (i / (trackPoints.length - 1)) * drawW;
    var y = padTop + (1 - (elevs[i] - minE) / range) * drawH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padL + drawW, h - padBot);
  ctx.closePath();
  var grad = ctx.createLinearGradient(0, padTop, 0, h - padBot);
  grad.addColorStop(0, 'rgba(59,130,246,0.35)');
  grad.addColorStop(1, 'rgba(59,130,246,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Elevation line
  ctx.beginPath();
  for (var i = 0; i < trackPoints.length; i++) {
    var x = padL + (i / (trackPoints.length - 1)) * drawW;
    var y = padTop + (1 - (elevs[i] - minE) / range) * drawH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Aid station markers on the profile
  aidStations.forEach(function(st) {
    if (!st.lat || !st.lon) return;
    var sx = padL + (st.total_km / totalKm) * drawW;
    var sy = padTop + (1 - (st.elevation || 0) - minE) / range * drawH;
    // Vertical tick
    ctx.beginPath();
    ctx.moveTo(sx, h - padBot);
    ctx.lineTo(sx, h - padBot - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Dot
    var dotColor = '#6366f1';
    if (st.type === 'start') dotColor = '#22c55e';
    else if (st.type === 'finish') dotColor = '#8b5cf6';
    else if (st.type === 'tp') dotColor = '#f97316';
    ctx.beginPath();
    ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  });

  // Runner position marker
  if (runnerKm !== undefined && runnerKm > 0) {
    var pct = runnerKm / totalKm;
    var idx = Math.min(Math.floor(pct * (trackPoints.length - 1)), trackPoints.length - 1);
    var rx = padL + pct * drawW;
    var ry = padTop + (1 - (elevs[idx] - minE) / range) * drawH;

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(rx, padTop);
    ctx.lineTo(rx, h - padBot);
    ctx.strokeStyle = 'rgba(34,197,94,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dot
    ctx.beginPath();
    ctx.arc(rx, ry, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current elevation label
    var curEle = Math.round(elevs[idx]);
    var elevEl = document.getElementById('elev-current');
    if (elevEl) elevEl.textContent = curEle + 'm at ' + runnerKm.toFixed(1) + 'km';
  }

  window._elevData = { elevs: elevs, minE: minE, maxE: maxE, range: range, padTop: padTop, padBot: padBot, padL: padL, drawW: drawW, drawH: drawH };
}

function drawElevationMarker(km) {
  drawElevationProfile(km);
}

// ─── Update stats display ───
function updateStats(state) {
  document.getElementById('stat-distance').innerHTML = (state.km_done || 0) + '<span class="stat-unit">km</span>';
  document.getElementById('stat-progress').innerHTML = (state.progress_pct || 0) + '<span class="stat-unit">%</span>';
  document.getElementById('progress-fill').style.width = (state.progress_pct || 0) + '%';
  document.getElementById('progress-end').textContent = totalKm.toFixed(1) + ' km';

  if (state.current_pace) {
    document.getElementById('stat-pace').innerHTML = state.current_pace + '<span class="stat-unit">min/km</span>';
  } else {
    document.getElementById('stat-pace').innerHTML = '&mdash;<span class="stat-unit">min/km</span>';
  }
  if (state.avg_pace) {
    document.getElementById('stat-avg-pace').innerHTML = state.avg_pace + '<span class="stat-unit">min/km</span>';
  } else {
    document.getElementById('stat-avg-pace').innerHTML = '&mdash;<span class="stat-unit">min/km</span>';
  }

  if (state.last_seen_sec !== null && state.last_seen_sec !== undefined) {
    const sec = state.last_seen_sec;
    if (sec < 60) {
      document.getElementById('stat-last-seen').innerHTML = Math.round(sec) + 's<span class="stat-unit">ago</span>';
      document.getElementById('stat-last-seen').className = 'stat-value green';
    } else {
      const min = Math.floor(sec / 60);
      document.getElementById('stat-last-seen').innerHTML = min + '<span class="stat-unit">min ago</span>';
      document.getElementById('stat-last-seen').className = sec > 300 ? 'stat-value red' : 'stat-value yellow';
    }
  } else {
    document.getElementById('stat-last-seen').innerHTML = '&mdash;';
    document.getElementById('stat-last-seen').className = 'stat-value muted';
  }

  if (state.battery !== null && state.battery !== undefined) {
    const pct = Math.round(state.battery * 100);
    let color = 'var(--green)';
    if (pct < 30) color = 'var(--red)';
    else if (pct < 50) color = 'var(--yellow)';
    document.getElementById('stat-battery').innerHTML = pct + '<span class="stat-unit">%</span>';
    document.getElementById('stat-battery').style.color = color;
  } else {
    document.getElementById('stat-battery').innerHTML = '&mdash;';
    document.getElementById('stat-battery').style.color = '';
  }

  if (state.tracking && state.position) {
    document.getElementById('runner-info-bar').style.display = 'flex';
    document.getElementById('runner-km').textContent = state.km_done + ' km / ' + totalKm.toFixed(1) + ' km';
    document.getElementById('runner-meta').textContent = state.current_pace
      ? 'Ben | ' + state.current_pace + ' min/km | ' + state.progress_pct + '%'
      : 'Ben | ' + state.progress_pct + '% done';
  }

  if (state.next_station) {
    document.getElementById('next-station-name').textContent = state.next_station.name;
    if (state.eta_next_h) {
      const eta = state.eta_next_h;
      let etaStr;
      if (eta < 1) etaStr = Math.round(eta * 60) + ' min';
      else etaStr = eta.toFixed(1) + ' h';
      document.getElementById('next-station-eta').textContent = state.next_station.total_km.toFixed(1) + ' km | ETA ' + etaStr;
    } else {
      document.getElementById('next-station-eta').textContent = state.next_station.total_km.toFixed(1) + ' km away';
    }
  } else {
    document.getElementById('next-station-name').textContent = 'No stations ahead';
    document.getElementById('next-station-eta').textContent = '';
  }

  const dot = document.getElementById('race-status-dot');
  const text = document.getElementById('race-status-text');
  if (state.is_off_route) {
    dot.className = 'status-dot';
    dot.style.background = '#f97316';
    dot.style.boxShadow = '0 0 8px rgba(249,115,22,0.4)';
    text.textContent = 'Off Course';
  } else if (state.is_stopped) {
    dot.className = 'status-dot stopped';
    dot.style.background = '';
    dot.style.boxShadow = '';
    text.textContent = 'Stopped';
  } else if (state.tracking) {
    dot.className = 'status-dot live';
    dot.style.background = '';
    dot.style.boxShadow = '';
    text.textContent = 'Tracking';
  } else {
    dot.className = 'status-dot waiting';
    dot.style.background = '';
    dot.style.boxShadow = '';
    text.textContent = 'Waiting';
  }
}

// ─── Build aid station table ───
function buildAidTable(state) {
  const tbody = document.getElementById('aid-station-body');
  tbody.innerHTML = '';
  const checkins = state.aid_checkins || {};
  const currentKm = state.km_done || 0;

  aidStations.forEach((st, i) => {
    const tr = document.createElement('tr');
    const isPassed = currentKm > st.total_km + 0.2;
    if (isPassed) tr.classList.add('passed');
    if (st.cutoff) tr.classList.add('cutoff-row');

    let typeClass = 'type-aid';
    let typeLabel = 'A';
    if (st.type === 'start') { typeClass = 'type-start'; typeLabel = 'S'; }
    else if (st.type === 'finish') { typeClass = 'type-finish'; typeLabel = 'F'; }
    else if (st.type === 'tp') { typeClass = 'type-tp'; typeLabel = 'T'; }

    const checkin = checkins[String(i)];
    const checkinBadge = checkin ? '<span class="checkin-badge">AUTO</span>' : '';

    tr.innerHTML =
      '<td><span class="station-type ' + typeClass + '">' + typeLabel + '</span></td>' +
      '<td>' + st.short + checkinBadge + '</td>' +
      '<td>' + st.total_km.toFixed(1) + '</td>' +
      '<td>' + st.arrival + '</td>' +
      '<td>' + (checkin ? formatCheckinTime(checkin) : '&mdash;') + '</td>' +
      '<td>' + (st.cutoff || '&mdash;') + '</td>';
    tbody.appendChild(tr);
  });
}

function formatCheckinTime(checkin) {
  if (checkin.server_ts) {
    const d = new Date(checkin.server_ts * 1000);
    return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  }
  if (checkin.arrival_time) {
    const d = new Date(checkin.arrival_time);
    if (!isNaN(d)) return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    return checkin.arrival_time;
  }
  return '\u2713';
}

// ─── Alerts ───
function addAlert(alert) {
  const list = document.getElementById('alert-list');
  const noAlerts = list.querySelector('.no-alerts');
  if (noAlerts) noAlerts.remove();

  const div = document.createElement('div');
  let cls = 'alert-info';
  if (alert.type === 'stopped') cls = 'alert-stopped';
  else if (alert.type === 'movement_resumed') cls = 'alert-movement';
  else if (alert.type === 'manual_checkin') cls = 'alert-info';
  else if (alert.type === 'aid_station') cls = 'alert-info';
  else if (alert.type === 'off_course') cls = 'alert-warning';
  else if (alert.type === 'race_start') cls = 'alert-info';

  div.className = 'alert-item ' + cls;
  const time = alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
  div.innerHTML = '<span>' + alert.message + '</span><span class="alert-time">' + time + '</span>';
  list.insertBefore(div, list.firstChild);

  if (alert.type === 'stopped') playAlertSound();
}

function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

function clearAlerts() {
  fetch('/api/clear_alerts', { method: 'POST' });
  document.getElementById('alert-list').innerHTML = '<div class="no-alerts">No alerts yet</div>';
  lastAlertId = 0;
}

// ─── Polling: fetch status every 5 seconds ───
function pollStatus() {
  fetch('/api/status')
    .then(r => r.json())
    .then(state => {
      updateStats(state);
      buildAidTable(state);
      if (state.tracking && state.position) {
        window._recentPositions = state.recent_positions || window._recentPositions || [];
        updateRunnerPosition(state.position.lat, state.position.lon, state.km_done);
      }
      // Show connection OK
      document.getElementById('conn-dot').className = 'conn-dot';
      document.getElementById('conn-text').textContent = 'Connected';

      // Off-course detection
      document.getElementById('off-course-banner').style.display = state.is_off_route ? 'block' : 'none';
      if (state.is_off_route && !window._wasOffRoute) {
        window._wasOffRoute = true;
        addAlert({type: 'off_course', message: 'Ben is off the route — GPS is not near the trail', timestamp: new Date().toISOString()});
        // Change runner marker to orange
        if (runnerMarker) {
          runnerMarker.setIcon(L.divIcon({
            className: 'runner-marker',
            html: '<div style="position:relative;"><div class="runner-marker-pulse" style="background:#f97316;"></div><div style="width:16px;height:16px;border-radius:50%;background:#f97316;border:3px solid #fff;box-shadow:0 0 12px rgba(249,115,22,0.6);position:relative;z-index:1;"></div></div>',
            iconSize: [16, 16], iconAnchor: [8, 8],
          }));
        }
      } else if (!state.is_off_route && window._wasOffRoute) {
        window._wasOffRoute = false;
        addAlert({type: 'movement_resumed', message: 'Ben is back on the route', timestamp: new Date().toISOString()});
        // Change runner marker back to green
        if (runnerMarker) {
          runnerMarker.setIcon(L.divIcon({
            className: 'runner-marker',
            html: '<div style="position:relative;"><div class="runner-marker-pulse"></div><div style="width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 0 12px rgba(34,197,94,0.6);position:relative;z-index:1;"></div></div>',
            iconSize: [16, 16], iconAnchor: [8, 8],
          }));
        }
      }
    })
    .catch(err => {
      console.error('Status poll failed:', err);
      document.getElementById('conn-dot').className = 'conn-dot offline';
      document.getElementById('conn-text').textContent = 'Reconnecting...';
    });
}

function pollAlerts() {
  fetch('/api/alerts?since=' + lastAlertId)
    .then(r => r.json())
    .then(data => {
      data.alerts.forEach(a => {
        addAlert(a);
        lastAlertId = Math.max(lastAlertId, a.id);
      });
    })
    .catch(err => {});
}

// ─── Init ───
initMap();
loadRoute();
pollStatus();
pollAlerts();

// Poll every 5 seconds
setInterval(pollStatus, 2000);
setInterval(pollAlerts, 10000);

function toggleFollow() {
  autoFollow = !autoFollow;
}

// ─── Pop out tracker page (breaks out of iframe for geolocation) ───
function popOutTracker() {
  // Get the full URL of this app
  var trackerUrl = window.location.origin + '/tracker';
  // Open in a new top-level window — geolocation will work there
  var w = window.open(trackerUrl, '_blank');
  if (!w || w.closed || typeof w.closed === 'undefined') {
    // Popup blocked — show instructions
    alert('Popup was blocked. Please:\n\n1. Copy this URL:\n' + trackerUrl + '\n\n2. Open a new Safari tab\n3. Paste the URL and go\n\n4. Tap Start Tracking');
  }
}
