import asyncio
import json
import math
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import contextlib

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ----------- Simple Haversine distance (meters) -----------
EARTH_RADIUS_M = 6371000.0

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_M * c

# ----------- Data Loading -----------
BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
ROUTES_FILE = DATA_DIR / "routes.json"

with open(ROUTES_FILE, "r", encoding="utf-8") as f:
    ROUTES = json.load(f)

# Build quick lookup maps
STOPS_BY_ID: Dict[str, Dict[str, Any]] = {}
ROUTES_BY_ID: Dict[str, Dict[str, Any]] = {}
STOP_TO_ROUTES: Dict[str, List[str]] = {}
for route in ROUTES.get("routes", []):
    ROUTES_BY_ID[route["id"]] = route
    for stop in route.get("stops", []):
        STOPS_BY_ID[stop["id"]] = stop
        STOP_TO_ROUTES.setdefault(stop["id"], []).append(route["id"])

# ----------- Bus Simulator -----------
# We simulate one or more buses traveling along their route's sequence of stops.
# Each bus will move from stop[i] to stop[i+1] at a given speed.

class BusState:
    def __init__(self, bus_id: str, route_id: str, speed_kmph: float = 20.0):
        self.bus_id = bus_id
        self.route_id = route_id
        self.speed_kmph = speed_kmph  # configurable per bus
        self.segment_index = 0  # index between stops: segment from stops[i] -> stops[i+1]
        self.progress_m = 0.0  # meters progressed along current segment
        self.lat = None  # type: Optional[float]
        self.lon = None  # type: Optional[float]
        self.last_update_ts = time.time()
        # Initialize at first stop
        route = ROUTES_BY_ID[route_id]
        if len(route["stops"]) >= 1:
            self.lat = route["stops"][0]["lat"]
            self.lon = route["stops"][0]["lon"]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "bus_id": self.bus_id,
            "route_id": self.route_id,
            "lat": self.lat,
            "lon": self.lon,
            "speed_kmph": self.speed_kmph,
            "segment_index": self.segment_index,
            "last_update": datetime.utcfromtimestamp(self.last_update_ts).isoformat() + "Z",
        }

# Initialize simulated buses
# For prototype: one bus per route
BUSES: Dict[str, BusState] = {}
for route in ROUTES.get("routes", []):
    bus_id = f"{route['id']}-bus-1"
    BUSES[bus_id] = BusState(bus_id=bus_id, route_id=route["id"], speed_kmph=22.0)


async def simulator_loop():
    """Background task to move all buses along their routes in real time."""
    while True:
        start = time.time()
        for bus in BUSES.values():
            route = ROUTES_BY_ID.get(bus.route_id)
            stops = route.get("stops", [])
            if len(stops) < 2:
                continue

            # Compute segment endpoints
            i = bus.segment_index
            j = (i + 1) % len(stops)
            a = stops[i]
            b = stops[j]
            seg_len_m = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
            # distance moved in this tick
            speed_mps = (bus.speed_kmph * 1000.0) / 3600.0
            dt = 1.0  # seconds per tick
            move = speed_mps * dt

            bus.progress_m += move
            if seg_len_m > 0:
                t = min(bus.progress_m / seg_len_m, 1.0)
            else:
                t = 1.0

            # Interpolate position
            bus.lat = a["lat"] + (b["lat"] - a["lat"]) * t
            bus.lon = a["lon"] + (b["lon"] - a["lon"]) * t
            bus.last_update_ts = time.time()

            if bus.progress_m >= seg_len_m:  # move to next segment
                bus.segment_index = j
                bus.progress_m = 0.0

        # Aim ~1 Hz updates
        elapsed = time.time() - start
        await asyncio.sleep(max(0.0, 1.0 - elapsed))


# ----------- ETA Calculation -----------

def route_distance_remaining_m(route_id: str, from_lat: float, from_lon: float, current_segment_index: int, to_stop_id: str) -> float:
    """
    Approximate distance along route from current bus position to a target stop by:
    - remaining part of current segment
    - full segments until the target stop index
    Assumes route is circular (wraps around).
    """
    route = ROUTES_BY_ID[route_id]
    stops = route["stops"]
    n = len(stops)
    # find target stop index
    to_idx = next((idx for idx, s in enumerate(stops) if s["id"] == to_stop_id), None)
    if to_idx is None:
        return float("inf")

    # distance from current position to end of current segment stop
    i = current_segment_index
    j = (i + 1) % n
    seg_remaining = haversine_m(from_lat, from_lon, stops[j]["lat"], stops[j]["lon"]) if n >= 2 else 0.0

    # sum segments from j to to_idx (wrapping)
    total = seg_remaining
    idx = j
    while idx != to_idx:
        a = stops[idx]
        b = stops[(idx + 1) % n]
        total += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        idx = (idx + 1) % n
    return total


