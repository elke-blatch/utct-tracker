"""
Simulates a runner sending GPS pings along the UTCT route.
Sends pings every 2 seconds, walking through the first ~15 km of the route.

Usage:
  python3 simulate_runner.py

Point this at the deployed app URL or a local instance.
"""

import json
import time
import math
import sys

# Load route data
with open('route_data.json') as f:
    route = json.load(f)

points = route['track_points']
stations = route['aid_stations']

print(f"Route: {route['total_km']:.1f} km, {len(points)} track points")
print(f"Aid stations: {len(stations)}")
print()

# Simulate: pick every Nth point to simulate running at ~6 min/km
# Each ping = 2 seconds, covering ~33m per ping (6 min/km = 10 km/h = 2.78 m/s)
STEP = 2  # skip every other point to simulate ~30m movement
PING_INTERVAL = 2  # seconds

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2 * R * math.asin(math.sqrt(a))

# Track which stations we've passed
passed_stations = set()

print("Simulating runner along first 15 km of route...")
print("Send these pings to the deployed app using curl, or run locally.")
print()

# Generate curl commands for the first 30 pings (covering ~1 km)
for i in range(0, min(60, len(points)), STEP):
    pt = points[i]
    km = pt['km']
    
    # Check if we passed any stations
    for j, st in enumerate(stations):
        if j not in passed_stations and km >= st['total_km'] - 0.2:
            passed_stations.add(j)
            print(f"  >>> PASSED STATION: {st['name']} (km {st['total_km']:.1f})")
    
    # Build the ping data
    ping_data = {
        "lat": pt['lat'],
        "lon": pt['lon'],
        "accuracy": 15,
        "battery": 0.85,
        "speed": 2.78,
        "timestamp": int(time.time() * 1000)
    }
    
    if i == 0:
        print(f"  START: lat={pt['lat']:.6f}, lon={pt['lon']:.6f}, km={km:.2f}")
    
    # Only show every 10th ping to keep output manageable
    if i % 20 == 0:
        print(f"  Ping {i//STEP:3d}: lat={pt['lat']:.6f}, lon={pt['lon']:.6f}, km={km:.2f}")

print(f"\n... total simulated pings: {min(60, len(points))//STEP}")
print(f"Stations passed: {len(passed_stations)}")
print()

# Print curl commands for testing the deployed app
print("=== CURL COMMANDS TO TEST DEPLOYED APP ===")
print("Send a single ping:")
print(f'curl -X POST https://YOUR_APP_URL/api/ping -H "Content-Type: application/json" -d \'{{"lat": {points[0]["lat"]}, "lon": {points[0]["lon"]}, "accuracy": 15, "battery": 0.85}}\'')
print()
print("Check status:")
print('curl https://YOUR_APP_URL/api/status | python3 -m json.tool')
print()

# For local testing, print the first 5 pings as Python code
print("=== LOCAL TEST: Run the app and send pings ===")
print("""
# In one terminal:
cd /workspace/data/utct-tracker && python3 app.py

# In another terminal, send pings:
""")
for i in range(0, 10, 2):
    pt = points[i]
    print(f'curl -s -X POST http://localhost:8080/api/ping -H "Content-Type: application/json" -d \'{{"lat": {pt["lat"]}, "lon": {pt["lon"]}, "accuracy": 15, "battery": 0.85}}\' && echo ""')

