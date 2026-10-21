"""
UTCT 100km Live Tracker — Flask Backend
Receives GPS pings from the runner's phone, serves a live dashboard
to the crew via polling.
"""

import os
import json
import time
import math
from datetime import datetime
from collections import deque

from flask import Flask, render_template, request, jsonify

app = Flask(__name__, static_folder='static', static_url_path='/static')

# Allow geolocation inside iframes — needed for the tracker page
@app.after_request
def set_permissions_policy(resp):
    resp.headers['Permissions-Policy'] = 'geolocation=(self), camera=(), microphone=()'
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

# ─── Load route data ──────────────────────────────────────────────────
with open(os.path.join(os.path.dirname(__file__), 'route_data.json')) as f:
    ROUTE = json.load(f)

TRACK_POINTS = ROUTE['track_points']
AID_STATIONS = ROUTE['aid_stations']
TOTAL_KM = ROUTE['total_km']

# ─── In-memory state ──────────────────────────────────────────────────
MAX_POSITIONS = 5000
positions = deque(maxlen=MAX_POSITIONS)
alerts = deque(maxlen=200)
aid_station_checkins = {}
race_started = False
race_start_time = None
last_route_idx = 0  # track last matched route index for forward-progressing match

# Stopped-movement tracking
STOPPED_THRESHOLD_SEC = 300  # 5 minutes
last_movement_time = None
is_stopped = False

# Track the last alert we sent so viewers can poll for "new" alerts
alert_counter = 0


# ─── Helper functions ─────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def match_to_route(lat, lon, last_idx=0):
    """Find the nearest track point to (lat, lon), searching forward from last_idx.

    This is a forward-progressing match: it only searches a window around the
    last known position (20 points back, 150 points forward), so the km
    never jumps backwards or ahead to a physically-close but route-distant point.

    On the first ping (last_idx=0) it searches the first 200 points to find
    the start. After that, it follows the runner forward along the route.
    """
    n = len(TRACK_POINTS)
    search_start = max(0, last_idx - 20)
    search_end = min(n, last_idx + 150)

    best_idx = last_idx
    best_dist = float('inf')
    for i in range(search_start, search_end):
        pt = TRACK_POINTS[i]
        d = haversine(lat, lon, pt['lat'], pt['lon'])
        if d < best_dist:
            best_dist = d
            best_idx = i

    return TRACK_POINTS[best_idx]['km'], best_dist, best_idx


def find_next_aid_station(current_km):
    for i, st in enumerate(AID_STATIONS):
        if st['total_km'] > current_km + 0.1:
            return st, i
    return None, None


def check_aid_station_proximity(lat, lon):
    for i, st in enumerate(AID_STATIONS):
        if 'lat' not in st:
            continue
        d = haversine(lat, lon, st['lat'], st['lon'])
        if d < 250:
            return i, st, d
    return None, None, None


def add_alert(alert_type, message, **extra):
    global alert_counter
    alert_counter += 1
    alert = {
        'id': alert_counter,
        'type': alert_type,
        'message': message,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'server_ts': time.time(),
    }
    alert.update(extra)
    alerts.append(alert)