def eta_seconds(distance_m: float, speed_kmph: float) -> Optional[int]:
    if speed_kmph <= 0:
        return None
    speed_mps = (speed_kmph * 1000.0) / 3600.0
    return int(distance_m / speed_mps)


def nearest_stop(lat: float, lon: float) -> Tuple[str, Dict[str, Any], float]:
    """Return (stop_id, stop_dict, distance_m) closest to given lat/lon."""
    best_id, best_stop, best_d = None, None, float("inf")
    for sid, s in STOPS_BY_ID.items():
        d = haversine_m(lat, lon, s["lat"], s["lon"])
        if d < best_d:
            best_id, best_stop, best_d = sid, s, d
    return best_id, best_stop, best_d


def route_path_distance_and_stops(route_id: str, from_stop_id: str, to_stop_id: str) -> Tuple[float, List[str]]:
    """Compute distance along route from from_stop to to_stop (wrapping) and return path of stop IDs (inclusive of to_stop)."""
    route = ROUTES_BY_ID[route_id]
    stops = route["stops"]
    n = len(stops)
    idx_from = next((i for i, s in enumerate(stops) if s["id"] == from_stop_id), None)
    idx_to = next((i for i, s in enumerate(stops) if s["id"] == to_stop_id), None)
    if idx_from is None or idx_to is None or n < 2:
        return float("inf"), []
    total = 0.0
    path: List[str] = []
    i = idx_from
    while i != idx_to:
        a = stops[i]
        b = stops[(i + 1) % n]
        total += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        path.append(b["id"])  # accumulate next stop ids
        i = (i + 1) % n
    return total, [from_stop_id] + path


def simple_fare(distance_m: float) -> int:
    """Very simple fare: base 10 + 2 per km (rounded)."""
    base = 10
    per_km = 2
    km = math.ceil(distance_m / 1000.0)
    return int(base + per_km * km)


# ----------- FastAPI App -----------

