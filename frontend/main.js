let map, routePolyline, busMarker, userMarker;
let stopsLayer;
let selectedRouteId = null;
let ws = null;
let routesData = [];
let stopsData = [];
// history storage key
const HISTORY_KEY = 'pfHistory';

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function renderFavoritesInline() {
  const favs = JSON.parse(localStorage.getItem('favStops') || '[]');
  const ul = document.getElementById('fav-list-inline');
  if (!ul) return;
  ul.innerHTML = '';
  const stops = Object.fromEntries((routesData.flatMap(r => r.stops)).map(s => [s.id, s]));
  favs.forEach(id => {
    const s = stops[id];
    if (!s) return;
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.name}</span> <span><button data-goto="${s.id}">Go</button> <button data-del="${s.id}">Remove</button></span>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', e => {
    removeFavoriteStop(e.target.getAttribute('data-del'));
    renderFavoritesInline();
  }));
  ul.querySelectorAll('button[data-goto]').forEach(b => b.addEventListener('click', e => {
    const sid = e.target.getAttribute('data-goto');
    const s = (routesData.flatMap(r => r.stops)).find(x => x.id === sid);
    if (s) {
      switchTab('map');
      map.setView([s.lat, s.lon], 15);
    }
  }));
}

function switchTab(tab) {
  document.querySelectorAll('.bottombar button').forEach(b => b.classList.remove('active'));
  document.querySelector(`.bottombar button[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${tab}`).classList.add('active');
}

function showFallbackList(items) {
  const list = document.getElementById('fallback-list');
  list.innerHTML = '';
  items.forEach(it => {
    const div = document.createElement('div');
    div.textContent = `${it.bus} → Arriving in ${it.eta} mins`;
    list.appendChild(div);
  });
  document.getElementById('fallback').classList.remove('hidden');
}

async function loadRoutes() {
  const res = await fetch('/api/getRoutes');
  const data = await res.json();
  routesData = data.routes || [];
  const sel = document.getElementById('route-select');
  sel.innerHTML = '';
  routesData.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id; opt.textContent = `${r.id} - ${r.name}`;
    sel.appendChild(opt);
  });
  if (routesData.length) {
    selectedRouteId = routesData[0].id;
    sel.value = selectedRouteId;
    renderRoute(selectedRouteId);
  }
}

async function loadStops() {
  const res = await fetch('/api/getStops');
  const data = await res.json();
  stopsData = data.stops || [];
  const startSel = document.getElementById('start-select');
  const destSel = document.getElementById('dest-select');
  for (const s of [startSel, destSel]) {
    s.innerHTML = '';
    stopsData.forEach(st => {
      const opt = document.createElement('option');
      opt.value = st.id; opt.textContent = st.name;
      s.appendChild(opt);
    });
  }
}

function setupMap() {
  map = L.map('map');
  const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  });
  tiles.addTo(map);
  tiles.on('tileerror', () => {
    // Fallback text ETA list if tiles fail
    fallbackETA();
  });
  map.setView([12.9716, 77.5946], 13);

  stopsLayer = L.layerGroup().addTo(map);
}

function addStopsMarkers(stops) {
  stopsLayer.clearLayers();
  stops.forEach(s => {
    const m = L.marker([s.lat, s.lon]).addTo(stopsLayer);
    const li = document.createElement('button');
    m.bindPopup(`<b>${s.name}</b><br/><button data-stop="${s.id}" class="fav-btn">★ Save</button>`);
  });

  // Inline quick search on planner
  const quickBtn = document.getElementById('quick-search-btn');
  if (quickBtn) {
    quickBtn.addEventListener('click', async () => {
      const q = document.getElementById('quick-search').value;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.routes && data.routes.length) {
        const rid = data.routes[0].id;
        selectedRouteId = rid;
        document.getElementById('route-select').value = rid;
        renderRoute(rid);
      } else if (data.stops && data.stops.length) {
        const sid = data.stops[0].id;
        const destSel = document.getElementById('dest-select');
        if (destSel) destSel.value = sid;
      }
    });
  }
}

function setBusMarker(lat, lon) {
  if (!busMarker) {
    busMarker = L.marker([lat, lon], { icon: L.icon({
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconSize: [25, 41], iconAnchor: [12, 41]
    })});
    busMarker.addTo(map);
  } else {
    busMarker.setLatLng([lat, lon]);
  }
}