def get_state():
    """Build the current state snapshot for API responses."""
    latest = positions[-1] if positions else None
    if not latest:
        return {
            'tracking': False,
            'race_started': race_started,
            'race_start_time': race_start_time,
            'total_km': TOTAL_KM,
            'position': None,
            'km_done': 0,
            'km_remaining': TOTAL_KM,
            'progress_pct': 0,
            'current_pace': None,
            'avg_pace': None,
            'projected_finish_h': None,
            'next_station': None,
            'eta_next_h': None,
            'last_seen_sec': None,
            'is_stopped': False,
            'stopped_duration_sec': None,
            'battery': None,
            'gps_accuracy': None,
            'aid_stations': AID_STATIONS,
            'aid_checkins': {str(k): v for k, v in aid_station_checkins.items()},
            'recent_positions': [],
            'alert_count': alert_counter,
        }

    km_done = latest.get('route_km', 0)
    km_remaining = TOTAL_KM - km_done
    pct = (km_done / TOTAL_KM * 100) if TOTAL_KM > 0 else 0

    now = time.time()
    recent_pings = [p for p in positions if now - p['server_ts'] < 120]
    current_pace = None
    if len(recent_pings) >= 2:
        first = recent_pings[0]
        last_p = recent_pings[-1]
        dt = last_p['server_ts'] - first['server_ts']
        dk = last_p.get('route_km', 0) - first.get('route_km', 0)
        if dt > 0 and dk > 0:
            current_pace = (dt / 60) / dk

    avg_pace = None
    if race_start_time and positions:
        elapsed_h = (now - race_start_time) / 3600
        if elapsed_h > 0 and km_done > 0:
            avg_pace = (elapsed_h * 60) / km_done

    projected_finish = None
    if avg_pace and avg_pace > 0:
        remaining_h = km_remaining / (60 / avg_pace)
        projected_finish = remaining_h

    next_station, _ = find_next_aid_station(km_done)
    eta_next = None
    if next_station and current_pace:
        dist_to_next = next_station['total_km'] - km_done
        if dist_to_next > 0:
            eta_next = (dist_to_next * current_pace) / 60

    last_seen_sec = now - latest['server_ts']

    stopped_duration = None
    if is_stopped and last_movement_time:
        stopped_duration = now - last_movement_time

    return {
        'tracking': True,
        'race_started': race_started,
        'race_start_time': race_start_time,
        'total_km': TOTAL_KM,
        'position': latest,
        'km_done': round(km_done, 2),
        'km_remaining': round(km_remaining, 2),
        'progress_pct': round(pct, 1),
        'current_pace': round(current_pace, 2) if current_pace else None,
        'avg_pace': round(avg_pace, 2) if avg_pace else None,
        'projected_finish_h': round(projected_finish, 2) if projected_finish else None,
        'next_station': next_station,
        'eta_next_h': round(eta_next, 2) if eta_next else None,
        'last_seen_sec': round(last_seen_sec, 1),
        'is_stopped': is_stopped,
        'stopped_duration_sec': round(stopped_duration, 1) if stopped_duration else None,
        'battery': latest.get('battery'),
        'gps_accuracy': latest.get('accuracy'),
        'is_off_route': latest.get('is_off_route', False),
        'aid_stations': AID_STATIONS,
        'aid_checkins': {str(k): v for k, v in aid_station_checkins.items()},
        'recent_positions': [
                {'lat': p['lat'], 'lon': p['lon'], 'ts': p['server_ts']}
            for p in list(positions)[-50:]
        ],
        'alert_count': alert_counter,
    }


# ─── Routes: Pages ────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('viewer.html')

@app.route('/tracker')
def tracker():
    return render_template('tracker.html')


# ─── Routes: API ──────────────────────────────────────────────────────

@app.route('/api/route')
def api_route():
    """Return the full route data (track points + aid stations + metadata)."""
    return jsonify(ROUTE)