app = FastAPI(title="Bus Tracker Prototype", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    # Start background simulator
    app.state.sim_task = asyncio.create_task(simulator_loop())


@app.on_event("shutdown")
async def on_shutdown():
    task = getattr(app.state, "sim_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@app.get("/api/getRoutes")
async def get_routes() -> Dict[str, Any]:
    return ROUTES


@app.get("/api/getBusLocation")
async def get_bus_location(bus_id: Optional[str] = Query(None)) -> Any:
    if bus_id:
        bus = BUSES.get(bus_id)
        if not bus:
            raise HTTPException(status_code=404, detail="Bus not found")
        return bus.to_dict()
    return {"buses": [b.to_dict() for b in BUSES.values()]}


@app.get("/api/getETA")
async def get_eta(bus_id: str = Query(...), stop_id: str = Query(...)) -> Dict[str, Any]:
    bus = BUSES.get(bus_id)
    if not bus:
        raise HTTPException(status_code=404, detail="Bus not found")
    if stop_id not in STOPS_BY_ID:
        raise HTTPException(status_code=404, detail="Stop not found")

    dist_m = route_distance_remaining_m(
        route_id=bus.route_id,
        from_lat=bus.lat,
        from_lon=bus.lon,
        current_segment_index=bus.segment_index,
        to_stop_id=stop_id,
    )
    eta_s = eta_seconds(dist_m, bus.speed_kmph)
    return {
        "bus_id": bus_id,
        "stop_id": stop_id,
        "distance_m": int(dist_m),
        "eta_seconds": eta_s,
        "eta_minutes": None if eta_s is None else round(eta_s / 60, 1),
    }


@app.get("/api/search")
async def search(q: str = Query("")) -> Dict[str, Any]:
    ql = q.strip().lower()
    routes = []
    stops = []
    if ql:
        for route in ROUTES.get("routes", []):
            if ql in route["name"].lower() or ql in route["id"].lower():
                routes.append({"id": route["id"], "name": route["name"]})
        for stop in STOPS_BY_ID.values():
            if ql in stop["name"].lower():
                stops.append({"id": stop["id"], "name": stop["name"]})
    return {"routes": routes, "stops": stops}


@app.get("/api/getStops")
async def get_stops() -> Dict[str, Any]:
    return {"stops": list(STOPS_BY_ID.values())}


@app.get("/api/planTrip")
async def plan_trip(
    start_stop_id: Optional[str] = Query(None),
    dest_stop_id: Optional[str] = Query(None),
    start_lat: Optional[float] = Query(None),
    start_lon: Optional[float] = Query(None),
) -> Dict[str, Any]:
    """
    Simple planner for prototype:
    - If start_stop_id missing but start_lat/lon present: snap to nearest stop.
    - If start/dest on same route, choose that route.
    - Pick the simulated bus for that route and compute ETA from current bus state to start stop,
      and from start to destination for travel time. Sum times.
    - Return chosen route, bus, path, distance, ETA, fare.
    """
    if not dest_stop_id:
        raise HTTPException(status_code=400, detail="dest_stop_id is required")
    if dest_stop_id not in STOPS_BY_ID:
        raise HTTPException(status_code=404, detail="Destination stop not found")

    resolved_start_stop_id = start_stop_id
    snapped = None
    if not resolved_start_stop_id:
        if start_lat is None or start_lon is None:
            raise HTTPException(status_code=400, detail="Provide start_stop_id or start_lat/start_lon")
        sid, s, d = nearest_stop(start_lat, start_lon)
        resolved_start_stop_id = sid
        snapped = {"stop_id": sid, "name": s["name"], "distance_m": int(d)}

    if resolved_start_stop_id not in STOPS_BY_ID:
        raise HTTPException(status_code=404, detail="Start stop not found")

    # Find common route (in this dataset, stops are unique; try route containing both)
    candidate_routes = []
    for rid, route in ROUTES_BY_ID.items():
        stop_ids = [s["id"] for s in route["stops"]]
        if resolved_start_stop_id in stop_ids and dest_stop_id in stop_ids:
            candidate_routes.append(rid)
    if not candidate_routes:
        raise HTTPException(status_code=400, detail="No single route connects start and destination in prototype data")

    route_id = candidate_routes[0]
    # Compute passenger travel distance along route
    travel_dist_m, path_stop_ids = route_path_distance_and_stops(route_id, resolved_start_stop_id, dest_stop_id)
    travel_eta_s = eta_seconds(travel_dist_m, 22.0)  # assume typical bus speed

    # Choose bus on that route (we have one simulated bus)
    bus_id = f"{route_id}-bus-1"
    bus = BUSES.get(bus_id)
    if not bus:
        raise HTTPException(status_code=404, detail="No bus available for route")

    # ETA for bus to reach the passenger's start stop
    bus_to_start_m = route_distance_remaining_m(
        route_id=bus.route_id,
        from_lat=bus.lat,
        from_lon=bus.lon,
        current_segment_index=bus.segment_index,
        to_stop_id=resolved_start_stop_id,
    )
    bus_to_start_eta_s = eta_seconds(bus_to_start_m, bus.speed_kmph)

    total_eta_s = None
    if bus_to_start_eta_s is not None and travel_eta_s is not None:
        total_eta_s = bus_to_start_eta_s + travel_eta_s

    fare = simple_fare(travel_dist_m)

    return {
        "route_id": route_id,
        "bus_id": bus_id,
        "start_stop_id": resolved_start_stop_id,
        "dest_stop_id": dest_stop_id,
        "path_stop_ids": path_stop_ids,
        "travel_distance_m": int(travel_dist_m),
        "bus_to_start_distance_m": int(bus_to_start_m),
        "bus_to_start_eta_s": bus_to_start_eta_s,
        "travel_eta_s": travel_eta_s,
        "total_eta_s": total_eta_s,
        "fare": fare,
        "snapped_start": snapped,
    }


# ----------- WebSocket for live updates -----------

@app.websocket("/ws/bus/{bus_id}")
async def ws_bus(websocket: WebSocket, bus_id: str):
    await websocket.accept()
    try:
        while True:
            bus = BUSES.get(bus_id)
            if not bus:
                await websocket.send_json({"error": "Bus not found"})
                await asyncio.sleep(2)
                continue
            # Next stop is end of current segment
            route = ROUTES_BY_ID[bus.route_id]
            stops = route["stops"]
            n = len(stops)
            target_stop = stops[(bus.segment_index + 1) % n]
            dist_m = route_distance_remaining_m(
                route_id=bus.route_id,
                from_lat=bus.lat,
                from_lon=bus.lon,
                current_segment_index=bus.segment_index,
                to_stop_id=target_stop["id"],
            )
            eta_s = eta_seconds(dist_m, bus.speed_kmph)
            await websocket.send_json({
                "type": "bus_update",
                "bus": bus.to_dict(),
                "next_stop": {"id": target_stop["id"], "name": target_stop["name"]},
                "distance_m": int(dist_m),
                "eta_seconds": eta_s,
            })
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        return


# ----------- Static Frontend -----------

# Serve files from frontend directory
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def index():
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"message": "Frontend not found. Make sure the frontend directory exists."}