function setUserMarker(lat, lon) {
  if (!userMarker) {
    userMarker = L.circleMarker([lat, lon], { radius: 6, color: '#0ea5e9' }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
  }
}

async function fallbackETA() {
  if (!selectedRouteId) return;
  const busId = `${selectedRouteId}-bus-1`;
  const res = await fetch(`/api/getBusLocation?bus_id=${encodeURIComponent(busId)}`);
  const bus = await res.json();
  const route = routesData.find(r => r.id === selectedRouteId);
  if (!route) return;
  const nextStop = route.stops[(bus.segment_index + 1) % route.stops.length];
  const etaRes = await fetch(`/api/getETA?bus_id=${encodeURIComponent(busId)}&stop_id=${encodeURIComponent(nextStop.id)}`);
  const eta = await etaRes.json();
  showFallbackList([{ bus: bus.bus_id, eta: Math.round((eta.eta_seconds || 0)/60) }]);
}

function connectWS(busId) {
  if (ws) {
    ws.close();
  }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/bus/${busId}`);
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'bus_update' && data.bus) {
        setBusMarker(data.bus.lat, data.bus.lon);
        updateETACard(data.bus, data.next_stop, data);
      }
    } catch {}
  };
}

function updateETACard(bus, nextStop, payload) {
  document.getElementById('eta-card').classList.remove('hidden');
  document.getElementById('eta-bus').textContent = `${bus.route_id} / ${bus.bus_id}`;
  document.getElementById('eta-next-stop').textContent = nextStop.name;
  const mins = payload.eta_seconds != null ? (payload.eta_seconds/60).toFixed(1) : 'N/A';
  document.getElementById('eta-time').textContent = `${mins} min`;
  document.getElementById('eta-speed').textContent = bus.speed_kmph;
  document.getElementById('eta-status').textContent = 'On time';
  const el = document.getElementById('businfo-next');
  if (el) el.textContent = nextStop.name;
}

async function renderRoute(routeId) {
  const route = routesData.find(r => r.id === routeId);
  if (!route) return;

  // Polyline
  const latlngs = route.stops.map(s => [s.lat, s.lon]);
  if (routePolyline) map.removeLayer(routePolyline);
  routePolyline = L.polyline(latlngs, { color: '#0ea5e9' }).addTo(map);
  map.fitBounds(routePolyline.getBounds(), { padding: [20,20] });

  addStopsMarkers(route.stops);

  const busId = `${routeId}-bus-1`;
  connectWS(busId);
}

function nearestStopTo(lat, lon, stops) {
  let best = null, bestD = Infinity;
  stops.forEach(s => {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bestD) { bestD = d; best = s; }
  });
  return best;
}

function setupGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude } = pos.coords;
    setUserMarker(latitude, longitude);
    const route = routesData.find(r => r.id === selectedRouteId);
    if (route) {
      const near = nearestStopTo(latitude, longitude, route.stops);
      if (near) {
        // Optionally highlight nearest stop
      }
    }
  });
}

function setupTabNav() {
  document.querySelectorAll('.bottombar button').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });
}

function setupRouteSelect() {
  document.getElementById('route-select').addEventListener('change', (e) => {
    selectedRouteId = e.target.value;
    renderRoute(selectedRouteId);
  });
}

function setupSearch() {
  document.getElementById('search-btn').addEventListener('click', async () => {
    const q = document.getElementById('search-input').value;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const ul = document.getElementById('search-results');
    ul.innerHTML = '';
    data.routes.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<span>Route: ${r.id} - ${r.name}</span> <button data-route="${r.id}">Track</button>`;
      ul.appendChild(li);
    });
    data.stops.forEach(s => {
      const li = document.createElement('li');
      li.innerHTML = `<span>Stop: ${s.name}</span> <button data-stop="${s.id}">+ Favorite</button>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('button[data-route]').forEach(b => b.addEventListener('click', e => {
      const rid = e.target.getAttribute('data-route');
      selectedRouteId = rid;
      document.getElementById('route-select').value = rid;
      switchTab('map');
      renderRoute(rid);
    }));
    ul.querySelectorAll('button[data-stop]').forEach(b => b.addEventListener('click', e => {
      const sid = e.target.getAttribute('data-stop');
      addFavoriteStop(sid);
      renderFavorites();
    }));
  });
}

function addFavoriteStop(stopId) {
  const favs = JSON.parse(localStorage.getItem('favStops') || '[]');
  if (!favs.includes(stopId)) favs.push(stopId);
  localStorage.setItem('favStops', JSON.stringify(favs));
}

function removeFavoriteStop(stopId) {
  const favs = JSON.parse(localStorage.getItem('favStops') || '[]').filter(s => s !== stopId);
  localStorage.setItem('favStops', JSON.stringify(favs));
}

function renderFavorites() {
  const favs = JSON.parse(localStorage.getItem('favStops') || '[]');
  const ul = document.getElementById('fav-list');
  ul.innerHTML = '';
  const stops = Object.fromEntries((routesData.flatMap(r => r.stops)).map(s => [s.id, s]));
  favs.forEach(id => {
    const s = stops[id];
    if (!s) return;
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.name}</span> <span><button data-goto="${s.id}">Go</button> <button data-del="${s.id}">Remove</button></span>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', e => {
    removeFavoriteStop(e.target.getAttribute('data-del'));
    renderFavorites();
  }));
  ul.querySelectorAll('button[data-goto]').forEach(b => b.addEventListener('click', e => {
    const sid = e.target.getAttribute('data-goto');
    const s = (routesData.flatMap(r => r.stops)).find(x => x.id === sid);
    if (s) {
      switchTab('map');
      map.setView([s.lat, s.lon], 15);
    }
  }));
}

function setupFavButtonsOnMap() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-btn');
    if (!btn) return;
    addFavoriteStop(btn.getAttribute('data-stop'));
    renderFavorites();
    renderFavoritesInline();
  });
}

function setupCenterMe() {
  document.getElementById('center-me').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 15);
      setUserMarker(latitude, longitude);
    });
  });
}

function setupPlanner() {
  const useLoc = document.getElementById('use-location');
  const planBtn = document.getElementById('plan-trip');
  useLoc.addEventListener('click', async () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude, longitude } = pos.coords;
      setUserMarker(latitude, longitude);
      // snap on backend using planTrip without start_stop_id
      const destStopId = document.getElementById('dest-select').value;
      if (!destStopId) return;
      const url = `/api/planTrip?dest_stop_id=${encodeURIComponent(destStopId)}&start_lat=${latitude}&start_lon=${longitude}`;
      const res = await fetch(url);
      const trip = await res.json();
      applyTripResult(trip, true);
    });
  });
  planBtn.addEventListener('click', async () => {
    const startStopId = document.getElementById('start-select').value;
    const destStopId = document.getElementById('dest-select').value;
    if (!startStopId || !destStopId) return;
    const res = await fetch(`/api/planTrip?start_stop_id=${encodeURIComponent(startStopId)}&dest_stop_id=${encodeURIComponent(destStopId)}`);
    const trip = await res.json();
    applyTripResult(trip, false);
  });
}

function formatMinutes(s) {
  if (s == null) return 'N/A';
  return (s/60).toFixed(1) + ' min';
}

function applyTripResult(trip, snappedFromGeo) {
  if (trip.error || trip.detail) {
    alert(trip.error || trip.detail);
    return;
  }
  selectedRouteId = trip.route_id;
  document.getElementById('route-select').value = selectedRouteId;
  renderRoute(selectedRouteId);
  connectWS(trip.bus_id);
  // show card
  const card = document.getElementById('trip-card');
  card.classList.remove('hidden');
  document.getElementById('trip-title').textContent = snappedFromGeo && trip.snapped_start ? `Trip (from ${trip.snapped_start.name})` : 'Trip';
  document.getElementById('trip-bus').textContent = `${trip.route_id} / ${trip.bus_id}`;
  document.getElementById('trip-eta').textContent = formatMinutes(trip.total_eta_s);
  document.getElementById('trip-fare').textContent = trip.fare;
  // convert stop ids to names for display
  const allStops = Object.fromEntries(stopsData.map(s => [s.id, s.name]));
  const pathNames = (trip.path_stop_ids || []).map(id => allStops[id] || id);
  document.getElementById('trip-path').textContent = pathNames.join(' → ');

  // Update info panels
  updateInfoPanels(trip, pathNames);
  // Add to history
  pushHistory({ start: pathNames[0] || '-', dest: pathNames[pathNames.length-1] || '-', ts: Date.now() });
  renderHistory();
}

function updateInfoPanels(trip, pathNames) {
  const route = routesData.find(r => r.id === trip.route_id);
  document.getElementById('info-bus').textContent = route ? route.name : trip.bus_id;
  document.getElementById('info-price').textContent = trip.fare;
  const ol = document.getElementById('info-stops');
  ol.innerHTML = '';
  pathNames.forEach(n => {
    const li = document.createElement('li');
    li.textContent = n;
    ol.appendChild(li);
  });

  // Fill Buses Info (bus id, count, fare, next stop handled by ws, traffic simulated)
  document.getElementById('businfo-id').textContent = trip.bus_id;
  document.getElementById('businfo-fare').textContent = trip.fare;
  // number of buses
  fetch('/api/getBusLocation').then(r=>r.json()).then(d => {
    const count = (d.buses && d.buses.length) || 1;
    document.getElementById('businfo-count').textContent = count;
  });
  // simple traffic indicator
  const statuses = ['Clear', 'Normal', 'Moderate', 'Heavy'];
  document.getElementById('businfo-traffic').textContent = statuses[(Date.now()/5000|0)%statuses.length];
}

// History logic
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function writeHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-10))); // keep last 10
}
function pushHistory(entry) {
  const list = readHistory();
  list.push(entry);
  writeHistory(list);
}
function renderHistory() {
  const ul = document.getElementById('history-list');
  ul.innerHTML = '';
  readHistory().slice().reverse().forEach(h => {
    const li = document.createElement('li');
    const d = new Date(h.ts);
    li.innerHTML = `<span>${h.start} → ${h.dest}</span><span style="color:#64748b">${d.toLocaleTimeString()}</span>`;
    ul.appendChild(li);
  });
}

// Tabs for Stops panel
function setupStopsTabs() {
  const tabs = document.querySelectorAll('.stops-panel .tab');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const name = t.dataset.tab;
    document.getElementById('tab-history').classList.toggle('hidden', name !== 'history');
    document.getElementById('tab-favorites').classList.toggle('hidden', name !== 'favorites');
  }));
}

// Profile review send
function setupProfile() {
  // load existing
  const data = JSON.parse(localStorage.getItem('pfProfile') || '{}');
  const $ = id => document.getElementById(id);
  if ($('pf-username')) $('pf-username').value = data.username || '';
  if ($('pf-email')) $('pf-email').value = data.email || '';
  if ($('pf-photo')) $('pf-photo').value = data.photo || '';
  if ($('pf-age')) $('pf-age').value = data.age || '';
  if ($('pf-id')) $('pf-id').value = data.idnum || '';
  updatePhotoPreview();

  const save = document.getElementById('pf-save');
  if (save) save.addEventListener('click', () => {
    const profile = {
      username: $('pf-username').value,
      email: $('pf-email').value,
      photo: $('pf-photo').value,
      age: $('pf-age').value,
      idnum: $('pf-id').value,
    };
    localStorage.setItem('pfProfile', JSON.stringify(profile));
    updatePhotoPreview();
    alert('Profile saved');
  });

  const photo = document.getElementById('pf-photo');
  if (photo) photo.addEventListener('input', updatePhotoPreview);

  function updatePhotoPreview() {
    const src = ($('pf-photo') && $('pf-photo').value) || '';
    const img = $('pf-photo-preview');
    if (img) img.src = src || '';
  }
}

window.addEventListener('load', async () => {
  setupMap();
  setupTabNav();
  setupRouteSelect();
  setupSearch();
  setupGeolocation();
  setupFavButtonsOnMap();
  setupCenterMe();
  setupPlanner();
  setupProfile();
  setupStopsTabs();
  // Splash show for a moment
  const splash = document.getElementById('splash');
  await loadRoutes();
  await loadStops();
  setTimeout(() => splash && (splash.style.display = 'none'), 1200);
  renderFavorites();
  renderFavoritesInline();
  renderHistory();
});