@app.route('/api/ping', methods=['POST'])
def receive_ping():
    """Receive a GPS ping from the runner's phone."""
    global race_started, race_start_time, last_movement_time, is_stopped

    data = request.get_json()
    if not data:
        return jsonify({'error': 'no data'}), 400

    lat = data.get('lat')
    lon = data.get('lon')
    accuracy = data.get('accuracy')
    battery = data.get('battery')
    speed = data.get('speed')
    client_ts = data.get('timestamp')
    server_ts = time.time()

    if lat is None or lon is None:
        return jsonify({'error': 'missing lat/lon'}), 400

    global last_route_idx
    route_km, route_dist, route_idx = match_to_route(lat, lon, last_route_idx)

    # ── Off-route detection ──
    # If the GPS is more than 500m from the route line, the runner is not on
    # the trail. Don't update km or trigger check-ins — just show the raw
    # position on the map. This prevents false km accumulation when testing
    # away from the route or if the runner takes a detour.
    OFF_ROUTE_THRESHOLD = 500  # meters

    if route_dist > OFF_ROUTE_THRESHOLD:
        # Runner is off-route — keep previous km, don't advance
        if len(positions) > 0:
            route_km = positions[-1].get('route_km', 0)
            route_idx = positions[-1].get('route_idx', 0)
        else:
            # First ping and already off-route — start at 0
            route_km = 0
            route_idx = 0
    elif len(positions) > 0 and route_km < positions[-1].get('route_km', 0):
        # On-route but match is behind us — keep previous position (never go backwards)
        route_km = positions[-1]['route_km']
        route_idx = positions[-1]['route_idx']
        route_dist = positions[-1]['route_match_dist']
    else:
        # On-route and moving forward — advance
        last_route_idx = route_idx

    # Auto-start race on first ping
    if not race_started:
        race_started = True
        race_start_time = server_ts
        add_alert('race_start', 'Race started — Ben is tracking')

    # ── Auto check-in logic ──
    # ONLY log "arrived" when Ben's GPS is physically within 200m of a station.
    # This only works when the runner is actually on the trail (within 500m of route).
    # 250m radius accounts for GPS drift on mountain trails.

    if route_dist <= OFF_ROUTE_THRESHOLD:
        station_idx, station, dist = check_aid_station_proximity(lat, lon)
        if station_idx is not None and station_idx not in aid_station_checkins:
            aid_station_checkins[station_idx] = {
                'arrival_time': datetime.utcnow().isoformat() + 'Z',
                'server_ts': server_ts,
                'station': station['name'],
            }
            add_alert('aid_station', f"Ben arrived at {station['name']} (km {station['total_km']:.1f})")

    # Movement detection
    if len(positions) > 0:
        prev = positions[-1]
        moved = haversine(lat, lon, prev['lat'], prev['lon'])
        if moved > 8:
            old_last_movement = last_movement_time
            last_movement_time = server_ts
            if is_stopped:
                is_stopped = False
                stopped_dur = int((server_ts - old_last_movement) / 60) if old_last_movement else 0
                add_alert('movement_resumed', f"Ben is moving again after {stopped_dur} min stopped")

    if last_movement_time is None:
        last_movement_time = server_ts

    # Check stopped threshold
    if not is_stopped and last_movement_time and (server_ts - last_movement_time) > STOPPED_THRESHOLD_SEC:
        is_stopped = True
        duration = int((server_ts - last_movement_time) / 60)
        add_alert('stopped', f"No movement for {duration} minutes — Ben may be stopped or resting",
                  duration_sec=server_ts - last_movement_time)

    # Store position
    pos = {
        'lat': lat,
        'lon': lon,
        'accuracy': accuracy,
        'battery': battery,
        'speed': speed,
        'route_km': route_km,
        'route_match_dist': route_dist,
        'route_idx': route_idx,
        'is_off_route': route_dist > OFF_ROUTE_THRESHOLD,
        'client_ts': client_ts,
        'server_ts': server_ts,
    }
    positions.append(pos)

    return jsonify({'ok': True, 'route_km': round(route_km, 2)})


@app.route('/api/status')
def api_status():
    return jsonify(get_state())


@app.route('/api/manual_checkin', methods=['POST'])
def manual_checkin():
    data = request.get_json()
    station_idx = data.get('station_index')
    if station_idx is None:
        return jsonify({'error': 'missing station_index'}), 400

    station_idx = int(station_idx)
    if station_idx < 0 or station_idx >= len(AID_STATIONS):
        return jsonify({'error': 'invalid station'}), 400

    station = AID_STATIONS[station_idx]
    now_ts = time.time()
    entry = {
        'arrival_time': data.get('time', datetime.utcnow().isoformat() + 'Z'),
        'server_ts': now_ts,
        'station': station['name'],
        'manual': True,
    }
    aid_station_checkins[station_idx] = entry
    add_alert('manual_checkin', f"Manual check-in: {station['name']}")
    return jsonify({'ok': True})


@app.route('/api/alerts')
def api_alerts():
    since = request.args.get('since', 0, type=int)
    recent = [a for a in alerts if a['id'] > since]
    return jsonify({'alerts': recent, 'total': alert_counter})


@app.route('/api/clear_alerts', methods=['POST'])
def clear_alerts():
    alerts.clear()
    return jsonify({'ok': True})


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'positions': len(positions)})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, threaded=True)
