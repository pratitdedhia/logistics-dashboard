/* ============================================================
   FleetOS — Logistics & Route Optimization
   B.Tech IT Sem-5 Mini-Project · Vanilla JS · localStorage
   ============================================================
   Stack:
   - Vanilla JS (no framework). One file, organized into modules
     via plain object namespaces: DB, UI, Geo, Router, Views.
   - Leaflet for the map (OpenStreetMap tiles).
   - localStorage as a "fake DB" (honest stand-in for MongoDB/
     Postgres in a real deployment).

   Algorithms inside:
   - Haversine distance (great-circle, in km)
   - Nearest-Neighbor TSP heuristic (O(n^2))
   - 2-opt route improvement (O(n^2) per pass)
   - Brute-force optimal TSP for small n (n! permutations, n<=8)
   - Capacity-aware co-loading (knapsack-style greedy by priority+
     volume-utility, then exact-fit revalidation)

   File is split for readability:
     §1  Utilities                                  (~ line 40)
     §2  Geo / Routing algorithms                   (~ line 110)
     §3  Database (localStorage CRUD)               (~ line 220)
     §4  Seed data                                  (~ line 320)
     §5  UI helpers (toast, modal, render)          (~ line 440)
     §6  Router                                     (~ line 500)
     §7  Views (Dashboard, Trucks, ..., Settings)   (~ line 540)
     §8  Bootstrap                                  (end)
   ============================================================ */


/* ───────────────────────── §1 UTILS ───────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const uid = (prefix = 'id') =>
  prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const fmt = {
  money:  (n, cur = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n || 0),
  number: (n, d = 0)      => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }),
  km:     (n)             => fmt.number(n, 1) + ' km',
  kg:     (n)             => fmt.number(n, 0) + ' kg',
  m3:     (n)             => fmt.number(n, 1) + ' m³',
  date:   (iso)           => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—',
  dateOnly:(iso)          => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// Lightweight assertion utility for built-in self-tests.
function assert(name, cond, detail = '') {
  if (!cond) console.error('TEST FAIL:', name, detail);
  else       console.log('  ✓', name);
}

/* ─── Truck / cargo type compatibility matrix ───
   A truck "carries" a cargo type if it can legally + physically transport it.
   Used by the planner to filter compatible trucks for a selection of orders. */
const TRUCK_TYPES = {
  regular:   { label: 'Regular (Dry van)',  carries: ['general','dry'] },
  freezer:   { label: 'Freezer (−18 °C)',   carries: ['frozen','chilled','general','dry'] },
  chiller:   { label: 'Chiller (2–8 °C)',   carries: ['chilled','general','dry'] },
  container: { label: 'Container (20 ft)',  carries: ['container','general','dry'] },
  tanker:    { label: 'Tanker (Liquid)',    carries: ['liquid'] },
  flatbed:   { label: 'Flatbed / Open',     carries: ['oversize','general','dry'] },
};
const CARGO_TYPES = ['general','dry','chilled','frozen','liquid','container','oversize'];
const truckCarries = (truck, cargoType) =>
  !!(TRUCK_TYPES[truck.truckType || 'regular']?.carries || []).includes(cargoType || 'general');

/* Normalize an order into a list of stops with explicit actions + amounts.
   Backward-compat: a legacy order without .stops is treated as
   [pickup-at-depot, drop-at-customer] using the order's full weight/volume. */
function getOrderStops(o) {
  if (Array.isArray(o.stops) && o.stops.length) {
    return o.stops.map((s, i) => ({
      orderId: o.id, orderNo: o.orderNo, seq: i,
      action: s.action, lat: +s.lat, lng: +s.lng, address: s.address || '',
      weightKg: +s.weightKg || 0, volumeM3: +s.volumeM3 || 0,
      depotId: s.depotId || null,
    }));
  }
  return [
    { orderId: o.id, orderNo: o.orderNo, seq: 0, action: 'pickup',
      lat: o.pickup.lat, lng: o.pickup.lng, address: o.pickup.address,
      weightKg: o.weightKg, volumeM3: o.volumeM3, depotId: o.pickup.depotId || null },
    { orderId: o.id, orderNo: o.orderNo, seq: 1, action: 'drop',
      lat: o.drop.lat,   lng: o.drop.lng,   address: o.drop.address,
      weightKg: o.weightKg, volumeM3: o.volumeM3, depotId: null },
  ];
}

/* Walk a routed path applying +weight on pickup and −weight on drop.
   Returns the running load at each stop and the peak load reached —
   peak (not sum) is what the truck must be able to hold. This is the
   right way to merge orders: a pickup that happens AFTER an earlier
   drop frees up space that can be re-used.                            */
function loadTimeline(path) {
  let curW = 0, curV = 0, peakW = 0, peakV = 0;
  const timeline = path.map((p) => {
    if (p.action === 'pickup') { curW += p.weightKg || 0; curV += p.volumeM3 || 0; }
    else if (p.action === 'drop') { curW = Math.max(0, curW - (p.weightKg||0)); curV = Math.max(0, curV - (p.volumeM3||0)); }
    if (curW > peakW) peakW = curW;
    if (curV > peakV) peakV = curV;
    return { ...p, runningKg: curW, runningM3: curV };
  });
  return { timeline, peakKg: peakW, peakM3: peakV };
}


/* ───────────────────────── §2 GEO / ROUTING ───────────────── */
const Geo = {
  // Haversine great-circle distance (km). Earth radius = 6371 km.
  // d = 2R * asin( sqrt( sin²(Δφ/2) + cosφ1·cosφ2·sin²(Δλ/2) ) )
  haversine(a, b) {
    const R = 6371;
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  // Total path length through an ordered list of points.
  pathLength(points) {
    let d = 0;
    for (let i = 0; i < points.length - 1; i++) d += Geo.haversine(points[i], points[i+1]);
    return d;
  },

  // Nearest-Neighbor heuristic. Start at `start`, always go to the
  // closest unvisited stop. End wherever; the planner appends a
  // return-to-depot leg outside if needed.
  // Time: O(n²). Quality: usually within ~25% of optimal.
  nearestNeighbor(start, stops) {
    const remaining = stops.slice();
    const path = [start];
    let cur = start;
    while (remaining.length) {
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = Geo.haversine(cur, remaining[i]);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      cur = remaining.splice(bestIdx, 1)[0];
      path.push(cur);
    }
    return path;
  },

  // 2-opt improvement: repeatedly reverses sub-segments if it shortens
  // the total. Keeps endpoints fixed. Converges to a local optimum.
  twoOpt(path) {
    const route = path.slice();
    let improved = true, passes = 0;
    while (improved && passes < 50) {
      improved = false; passes++;
      for (let i = 1; i < route.length - 2; i++) {
        for (let j = i + 1; j < route.length - 1; j++) {
          const before = Geo.haversine(route[i-1], route[i]) + Geo.haversine(route[j], route[j+1]);
          const after  = Geo.haversine(route[i-1], route[j]) + Geo.haversine(route[i], route[j+1]);
          if (after + 1e-9 < before) {
            // reverse i..j
            const seg = route.slice(i, j+1).reverse();
            route.splice(i, seg.length, ...seg);
            improved = true;
          }
        }
      }
    }
    return route;
  },

  // Exact TSP via permutations. Use only for very small n (<= 8).
  // n=8 → 40,320 perms; n=10 → 3.6M (too slow in-browser).
  bruteForce(start, stops) {
    if (stops.length === 0) return [start];
    if (stops.length > 8) return null; // too expensive
    let best = null, bestD = Infinity;
    function* perms(arr) {
      if (arr.length <= 1) { yield arr; return; }
      for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0,i).concat(arr.slice(i+1));
        for (const p of perms(rest)) yield [arr[i], ...p];
      }
    }
    for (const p of perms(stops)) {
      const path = [start, ...p];
      const d = Geo.pathLength(path);
      if (d < bestD) { bestD = d; best = path; }
    }
    return best;
  },

  // Main planner: pick the best strategy for the given size.
  optimizeRoute(start, stops, returnToStart = true) {
    if (stops.length === 0) {
      return { path: [start], distanceKm: 0, strategy: 'empty' };
    }
    let path, strategy;
    if (stops.length <= 7) {
      path = Geo.bruteForce(start, stops);
      strategy = 'brute-force (optimal)';
    } else {
      path = Geo.twoOpt(Geo.nearestNeighbor(start, stops));
      strategy = 'nearest-neighbor + 2-opt';
    }
    if (returnToStart) path = [...path, start];
    return { path, distanceKm: Geo.pathLength(path), strategy };
  },

  fuelCost({ distanceKm, mileageKmpl, pricePerLiter }) {
    const liters = distanceKm / Math.max(mileageKmpl, 0.1);
    return { liters, cost: liters * pricePerLiter };
  },
};


/* ───────────────────────── §3 DATABASE ───────────────────── */
const DB_KEY = 'fleetos:v1';

const DB = {
  state: null,

  load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      DB.state = raw ? JSON.parse(raw) : DB.empty();
    } catch (e) {
      console.error('DB.load failed; resetting.', e);
      DB.state = DB.empty();
    }
    return DB.state;
  },
  save() { localStorage.setItem(DB_KEY, JSON.stringify(DB.state)); },
  empty() {
    return {
      trucks: [], drivers: [], depots: [], orders: [], trips: [],
      settings: { fuelPricePerLiter: 95, currency: 'INR', companyName: 'FleetOS Logistics Pvt. Ltd.' },
      createdAt: new Date().toISOString(),
    };
  },

  // Generic CRUD helpers, parametrized by collection name.
  list(coll, filter = () => true) { return DB.state[coll].filter(filter); },
  get(coll, id)        { return DB.state[coll].find(x => x.id === id) || null; },
  insert(coll, doc)    {
    const d = { ...doc, id: doc.id || uid(coll.slice(0,3)), createdAt: doc.createdAt || new Date().toISOString() };
    DB.state[coll].push(d); DB.save(); return d;
  },
  update(coll, id, patch) {
    const i = DB.state[coll].findIndex(x => x.id === id);
    if (i < 0) return null;
    DB.state[coll][i] = { ...DB.state[coll][i], ...patch, updatedAt: new Date().toISOString() };
    DB.save(); return DB.state[coll][i];
  },
  remove(coll, id) {
    DB.state[coll] = DB.state[coll].filter(x => x.id !== id); DB.save();
  },

  reset() { DB.state = DB.empty(); DB.save(); },
  exportJSON() { return JSON.stringify(DB.state, null, 2); },
  importJSON(text) {
    const next = JSON.parse(text);
    if (!next.trucks || !next.orders) throw new Error('Invalid FleetOS backup');
    DB.state = next; DB.save();
  },
};


/* ───────────────────────── §4 SEED DATA ───────────────────── */
// Real Indian city coordinates so the map looks realistic during demo.
const SEED = {
  depots: [
    { name: 'Mumbai Hub (Bhiwandi)',  lat: 19.2967, lng: 73.0631, address: 'Bhiwandi, MH' },
    { name: 'Pune Distribution',      lat: 18.5204, lng: 73.8567, address: 'Hadapsar, Pune' },
    { name: 'Nashik Cross-Dock',      lat: 19.9975, lng: 73.7898, address: 'Nashik, MH' },
  ],
  drivers: [
    { name: 'Ramesh Patil',  phone: '+91 98200 11111', license: 'MH04 20210011', experienceYears: 12, status: 'available' },
    { name: 'Suresh Kumar',  phone: '+91 98200 22222', license: 'MH12 20180023', experienceYears: 8,  status: 'available' },
    { name: 'Vikas Sharma',  phone: '+91 98200 33333', license: 'MH15 20190017', experienceYears: 5,  status: 'available' },
    { name: 'Anil Deshmukh', phone: '+91 98200 44444', license: 'MH04 20170005', experienceYears: 15, status: 'on-leave' },
    { name: 'Mahesh Jadhav', phone: '+91 98200 55555', license: 'MH12 20220045', experienceYears: 3,  status: 'available' },
  ],
  trucks: [
    { regNo: 'MH04-AB-1234', model: 'Tata LPT 1109',          truckType: 'regular',   capacityKg: 6000,  capacityVolumeM3: 18, mileageKmpl: 8,  status: 'available' },
    { regNo: 'MH04-AB-5678', model: 'Ashok Leyland Dost',     truckType: 'chiller',   capacityKg: 1500,  capacityVolumeM3: 6,  mileageKmpl: 14, status: 'available' },
    { regNo: 'MH12-CD-9012', model: 'Eicher Pro 3015',        truckType: 'container', capacityKg: 12000, capacityVolumeM3: 32, mileageKmpl: 6,  status: 'available' },
    { regNo: 'MH15-EF-3456', model: 'Mahindra Bolero Pickup', truckType: 'regular',   capacityKg: 1300,  capacityVolumeM3: 5,  mileageKmpl: 16, status: 'maintenance' },
    { regNo: 'MH04-GH-7890', model: 'Tata Ace Gold',          truckType: 'regular',   capacityKg: 750,   capacityVolumeM3: 3,  mileageKmpl: 22, status: 'available' },
    { regNo: 'MH12-IJ-2468', model: 'Tata Prima 4928 Reefer', truckType: 'freezer',   capacityKg: 9000,  capacityVolumeM3: 26, mileageKmpl: 5,  status: 'available' },
    { regNo: 'MH04-KL-1357', model: 'BharatBenz 1617 Tanker', truckType: 'tanker',    capacityKg: 8000,  capacityVolumeM3: 12, mileageKmpl: 6,  status: 'available' },
  ],
  // Drop locations spread across western Maharashtra.
  drops: [
    { city: 'Thane',         lat: 19.2183, lng: 72.9781 },
    { city: 'Kalyan',        lat: 19.2437, lng: 73.1355 },
    { city: 'Vashi',         lat: 19.0760, lng: 73.0000 },
    { city: 'Panvel',        lat: 18.9894, lng: 73.1175 },
    { city: 'Lonavla',       lat: 18.7546, lng: 73.4062 },
    { city: 'Pimpri',        lat: 18.6298, lng: 73.7997 },
    { city: 'Pune (Camp)',   lat: 18.5089, lng: 73.8779 },
    { city: 'Satara',        lat: 17.6805, lng: 74.0183 },
    { city: 'Kolhapur',      lat: 16.7050, lng: 74.2433 },
    { city: 'Aurangabad',    lat: 19.8762, lng: 75.3433 },
    { city: 'Ahmednagar',    lat: 19.0948, lng: 74.7480 },
    { city: 'Sangamner',     lat: 19.5750, lng: 74.2110 },
  ],
};

function seedDemoData() {
  DB.reset();
  SEED.depots.forEach(d => DB.insert('depots', d));
  SEED.drivers.forEach(d => DB.insert('drivers', d));
  SEED.trucks.forEach(t => DB.insert('trucks', t));

  const depots = DB.list('depots');
  const customers = ['Reliance Retail','DMart Wholesale','BigBasket','Flipkart Hub','Amazon FC','Croma Warehouse','Tata 1mg','Pidilite Industries','Asian Paints','Apollo Tyres','Bajaj Electricals','Havells'];
  const priorities = ['normal','normal','normal','high','urgent'];

  // 18 orders, all from Mumbai depot, drops spread across SEED.drops.
  const mumbai = depots[0];
  for (let i = 0; i < 18; i++) {
    const drop = SEED.drops[i % SEED.drops.length];
    const weight = 200 + Math.floor(Math.random() * 2800);
    const volume = Math.max(0.5, +(weight / 350 + Math.random()).toFixed(1));
    // Cycle through cargo types so the demo shows compatibility filtering.
    const cargoType = ['general','general','general','chilled','frozen','liquid'][i % 6];
    DB.insert('orders', {
      orderNo: 'ORD-' + (1001 + i),
      customerName: customers[i % customers.length],
      customerPhone: '+91 90000 ' + (10000 + i),
      pickup: { lat: mumbai.lat, lng: mumbai.lng, address: mumbai.address, depotId: mumbai.id },
      drop:   { lat: drop.lat,   lng: drop.lng,   address: drop.city + ', MH' },
      weightKg: weight,
      volumeM3: volume,
      cargoType,
      // Default to a 2-stop plan; user can edit and add more pickups/drops.
      stops: [
        { action: 'pickup', lat: mumbai.lat, lng: mumbai.lng, address: mumbai.address, weightKg: weight, volumeM3: volume, depotId: mumbai.id },
        { action: 'drop',   lat: drop.lat,   lng: drop.lng,   address: drop.city + ', MH', weightKg: weight, volumeM3: volume },
      ],
      priority: priorities[Math.floor(Math.random() * priorities.length)],
      scheduledDate: new Date(Date.now() + (i % 5) * 86400000).toISOString(),
      status: 'pending',
    });
  }
}


/* ───────────────────────── §5 UI HELPERS ──────────────────── */
const UI = {
  toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toast-root').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => t.remove(), 2800);
  },

  // bodyHtml may be a string or a function(root) that mounts into root.
  // Returns { close } so the caller can dismiss programmatically.
  modal({ title, bodyHtml, actions = [], size = '' }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal ${size}">
          <div class="modal-head">
            <h2>${title}</h2>
            <button class="modal-close" aria-label="Close">×</button>
          </div>
          <div class="modal-body"></div>
          <div class="modal-actions"></div>
        </div>
      </div>`;
    const body = $('.modal-body', root);
    const acts = $('.modal-actions', root);
    if (typeof bodyHtml === 'function') bodyHtml(body); else body.innerHTML = bodyHtml;
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.variant || '');
      b.textContent = a.label;
      b.onclick = () => a.onClick && a.onClick(close);
      acts.appendChild(b);
    });
    const close = () => root.innerHTML = '';
    $('.modal-close', root).onclick = close;
    $('.modal-backdrop', root).addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) close(); });
    return { close, body };
  },

  confirm(message, onYes) {
    UI.modal({
      title: 'Confirm',
      bodyHtml: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: (c) => c() },
        { label: 'Yes, proceed', variant: 'danger', onClick: (c) => { c(); onYes(); } },
      ],
    });
  },
};


/* ───────────────────────── §6 ROUTER ──────────────────────── */
const Router = {
  current: 'dashboard',
  go(view) {
    Router.current = view;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const v = Views[view];
    if (!v) { $('#view-root').innerHTML = '<div class="empty">View not found.</div>'; return; }
    $('#view-title').textContent = v.title;
    $('#view-sub').textContent   = v.subtitle || '';
    $('#view-root').innerHTML    = '';
    v.render($('#view-root'));
  },
};


/* ───────────────────────── §7 VIEWS ───────────────────────── */
const Views = {};

/* — Dashboard — */
Views.dashboard = {
  title: 'Dashboard',
  subtitle: 'Operational overview',
  render(root) {
    const trucks  = DB.list('trucks');
    const drivers = DB.list('drivers');
    const orders  = DB.list('orders');
    const trips   = DB.list('trips');
    const pending = orders.filter(o => o.status === 'pending');
    const inTrip  = trucks.filter(t => t.status === 'in-trip').length;
    const active  = trips.filter(t => t.status === 'in-progress').length;
    const revenue = trips.reduce((s, t) => s + (t.estimatedCost || 0), 0);
    const utilization = trucks.length ? Math.round((inTrip / trucks.length) * 100) : 0;

    // 7-day trip count for the mini chart.
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      const key = d.toISOString().slice(0,10);
      const count = trips.filter(t => (t.createdAt || '').slice(0,10) === key).length;
      return { key, label: d.toLocaleDateString('en', { weekday: 'short' }), v: count };
    });
    const maxV = Math.max(1, ...last7.map(x => x.v));

    root.innerHTML = `
      <div class="grid grid-4">
        ${kpi('Total Trucks', trucks.length, `${trucks.filter(t=>t.status==='available').length} available`, 'accent')}
        ${kpi('Active Trips', active, `${trips.length} total ever`, 'info')}
        ${kpi('Pending Orders', pending.length, `${orders.length} total`, 'warn')}
        ${kpi('Fleet Utilization', utilization + '%', `${inTrip} on the road`, 'ok')}
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title"><h3>Trips per day (last 7)</h3><span class="muted">${trips.length} total</span></div>
          <div class="bar-chart">
            ${last7.map(d => `<div class="bar" style="height:${(d.v/maxV)*100}%" data-v="${d.v} trips"></div>`).join('')}
          </div>
          <div class="bar-labels">${last7.map(d => `<span>${d.label}</span>`).join('')}</div>
        </div>
        <div class="card">
          <div class="card-title"><h3>Quick stats</h3></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div><div class="muted" style="font-size:12px">Drivers on duty</div><div style="font-family:var(--font-display);font-size:22px">${drivers.filter(d=>d.status==='available').length} / ${drivers.length}</div></div>
            <div><div class="muted" style="font-size:12px">Lifetime revenue</div><div style="font-family:var(--font-display);font-size:22px">${fmt.money(revenue)}</div></div>
            <div><div class="muted" style="font-size:12px">Total distance run</div><div style="font-family:var(--font-display);font-size:22px">${fmt.km(trips.reduce((s,t)=>s+(t.totalDistanceKm||0),0))}</div></div>
            <div><div class="muted" style="font-size:12px">Fuel burned</div><div style="font-family:var(--font-display);font-size:22px">${fmt.number(trips.reduce((s,t)=>s+(t.fuelLiters||0),0),0)} L</div></div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title"><h3>Recent trips</h3><button class="btn sm ghost" id="go-trips">View all →</button></div>
        ${trips.length === 0
          ? `<div class="empty">No trips yet. Plan one from the <b>Trip Planner</b>.</div>`
          : `<div class="t-wrap"><table>
              <thead><tr><th>Trip</th><th>Truck</th><th>Driver</th><th>Stops</th><th>Distance</th><th>Fuel ₹</th><th>Status</th></tr></thead>
              <tbody>${trips.slice(-6).reverse().map(t => {
                const tk = DB.get('trucks', t.truckId); const dr = DB.get('drivers', t.driverId);
                return `<tr>
                  <td><b>${t.tripNo}</b><div class="muted" style="font-size:11px">${fmt.date(t.createdAt)}</div></td>
                  <td>${tk ? tk.regNo : '—'}</td>
                  <td>${dr ? dr.name : '—'}</td>
                  <td>${t.orderIds.length}</td>
                  <td>${fmt.km(t.totalDistanceKm)}</td>
                  <td>${fmt.money(t.estimatedCost)}</td>
                  <td>${statusBadge(t.status)}</td>
                </tr>`;
              }).join('')}</tbody></table></div>`}
      </div>`;
    $('#go-trips').onclick = () => Router.go('trips');
  },
};

function kpi(label, value, sub, variant = '') {
  return `<div class="card kpi ${variant}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

function statusBadge(s) {
  const map = {
    'available':'ok','in-trip':'info','maintenance':'warn','on-leave':'mute',
    'pending':'warn','planned':'info','in-progress':'info','delivered':'ok','cancelled':'danger','completed':'ok',
  };
  return `<span class="badge ${map[s]||'mute'}">${s}</span>`;
}


/* — Trucks — */
Views.trucks = {
  title: 'Trucks',
  subtitle: 'Fleet master',
  render(root) {
    const trucks = DB.list('trucks');
    root.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="muted">${trucks.length} vehicles · capacity ${fmt.kg(trucks.reduce((s,t)=>s+t.capacityKg,0))} total</div>
        <div class="spacer"></div>
        <button class="btn" id="add-truck">+ Add Truck</button>
      </div>
      <div class="t-wrap"><table>
        <thead><tr><th>Reg. No</th><th>Model</th><th>Type</th><th>Capacity</th><th>Volume</th><th>Mileage</th><th>Status</th><th>Driver</th><th></th></tr></thead>
        <tbody>${trucks.map(t => {
          const drv = DB.list('drivers').find(d => d.assignedTruckId === t.id);
          const tt = TRUCK_TYPES[t.truckType||'regular'];
          return `<tr>
            <td><b>${t.regNo}</b></td>
            <td>${t.model}</td>
            <td><span class="badge ${t.truckType==='freezer'?'info':t.truckType==='chiller'?'info':t.truckType==='tanker'?'warn':'mute'}">${tt?tt.label:'Regular'}</span></td>
            <td>${fmt.kg(t.capacityKg)}</td>
            <td>${fmt.m3(t.capacityVolumeM3)}</td>
            <td>${t.mileageKmpl} km/L</td>
            <td>${statusBadge(t.status)}</td>
            <td>${drv ? drv.name : '<span class="muted">Unassigned</span>'}</td>
            <td class="right"><button class="btn sm ghost" data-edit="${t.id}">Edit</button> <button class="btn sm danger ghost" data-del="${t.id}">Del</button></td>
          </tr>`;
        }).join('') || '<tr><td colspan="9" class="empty">No trucks yet.</td></tr>'}</tbody>
      </table></div>`;

    $('#add-truck').onclick = () => editTruck();
    $$('[data-edit]', root).forEach(b => b.onclick = () => editTruck(b.dataset.edit));
    $$('[data-del]',  root).forEach(b => b.onclick = () => UI.confirm('Delete this truck?', () => {
      DB.remove('trucks', b.dataset.del); UI.toast('Truck removed','ok'); Router.go('trucks');
    }));
  },
};

function editTruck(id) {
  const t = id ? DB.get('trucks', id) : { regNo:'', model:'', truckType:'regular', capacityKg:1000, capacityVolumeM3:5, mileageKmpl:10, status:'available' };
  UI.modal({
    title: id ? 'Edit truck' : 'Add truck',
    bodyHtml: `
      <div class="field"><label>Registration No</label><input id="f-reg" value="${t.regNo}" placeholder="MH04-AB-1234"/></div>
      <div class="field"><label>Model</label><input id="f-mod" value="${t.model}" placeholder="Tata LPT 1109"/></div>
      <div class="field"><label>Truck type</label>
        <select id="f-tt">${Object.entries(TRUCK_TYPES).map(([k,v])=>`<option value="${k}" ${k===(t.truckType||'regular')?'selected':''}>${v.label}</option>`).join('')}</select>
        <p class="muted" style="font-size:11px;margin-top:4px">Determines which cargo types can be loaded (e.g. <i>freezer</i> can carry frozen + chilled + dry).</p>
      </div>
      <div class="field-row">
        <div class="field"><label>Capacity (kg)</label><input id="f-cap" type="number" value="${t.capacityKg}"/></div>
        <div class="field"><label>Volume (m³)</label><input id="f-vol" type="number" step="0.1" value="${t.capacityVolumeM3}"/></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Mileage (km/L)</label><input id="f-mil" type="number" step="0.1" value="${t.mileageKmpl}"/></div>
        <div class="field"><label>Status</label>
          <select id="f-st">${['available','in-trip','maintenance'].map(s=>`<option ${s===t.status?'selected':''}>${s}</option>`).join('')}</select>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: c => c() },
      { label: 'Save', onClick: (c) => {
        const data = {
          regNo: $('#f-reg').value.trim(),
          model: $('#f-mod').value.trim(),
          truckType: $('#f-tt').value,
          capacityKg: +$('#f-cap').value,
          capacityVolumeM3: +$('#f-vol').value,
          mileageKmpl: +$('#f-mil').value,
          status: $('#f-st').value,
        };
        if (!data.regNo || !data.model) return UI.toast('Reg No and Model are required', 'err');
        if (data.capacityKg <= 0) return UI.toast('Capacity must be > 0', 'err');
        if (id) DB.update('trucks', id, data); else DB.insert('trucks', data);
        c(); UI.toast('Saved','ok'); Router.go('trucks');
      }},
    ],
  });
}


/* — Drivers — */
Views.drivers = {
  title: 'Drivers',
  subtitle: 'Workforce',
  render(root) {
    const drivers = DB.list('drivers');
    const trucks = DB.list('trucks');
    root.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="muted">${drivers.length} drivers · ${drivers.filter(d=>d.status==='available').length} available</div>
        <div class="spacer"></div>
        <button class="btn" id="add-d">+ Add Driver</button>
      </div>
      <div class="t-wrap"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>License</th><th>Experience</th><th>Status</th><th>Assigned Truck</th><th></th></tr></thead>
        <tbody>${drivers.map(d => {
          const tk = d.assignedTruckId ? DB.get('trucks', d.assignedTruckId) : null;
          return `<tr>
            <td><b>${d.name}</b></td>
            <td>${d.phone}</td>
            <td>${d.license}</td>
            <td>${d.experienceYears} yrs</td>
            <td>${statusBadge(d.status)}</td>
            <td>
              <select data-assign="${d.id}" style="background:var(--bg-2);border:1px solid var(--border);color:var(--text);padding:5px;border-radius:4px;font:inherit;font-size:12px">
                <option value="">— Unassigned —</option>
                ${trucks.map(t => `<option value="${t.id}" ${d.assignedTruckId===t.id?'selected':''}>${t.regNo}</option>`).join('')}
              </select>
            </td>
            <td class="right"><button class="btn sm ghost" data-edit="${d.id}">Edit</button> <button class="btn sm danger ghost" data-del="${d.id}">Del</button></td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" class="empty">No drivers yet.</td></tr>'}</tbody>
      </table></div>`;

    $('#add-d').onclick = () => editDriver();
    $$('[data-edit]', root).forEach(b => b.onclick = () => editDriver(b.dataset.edit));
    $$('[data-del]',  root).forEach(b => b.onclick = () => UI.confirm('Delete this driver?', () => {
      DB.remove('drivers', b.dataset.del); UI.toast('Removed','ok'); Router.go('drivers');
    }));
    $$('[data-assign]', root).forEach(sel => sel.onchange = () => {
      DB.update('drivers', sel.dataset.assign, { assignedTruckId: sel.value || null });
      UI.toast('Assignment updated','ok');
    });
  },
};

function editDriver(id) {
  const d = id ? DB.get('drivers', id) : { name:'', phone:'', license:'', experienceYears:1, status:'available' };
  UI.modal({
    title: id ? 'Edit driver' : 'Add driver',
    bodyHtml: `
      <div class="field"><label>Name</label><input id="d-n" value="${d.name}"/></div>
      <div class="field-row">
        <div class="field"><label>Phone</label><input id="d-p" value="${d.phone}" placeholder="+91 90000 00000"/></div>
        <div class="field"><label>License</label><input id="d-l" value="${d.license}" placeholder="MH04 20210011"/></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Experience (years)</label><input id="d-e" type="number" value="${d.experienceYears}"/></div>
        <div class="field"><label>Status</label>
          <select id="d-s">${['available','on-trip','on-leave'].map(s=>`<option ${s===d.status?'selected':''}>${s}</option>`).join('')}</select>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: c => c() },
      { label: 'Save', onClick: c => {
        const data = { name:$('#d-n').value.trim(), phone:$('#d-p').value.trim(), license:$('#d-l').value.trim(),
          experienceYears:+$('#d-e').value, status:$('#d-s').value };
        if (!data.name) return UI.toast('Name required','err');
        if (id) DB.update('drivers', id, data); else DB.insert('drivers', data);
        c(); UI.toast('Saved','ok'); Router.go('drivers');
      }},
    ],
  });
}


/* — Depots — */
Views.depots = {
  title: 'Depots',
  subtitle: 'Pickup / cross-dock points',
  render(root) {
    const depots = DB.list('depots');
    root.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="muted">${depots.length} depots</div>
        <div class="spacer"></div>
        <button class="btn" id="add-dep">+ Add Depot</button>
      </div>
      <div class="t-wrap"><table>
        <thead><tr><th>Name</th><th>Address</th><th>Lat, Lng</th><th></th></tr></thead>
        <tbody>${depots.map(d=>`<tr>
          <td><b>${d.name}</b></td><td>${d.address}</td>
          <td class="muted">${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}</td>
          <td class="right"><button class="btn sm ghost" data-edit="${d.id}">Edit</button> <button class="btn sm danger ghost" data-del="${d.id}">Del</button></td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">No depots.</td></tr>'}</tbody>
      </table></div>`;
    $('#add-dep').onclick = () => editDepot();
    $$('[data-edit]', root).forEach(b => b.onclick = () => editDepot(b.dataset.edit));
    $$('[data-del]',  root).forEach(b => b.onclick = () => UI.confirm('Delete this depot?', () => {
      DB.remove('depots', b.dataset.del); UI.toast('Removed','ok'); Router.go('depots');
    }));
  },
};

function editDepot(id) {
  const d = id ? DB.get('depots', id) : { name:'', address:'', lat:19.0760, lng:72.8777 };
  UI.modal({
    title: id ? 'Edit depot' : 'Add depot',
    bodyHtml: `
      <div class="field"><label>Name</label><input id="dp-n" value="${d.name}"/></div>
      <div class="field"><label>Address</label><input id="dp-a" value="${d.address}"/></div>
      <div class="field-row">
        <div class="field"><label>Latitude</label><input id="dp-la" type="number" step="0.0001" value="${d.lat}"/></div>
        <div class="field"><label>Longitude</label><input id="dp-lg" type="number" step="0.0001" value="${d.lng}"/></div>
      </div>
      <p class="muted" style="font-size:11.5px">Tip: pick coordinates from Google Maps (right-click → copy lat/lng).</p>`,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: c => c() },
      { label: 'Save', onClick: c => {
        const data = { name:$('#dp-n').value.trim(), address:$('#dp-a').value.trim(), lat:+$('#dp-la').value, lng:+$('#dp-lg').value };
        if (!data.name) return UI.toast('Name required','err');
        if (id) DB.update('depots', id, data); else DB.insert('depots', data);
        c(); UI.toast('Saved','ok'); Router.go('depots');
      }},
    ],
  });
}


/* — Orders — */
Views.orders = {
  title: 'Orders',
  subtitle: 'Customer shipments',
  filter: 'all',
  render(root) {
    const all = DB.list('orders');
    const f = Views.orders.filter;
    const orders = (f === 'all') ? all : all.filter(o => o.status === f);
    root.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="chips">
          ${['all','pending','planned','in-progress','delivered','cancelled'].map(s =>
            `<span class="chip ${f===s?'active':''}" data-f="${s}">${s} (${s==='all'?all.length:all.filter(o=>o.status===s).length})</span>`).join('')}
        </div>
        <div class="spacer"></div>
        <button class="btn" id="add-ord">+ Add Order</button>
      </div>
      <div class="t-wrap"><table>
        <thead><tr><th>Order</th><th>Customer</th><th>Drop</th><th>Weight</th><th>Vol</th><th>Priority</th><th>Scheduled</th><th>Status</th><th></th></tr></thead>
        <tbody>${orders.map(o => `<tr>
          <td><b>${o.orderNo}</b></td>
          <td>${o.customerName}<div class="muted" style="font-size:11px">${o.customerPhone||''}</div></td>
          <td>${o.drop.address}</td>
          <td>${fmt.kg(o.weightKg)}</td>
          <td>${fmt.m3(o.volumeM3)}</td>
          <td><span class="badge ${o.priority==='urgent'?'danger':o.priority==='high'?'warn':'mute'}">${o.priority}</span></td>
          <td>${fmt.dateOnly(o.scheduledDate)}</td>
          <td>${statusBadge(o.status)}</td>
          <td class="right"><button class="btn sm ghost" data-edit="${o.id}">Edit</button> <button class="btn sm danger ghost" data-del="${o.id}">Del</button></td>
        </tr>`).join('') || '<tr><td colspan="9" class="empty">No orders match this filter.</td></tr>'}</tbody>
      </table></div>`;

    $$('[data-f]', root).forEach(c => c.onclick = () => { Views.orders.filter = c.dataset.f; Router.go('orders'); });
    $('#add-ord').onclick = () => editOrder();
    $$('[data-edit]', root).forEach(b => b.onclick = () => editOrder(b.dataset.edit));
    $$('[data-del]',  root).forEach(b => b.onclick = () => UI.confirm('Delete this order?', () => {
      DB.remove('orders', b.dataset.del); UI.toast('Removed','ok'); Router.go('orders');
    }));
  },
};

function editOrder(id) {
  const depots = DB.list('depots');
  if (depots.length === 0) { UI.toast('Add a depot first', 'err'); Router.go('depots'); return; }
  const base = id ? DB.get('orders', id) : {
    orderNo: 'ORD-' + (1000 + DB.list('orders').length + 1),
    customerName:'', customerPhone:'',
    pickup: { lat:depots[0].lat, lng:depots[0].lng, address:depots[0].address, depotId:depots[0].id },
    drop:   { lat:19.2, lng:72.97, address:'' },
    weightKg:500, volumeM3:2, priority:'normal', cargoType:'general',
    scheduledDate: new Date().toISOString(), status:'pending',
  };
  // Working copy of stops the modal mutates. Default: pickup at depot + drop at customer.
  const stops = (base.stops && base.stops.length)
    ? clone(base.stops)
    : [
        { action:'pickup', lat:base.pickup.lat, lng:base.pickup.lng, address:base.pickup.address, weightKg:base.weightKg, volumeM3:base.volumeM3, depotId:base.pickup.depotId },
        { action:'drop',   lat:base.drop.lat,   lng:base.drop.lng,   address:base.drop.address,   weightKg:base.weightKg, volumeM3:base.volumeM3 },
      ];

  UI.modal({
    title: id ? 'Edit order' : 'New order',
    size: 'lg',
    bodyHtml: (body) => {
      body.innerHTML = `
      <div class="field-row">
        <div class="field"><label>Order No</label><input id="o-n" value="${base.orderNo}"/></div>
        <div class="field"><label>Customer</label><input id="o-c" value="${base.customerName}"/></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Customer phone</label><input id="o-cp" value="${base.customerPhone||''}"/></div>
        <div class="field"><label>Pickup depot</label>
          <select id="o-dep">${depots.map(d=>`<option value="${d.id}" ${base.pickup.depotId===d.id?'selected':''}>${d.name}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Total weight (kg)</label><input id="o-w" type="number" value="${base.weightKg}"/></div>
        <div class="field"><label>Total volume (m³)</label><input id="o-v" type="number" step="0.1" value="${base.volumeM3}"/></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Cargo type</label>
          <select id="o-ct">${CARGO_TYPES.map(c=>`<option ${c===(base.cargoType||'general')?'selected':''}>${c}</option>`).join('')}</select>
          <p class="muted" style="font-size:11px;margin-top:4px">Only trucks rated for this cargo (e.g. <i>frozen</i> → freezer truck) can be selected in the planner.</p>
        </div>
        <div class="field"><label>Priority</label>
          <select id="o-p">${['normal','high','urgent'].map(p=>`<option ${p===base.priority?'selected':''}>${p}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field"><label>Scheduled date</label><input id="o-s" type="date" value="${(base.scheduledDate||'').slice(0,10)}"/></div>

      <div class="divider"></div>
      <div class="row" style="margin-bottom:8px">
        <h3 style="margin:0">Stops (pickups &amp; drops)</h3>
        <span class="muted" style="font-size:11.5px;margin-left:10px">Each row adds (pickup) or removes (drop) the listed weight/volume from the truck along the route.</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" type="button" id="add-stop">+ Add stop</button>
      </div>
      <div id="stops-editor"></div>`;

      const renderStops = () => {
        const wrap = body.querySelector('#stops-editor');
        wrap.innerHTML = `<div class="t-wrap"><table>
          <thead><tr><th style="width:90px">Action</th><th>Address (label)</th><th style="width:90px">Lat</th><th style="width:90px">Lng</th><th style="width:80px">Weight (kg)</th><th style="width:80px">Vol (m³)</th><th></th></tr></thead>
          <tbody>${stops.map((s,i)=>`<tr>
            <td><select data-k="action" data-i="${i}">${['pickup','drop'].map(a=>`<option ${a===s.action?'selected':''}>${a}</option>`).join('')}</select></td>
            <td><input data-k="address" data-i="${i}" value="${s.address||''}" placeholder="${s.action==='pickup'?'Depot / pickup point':'Customer drop'}"/></td>
            <td><input data-k="lat" data-i="${i}" type="number" step="0.0001" value="${s.lat}"/></td>
            <td><input data-k="lng" data-i="${i}" type="number" step="0.0001" value="${s.lng}"/></td>
            <td><input data-k="weightKg" data-i="${i}" type="number" value="${s.weightKg||0}"/></td>
            <td><input data-k="volumeM3" data-i="${i}" type="number" step="0.1" value="${s.volumeM3||0}"/></td>
            <td class="right"><button class="btn sm danger ghost" type="button" data-rm="${i}">✕</button></td>
          </tr>`).join('')}</tbody></table></div>`;
        wrap.querySelectorAll('input,select').forEach(inp => {
          inp.oninput = inp.onchange = () => {
            const i = +inp.dataset.i, k = inp.dataset.k;
            stops[i][k] = (k==='lat'||k==='lng'||k==='weightKg'||k==='volumeM3') ? +inp.value : inp.value;
          };
        });
        wrap.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
          stops.splice(+b.dataset.rm, 1); renderStops();
        });
      };
      renderStops();

      body.querySelector('#add-stop').onclick = () => {
        const dep = DB.get('depots', body.querySelector('#o-dep').value) || depots[0];
        stops.push({ action:'drop', lat:dep.lat+0.05, lng:dep.lng+0.05, address:'New stop', weightKg:0, volumeM3:0 });
        renderStops();
      };
    },
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: c => c() },
      { label: 'Save', onClick: c => {
        const dep = DB.get('depots', $('#o-dep').value);
        if (stops.length < 2) return UI.toast('At least 2 stops required (1 pickup + 1 drop)', 'err');
        if (!stops.some(s => s.action === 'pickup')) return UI.toast('Add at least one pickup stop', 'err');
        if (!stops.some(s => s.action === 'drop'))   return UI.toast('Add at least one drop stop', 'err');
        // Derived single pickup/drop for legacy fields (first pickup, last drop).
        const firstPickup = stops.find(s => s.action === 'pickup');
        const lastDrop = [...stops].reverse().find(s => s.action === 'drop');
        const data = {
          orderNo: $('#o-n').value.trim(),
          customerName: $('#o-c').value.trim(),
          customerPhone: $('#o-cp').value.trim(),
          pickup: { lat: firstPickup.lat, lng: firstPickup.lng, address: firstPickup.address || dep.address, depotId: dep.id },
          drop:   { lat: lastDrop.lat,    lng: lastDrop.lng,    address: lastDrop.address || '' },
          weightKg: +$('#o-w').value,
          volumeM3: +$('#o-v').value,
          cargoType: $('#o-ct').value,
          stops: stops.map(s => ({
            action: s.action, lat:+s.lat, lng:+s.lng, address:s.address||'',
            weightKg:+s.weightKg||0, volumeM3:+s.volumeM3||0,
            depotId: s.action==='pickup' ? dep.id : null,
          })),
          priority: $('#o-p').value,
          scheduledDate: new Date($('#o-s').value || Date.now()).toISOString(),
          status: base.status || 'pending',
        };
        if (!data.customerName) return UI.toast('Customer required','err');
        if (data.weightKg <= 0) return UI.toast('Total weight must be > 0','err');
        if (id) DB.update('orders', id, data); else DB.insert('orders', data);
        c(); UI.toast('Saved','ok'); Router.go('orders');
      }},
    ],
  });
}


/* — Trip Planner — */
Views.planner = {
  title: 'Trip Planner',
  subtitle: 'Pick truck + orders, optimize route, dispatch',
  state: { truckId: null, driverId: null, selectedOrderIds: new Set(), result: null },

  render(root) {
    const allTrucks = DB.list('trucks', t => t.status === 'available');
    const drivers = DB.list('drivers', d => d.status === 'available');
    const orders  = DB.list('orders',  o => o.status === 'pending');
    const depots  = DB.list('depots');
    const s = Views.planner.state;

    if (allTrucks.length === 0 || depots.length === 0 || orders.length === 0) {
      root.innerHTML = `<div class="card"><div class="empty">
        Need at least 1 available truck, 1 depot, and 1 pending order to plan a trip.<br>
        <button class="btn ghost sm" id="seed-here" style="margin-top:12px">Load demo data</button>
      </div></div>`;
      $('#seed-here').onclick = () => { seedDemoData(); UI.toast('Demo data loaded','ok'); Router.go('planner'); };
      return;
    }

    // Filter trucks to those compatible with every selected order's cargo type.
    const selOrders0 = Array.from(s.selectedOrderIds).map(id => DB.get('orders', id)).filter(Boolean);
    const compatTrucks = allTrucks.filter(tr => selOrders0.every(o => truckCarries(tr, o.cargoType)));
    const trucks = selOrders0.length ? compatTrucks : allTrucks;
    if (!s.truckId || !trucks.find(t => t.id === s.truckId)) s.truckId = trucks[0]?.id || null;
    if (!s.driverId) s.driverId = (drivers[0] || {}).id || null;

    root.innerHTML = `
      <div class="planner-grid">
        <div class="card">
          <h3 style="margin-bottom:10px">1 · Resources</h3>
          <div class="field-row">
            <div class="field"><label>Truck</label>
              <select id="p-truck">${trucks.length
                ? trucks.map(t=>{ const tt = TRUCK_TYPES[t.truckType||'regular']; return `<option value="${t.id}" ${t.id===s.truckId?'selected':''}>${t.regNo} · ${tt?tt.label:'Regular'} — ${fmt.kg(t.capacityKg)} / ${fmt.m3(t.capacityVolumeM3)}</option>`; }).join('')
                : '<option value="">No truck matches selected cargo types</option>'}</select>
              ${selOrders0.length ? `<p class="muted" style="font-size:11px;margin-top:4px">Filtered by cargo: ${[...new Set(selOrders0.map(o=>o.cargoType||'general'))].join(', ')} · ${trucks.length}/${allTrucks.length} compatible</p>` : ''}
            </div>
            <div class="field"><label>Driver</label>
              <select id="p-driver">${drivers.length ? drivers.map(d=>`<option value="${d.id}" ${d.id===s.driverId?'selected':''}>${d.name} · ${d.experienceYears}y</option>`).join('') : '<option value="">No available driver</option>'}</select>
            </div>
          </div>
          <div id="cap-block"></div>

          <h3 style="margin-top:18px;margin-bottom:10px">2 · Orders (co-load)</h3>
          <div class="muted" style="font-size:12px;margin-bottom:8px">Select pending orders. Capacity uses <b>peak load along the route</b> — drops free up space for later pickups.</div>
          <div id="order-list" style="max-height:300px;overflow:auto"></div>

          <div class="divider"></div>
          <div class="row">
            <button class="btn ghost sm" id="auto-fill">Auto co-load (greedy)</button>
            <button class="btn ghost sm" id="clear-sel">Clear</button>
            <div class="spacer"></div>
            <button class="btn" id="optimize" disabled>Optimize Route →</button>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-bottom:10px">3 · Optimized route</h3>
          <div id="result-block"><div class="empty">Pick orders and click <b>Optimize Route</b>.</div></div>
          <div id="planner-map" class="map-frame" style="margin-top:14px;height:340px;display:none"></div>
          <div class="modal-actions" style="border:0;padding:0;margin-top:14px">
            <button class="btn" id="dispatch" disabled>Dispatch trip</button>
          </div>
        </div>
      </div>`;

    // Compute the *peak* load along the geographically-optimized route for
    // the currently selected orders. This is the realistic merge-capacity
    // check: a drop in the middle of the route frees space for later pickups.
    const computePlan = () => {
      const truck = DB.get('trucks', $('#p-truck').value);
      if (!truck) return null;
      const sel = Array.from(s.selectedOrderIds).map(id => DB.get('orders', id)).filter(Boolean);
      if (!sel.length) return { truck, sel, peakKg:0, peakM3:0, overW:false, overV:false };
      const allStops = sel.flatMap(getOrderStops);
      // Pick a depot (first pickup's depot if known, else first depot).
      const firstPickup = allStops.find(st => st.action === 'pickup' && st.depotId) || allStops[0];
      const depot = (firstPickup.depotId && DB.get('depots', firstPickup.depotId)) || depots[0];
      const start = { lat: depot.lat, lng: depot.lng, label: depot.name, depotId: depot.id, action: 'depot' };
      // Remove the start pickup from the optimizable stop list if it's at depot.
      const stopsToVisit = allStops.filter(st => !(st.action === 'pickup' && st.depotId === depot.id));
      const opt = Geo.optimizeRoute(start, stopsToVisit, true);
      // Re-attach the depot pickups to the start so the load timeline counts them.
      const depotPickups = allStops.filter(st => st.action === 'pickup' && st.depotId === depot.id);
      const path = [start, ...depotPickups, ...opt.path.slice(1)];
      const { timeline, peakKg, peakM3 } = loadTimeline(path);
      return { truck, sel, depot, opt, path, timeline, peakKg, peakM3,
        overW: peakKg > truck.capacityKg, overV: peakM3 > truck.capacityVolumeM3 };
    };

    const renderCap = () => {
      const p = computePlan(); if (!p) return;
      const { truck, peakKg, peakM3, overW, overV } = p;
      const pctW = Math.min(120, (peakKg / truck.capacityKg) * 100);
      const pctV = Math.min(120, (peakM3 / truck.capacityVolumeM3) * 100);
      $('#cap-block').innerHTML = `
        <div class="muted" style="font-size:12px;margin-top:6px">Peak weight: ${fmt.kg(peakKg)} / ${fmt.kg(truck.capacityKg)} ${overW?'<span class="badge danger">OVER</span>':''} <span class="muted" style="font-size:11px">· free at peak: ${fmt.kg(Math.max(0, truck.capacityKg - peakKg))}</span></div>
        <div class="cap-bar ${overW?'over':''}"><div style="width:${pctW}%"></div></div>
        <div class="muted" style="font-size:12px;margin-top:8px">Peak volume: ${fmt.m3(peakM3)} / ${fmt.m3(truck.capacityVolumeM3)} ${overV?'<span class="badge danger">OVER</span>':''}</div>
        <div class="cap-bar ${overV?'over':''}"><div style="width:${pctV}%"></div></div>`;
      $('#optimize').disabled = s.selectedOrderIds.size === 0 || overW || overV;
    };

    const renderList = () => {
      const truck = DB.get('trucks', $('#p-truck')?.value || s.truckId);
      $('#order-list').innerHTML = orders.map(o => {
        const compat = !truck || truckCarries(truck, o.cargoType);
        return `
        <div class="order-pick ${s.selectedOrderIds.has(o.id)?'sel':''} ${compat?'':'incompatible'}" data-oid="${o.id}" ${compat?'':'title="Cargo type not supported by selected truck"'}>
          <div style="flex:1">
            <b>${o.orderNo}</b> · ${o.customerName} ${compat?'':'<span class="badge danger">incompatible</span>'}
            <div class="meta">${o.drop.address} · ${fmt.kg(o.weightKg)} · ${fmt.m3(o.volumeM3)} · <span class="badge mute">${o.cargoType||'general'}</span> · <span class="badge ${o.priority==='urgent'?'danger':o.priority==='high'?'warn':'mute'}">${o.priority}</span> · ${(o.stops||[]).length||2} stops</div>
          </div>
        </div>`; }).join('');
      $$('.order-pick', $('#order-list')).forEach(el => el.onclick = () => {
        if (el.classList.contains('incompatible')) { UI.toast('This truck cannot carry that cargo type','err'); return; }
        const oid = el.dataset.oid;
        if (s.selectedOrderIds.has(oid)) s.selectedOrderIds.delete(oid); else s.selectedOrderIds.add(oid);
        el.classList.toggle('sel'); renderCap();
        // Re-filter compatible trucks after selection changes.
        Router.go('planner');
      });
    };

    $('#p-truck').onchange = () => { s.truckId = $('#p-truck').value; renderList(); renderCap(); };
    $('#p-driver').onchange = () => { s.driverId = $('#p-driver').value; };
    $('#clear-sel').onclick = () => { s.selectedOrderIds.clear(); renderList(); renderCap(); };

    // Greedy co-loader: priority desc, then weight desc. Adds an order if its
    // inclusion keeps PEAK load (not running sum) under capacity. Only
    // considers cargo-compatible orders for the current truck.
    $('#auto-fill').onclick = () => {
      const truck = DB.get('trucks', $('#p-truck').value);
      const ranked = orders.filter(o => truckCarries(truck, o.cargoType)).sort((a,b) => {
        const pri = (x) => x.priority === 'urgent' ? 2 : x.priority === 'high' ? 1 : 0;
        if (pri(b) !== pri(a)) return pri(b) - pri(a);
        return b.weightKg - a.weightKg;
      });
      s.selectedOrderIds.clear();
      for (const o of ranked) {
        s.selectedOrderIds.add(o.id);
        const p = computePlan();
        if (p.overW || p.overV) s.selectedOrderIds.delete(o.id);
      }
      renderList(); renderCap();
      UI.toast(`Auto-loaded ${s.selectedOrderIds.size} orders`, 'ok');
    };

    $('#optimize').onclick = () => {
      const p = computePlan();
      const { truck, sel, depot, opt, path, timeline, peakKg, peakM3 } = p;
      const distanceKm = Geo.pathLength(path);
      const { liters, cost } = Geo.fuelCost({ distanceKm, mileageKmpl: truck.mileageKmpl, pricePerLiter: DB.state.settings.fuelPricePerLiter });
      s.result = { truck, depot, selected: sel, opt: { ...opt, distanceKm, path }, liters, cost, timeline, peakKg, peakM3 };

      $('#result-block').innerHTML = `
        <div class="row" style="gap:18px;margin-bottom:10px">
          <div><div class="muted" style="font-size:11px">DISTANCE</div><div style="font-family:var(--font-display);font-size:22px">${fmt.km(distanceKm)}</div></div>
          <div><div class="muted" style="font-size:11px">FUEL</div><div style="font-family:var(--font-display);font-size:22px">${fmt.number(liters,1)} L</div></div>
          <div><div class="muted" style="font-size:11px">EST. COST</div><div style="font-family:var(--font-display);font-size:22px">${fmt.money(cost)}</div></div>
          <div><div class="muted" style="font-size:11px">PEAK LOAD</div><div style="font-family:var(--font-display);font-size:22px">${fmt.kg(peakKg)}</div></div>
        </div>
        <div class="muted" style="font-size:11.5px">Strategy: ${opt.strategy}</div>
        <div class="divider"></div>
        <div class="stops">
          ${timeline.map((p,i) => {
            const isStart = i===0, isEnd = i===timeline.length-1;
            const tag = isStart?'Depot (start)' : isEnd?'Return to depot' :
              p.action==='pickup' ? `Pickup +${fmt.kg(p.weightKg)} (${p.orderNo||''})` :
              p.action==='drop'   ? `Drop −${fmt.kg(p.weightKg)} (${p.orderNo||''})` : 'Stop';
            const color = p.action==='pickup'?'ok':p.action==='drop'?'info':'mute';
            return `<div class="stop"><div style="flex:1">
              <b>${p.label || p.address || (p.lat.toFixed(3)+','+p.lng.toFixed(3))}</b>
              <div class="muted" style="font-size:11.5px"><span class="badge ${color}">${tag}</span> · load after: ${fmt.kg(p.runningKg)} / ${fmt.kg(truck.capacityKg)}</div>
            </div></div>`;
          }).join('')}
        </div>`;

      $('#planner-map').style.display = 'block';
      drawRouteMap('planner-map', path);
      $('#dispatch').disabled = false;
    };

    $('#dispatch').onclick = () => {
      const { truck, depot, selected, opt, liters, cost } = s.result;
      const driver = DB.get('drivers', $('#p-driver').value);
      const trip = DB.insert('trips', {
        tripNo: 'TRIP-' + (3000 + DB.list('trips').length + 1),
        truckId: truck.id,
        driverId: driver ? driver.id : null,
        depotId: depot.id,
        orderIds: selected.map(o => o.id),
        waypoints: opt.path,
        totalDistanceKm: +opt.distanceKm.toFixed(2),
        fuelLiters: +liters.toFixed(2),
        estimatedCost: Math.round(cost),
        strategy: opt.strategy,
        peakLoadKg: Math.round(s.result.peakKg),
        peakLoadM3: +s.result.peakM3.toFixed(2),
        status: 'in-progress',
      });
      DB.update('trucks', truck.id, { status: 'in-trip' });
      if (driver) DB.update('drivers', driver.id, { status: 'on-trip', assignedTruckId: truck.id });
      selected.forEach(o => DB.update('orders', o.id, { status: 'in-progress', tripId: trip.id }));
      UI.toast(`Dispatched ${trip.tripNo}`, 'ok');
      s.truckId = null; s.driverId = null; s.selectedOrderIds.clear(); s.result = null;
      Router.go('trips');
    };

    renderList(); renderCap();
  },
};


/* — Trips — */
Views.trips = {
  title: 'Trips',
  subtitle: 'Dispatched & completed',
  render(root) {
    const trips = DB.list('trips').slice().reverse();
    root.innerHTML = `
      <div class="t-wrap"><table>
        <thead><tr><th>Trip</th><th>Date</th><th>Truck</th><th>Driver</th><th>Orders</th><th>Distance</th><th>Fuel</th><th>Cost</th><th>Status</th><th></th></tr></thead>
        <tbody>${trips.map(t => {
          const tk = DB.get('trucks', t.truckId); const dr = DB.get('drivers', t.driverId);
          return `<tr>
            <td><b>${t.tripNo}</b></td>
            <td>${fmt.dateOnly(t.createdAt)}</td>
            <td>${tk ? tk.regNo : '—'}</td>
            <td>${dr ? dr.name : '—'}</td>
            <td>${t.orderIds.length}</td>
            <td>${fmt.km(t.totalDistanceKm)}</td>
            <td>${fmt.number(t.fuelLiters,1)} L</td>
            <td>${fmt.money(t.estimatedCost)}</td>
            <td>${statusBadge(t.status)}</td>
            <td class="right">
              <button class="btn sm ghost" data-view="${t.id}">View</button>
              ${t.status==='in-progress'?`<button class="btn sm" data-complete="${t.id}">Complete</button>`:''}
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="10" class="empty">No trips yet.</td></tr>'}</tbody>
      </table></div>`;

    $$('[data-view]', root).forEach(b => b.onclick = () => showTrip(b.dataset.view));
    $$('[data-complete]', root).forEach(b => b.onclick = () => completeTrip(b.dataset.complete));
  },
};

function completeTrip(id) {
  UI.confirm('Mark this trip as completed?', () => {
    const t = DB.get('trips', id);
    DB.update('trips', id, { status: 'completed', completedAt: new Date().toISOString() });
    if (t.truckId)  DB.update('trucks',  t.truckId,  { status: 'available' });
    if (t.driverId) DB.update('drivers', t.driverId, { status: 'available' });
    t.orderIds.forEach(oid => DB.update('orders', oid, { status: 'delivered' }));
    UI.toast('Trip completed', 'ok'); Router.go('trips');
  });
}

function showTrip(id) {
  const t = DB.get('trips', id);
  const tk = DB.get('trucks', t.truckId); const dr = DB.get('drivers', t.driverId);
  UI.modal({
    title: t.tripNo,
    size: 'lg',
    bodyHtml: (body) => {
      body.innerHTML = `
        <div class="row" style="gap:18px">
          <div><div class="muted" style="font-size:11px">TRUCK</div><b>${tk?tk.regNo:'—'}</b></div>
          <div><div class="muted" style="font-size:11px">DRIVER</div><b>${dr?dr.name:'—'}</b></div>
          <div><div class="muted" style="font-size:11px">DISTANCE</div><b>${fmt.km(t.totalDistanceKm)}</b></div>
          <div><div class="muted" style="font-size:11px">FUEL</div><b>${fmt.number(t.fuelLiters,1)} L</b></div>
          <div><div class="muted" style="font-size:11px">COST</div><b>${fmt.money(t.estimatedCost)}</b></div>
          <div><div class="muted" style="font-size:11px">STATUS</div>${statusBadge(t.status)}</div>
        </div>
        <div class="divider"></div>
        <div id="trip-map" class="map-frame" style="height:300px;margin-bottom:12px"></div>
        <h3>Stops</h3>
        <div class="stops">${t.waypoints.map((p,i)=>`<div class="stop"><div><b>${p.label||(p.lat+','+p.lng)}</b><div class="muted" style="font-size:11.5px">${i===0?'Depot':i===t.waypoints.length-1?'Return':'Drop'}</div></div></div>`).join('')}</div>
        <h3 style="margin-top:14px">Orders in this trip</h3>
        <ul>${t.orderIds.map(oid => { const o = DB.get('orders', oid); return o ? `<li><b>${o.orderNo}</b> — ${o.customerName} → ${o.drop.address} (${fmt.kg(o.weightKg)})</li>` : ''; }).join('')}</ul>
        ${t.strategy ? `<div class="muted" style="font-size:11.5px;margin-top:8px">Optimization strategy: ${t.strategy}</div>` : ''}`;
      setTimeout(() => drawRouteMap('trip-map', t.waypoints), 50);
    },
    actions: [{ label: 'Close', variant: 'ghost', onClick: c => c() }],
  });
}


/* — Live Map — */
Views.map = {
  title: 'Live Map',
  subtitle: 'Depots, drops and active trips',
  render(root) {
    root.innerHTML = `<div id="leaflet-map"></div>`;
    setTimeout(() => {
      const map = L.map('leaflet-map').setView([19.2, 73.5], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 18,
      }).addTo(map);

      DB.list('depots').forEach(d => {
        L.circleMarker([d.lat, d.lng], { radius: 8, color: '#ffd166', weight: 2, fillColor: '#ffd166', fillOpacity: .6 })
          .addTo(map).bindPopup(`<b>${d.name}</b><br>${d.address}`);
      });
      DB.list('orders').forEach(o => {
        const color = o.status === 'delivered' ? '#5ee0c1' : o.status === 'in-progress' ? '#6ea8ff' : '#9aa4b2';
        L.circleMarker([o.drop.lat, o.drop.lng], { radius: 5, color, fillColor: color, fillOpacity: .6 })
          .addTo(map).bindPopup(`<b>${o.orderNo}</b><br>${o.customerName}<br>${o.drop.address}<br>${statusBadge(o.status)}`);
      });
      DB.list('trips', t => t.status === 'in-progress').forEach(t => {
        L.polyline(t.waypoints.map(p => [p.lat, p.lng]), { color: '#ffd166', weight: 3, opacity: .85 }).addTo(map);
      });
    }, 30);
  },
};

function drawRouteMap(elId, waypoints) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const map = L.map(elId).setView([waypoints[0].lat, waypoints[0].lng], 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM', maxZoom: 18 }).addTo(map);
  const latlngs = waypoints.map(p => [p.lat, p.lng]);
  L.polyline(latlngs, { color: '#ffd166', weight: 4, opacity: .9 }).addTo(map);
  waypoints.forEach((p, i) => {
    const isStart = i === 0, isEnd = i === waypoints.length - 1;
    L.circleMarker([p.lat, p.lng], {
      radius: 7, color: isStart||isEnd ? '#ffd166' : '#6ea8ff',
      fillColor: isStart||isEnd ? '#ffd166' : '#6ea8ff', fillOpacity: .9, weight: 2,
    }).addTo(map).bindPopup(`<b>${i+1}. ${p.label || (p.lat.toFixed(3)+','+p.lng.toFixed(3))}</b>`);
  });
  map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
}


/* — Reports — */
Views.reports = {
  title: 'Reports',
  subtitle: 'Performance and cost summary',
  render(root) {
    const trips = DB.list('trips');
    const drivers = DB.list('drivers');
    const totalDist = trips.reduce((s,t)=>s+(t.totalDistanceKm||0),0);
    const totalCost = trips.reduce((s,t)=>s+(t.estimatedCost||0),0);
    const totalFuel = trips.reduce((s,t)=>s+(t.fuelLiters||0),0);
    const completed = trips.filter(t=>t.status==='completed').length;

    // Driver leaderboard
    const perDriver = drivers.map(d => {
      const dt = trips.filter(t => t.driverId === d.id);
      return { name: d.name, trips: dt.length, distance: dt.reduce((s,t)=>s+(t.totalDistanceKm||0),0), revenue: dt.reduce((s,t)=>s+(t.estimatedCost||0),0) };
    }).sort((a,b) => b.distance - a.distance);

    root.innerHTML = `
      <div class="grid grid-4">
        ${kpi('Total trips', trips.length, `${completed} completed`)}
        ${kpi('Distance run', fmt.km(totalDist), '', 'info')}
        ${kpi('Fuel burned', fmt.number(totalFuel,0)+' L', '', 'warn')}
        ${kpi('Revenue', fmt.money(totalCost), '', 'ok')}
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title"><h3>Driver leaderboard</h3></div>
        <div class="t-wrap"><table>
          <thead><tr><th>Driver</th><th>Trips</th><th>Distance</th><th>Revenue</th></tr></thead>
          <tbody>${perDriver.map(d => `<tr><td>${d.name}</td><td>${d.trips}</td><td>${fmt.km(d.distance)}</td><td>${fmt.money(d.revenue)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No data.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-title"><h3>Per-trip cost breakdown</h3></div>
        <div class="t-wrap"><table>
          <thead><tr><th>Trip</th><th>Distance</th><th>Fuel (L)</th><th>Fuel ₹</th><th>₹ / km</th></tr></thead>
          <tbody>${trips.slice().reverse().map(t => `<tr>
            <td><b>${t.tripNo}</b></td>
            <td>${fmt.km(t.totalDistanceKm)}</td>
            <td>${fmt.number(t.fuelLiters,1)}</td>
            <td>${fmt.money(t.estimatedCost)}</td>
            <td>${fmt.money(t.totalDistanceKm ? t.estimatedCost/t.totalDistanceKm : 0)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty">No trips yet.</td></tr>'}</tbody>
        </table></div>
      </div>`;
  },
};


/* — Settings — */
Views.settings = {
  title: 'Settings',
  subtitle: 'Company & pricing',
  render(root) {
    const s = DB.state.settings;
    root.innerHTML = `
      <div class="card" style="max-width:560px">
        <h3>Company</h3>
        <div class="field"><label>Company name</label><input id="s-name" value="${s.companyName||''}"/></div>
        <h3 style="margin-top:14px">Pricing</h3>
        <div class="field-row">
          <div class="field"><label>Fuel price (per litre)</label><input id="s-fp" type="number" step="0.1" value="${s.fuelPricePerLiter}"/></div>
          <div class="field"><label>Currency</label>
            <select id="s-cur">${['INR','USD','EUR','GBP'].map(c=>`<option ${c===s.currency?'selected':''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="modal-actions" style="border:0;padding:0">
          <button class="btn" id="s-save">Save settings</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px;max-width:560px">
        <h3>Self-tests</h3>
        <p class="muted" style="font-size:12.5px">Run unit-style assertions on the geo / capacity logic. Output goes to the browser console.</p>
        <button class="btn ghost" id="s-tests">Run tests</button>
      </div>`;
    $('#s-save').onclick = () => {
      DB.state.settings = {
        companyName: $('#s-name').value.trim(),
        fuelPricePerLiter: +$('#s-fp').value,
        currency: $('#s-cur').value,
      };
      DB.save(); UI.toast('Settings saved','ok');
    };
    $('#s-tests').onclick = () => { runSelfTests(); UI.toast('Tests run — see console','ok'); };
  },
};


/* ───────────────────────── §8 BOOTSTRAP ───────────────────── */
function refreshSideStats() {
  $('#ss-trucks').textContent = DB.list('trucks').length;
  $('#ss-orders').textContent = DB.list('orders').length;
}

function bindShell() {
  $$('.nav-item').forEach(b => b.onclick = () => Router.go(b.dataset.view));

  $('#btn-seed').onclick = () => UI.confirm('Replace ALL current data with the demo dataset?', () => {
    seedDemoData(); refreshSideStats(); UI.toast('Demo data loaded','ok'); Router.go('dashboard');
  });

  $('#btn-export').onclick = () => {
    const blob = new Blob([DB.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fleetos-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    UI.toast('Backup downloaded','ok');
  };

  $('#btn-import').onclick = () => $('#file-import').click();
  $('#file-import').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try { DB.importJSON(r.result); UI.toast('Restored from backup','ok'); refreshSideStats(); Router.go('dashboard'); }
      catch (err) { UI.toast('Invalid backup: ' + err.message, 'err'); }
    };
    r.readAsText(file);
  };

  $('#btn-reset').onclick = () => UI.confirm('Wipe ALL data? This cannot be undone.', () => {
    DB.reset(); refreshSideStats(); UI.toast('All data cleared','ok'); Router.go('dashboard');
  });

  // Global search — naive contains-match across orders, trucks, drivers.
  $('#global-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (q.length < 2) return;
    const hit = (s) => (s||'').toLowerCase().includes(q);
    if (DB.list('orders').some(o => hit(o.orderNo) || hit(o.customerName))) return Router.go('orders');
    if (DB.list('trucks').some(t => hit(t.regNo) || hit(t.model))) return Router.go('trucks');
    if (DB.list('drivers').some(d => hit(d.name) || hit(d.phone))) return Router.go('drivers');
  });

  // Re-render side stats after each navigation.
  const _go = Router.go;
  Router.go = (v) => { _go(v); refreshSideStats(); };
}

function runSelfTests() {
  console.group('FleetOS self-tests');
  const mum = { lat:19.0760, lng:72.8777 }; const pune = { lat:18.5204, lng:73.8567 };
  const d = Geo.haversine(mum, pune);
  assert('Mumbai→Pune ≈ 120 km', d > 100 && d < 160, `got ${d.toFixed(1)} km`);

  const stops = [{lat:19.2,lng:73.0},{lat:19.5,lng:73.4},{lat:18.9,lng:73.1},{lat:18.7,lng:73.6}];
  const nn = Geo.nearestNeighbor(mum, stops);
  assert('Nearest-Neighbor returns full chain', nn.length === stops.length + 1);

  const opt = Geo.optimizeRoute(mum, stops, true);
  const naive = Geo.pathLength([mum, ...stops, mum]);
  assert('Optimized route ≤ naive route', opt.distanceKm <= naive + 1e-6, `opt=${opt.distanceKm.toFixed(1)} naive=${naive.toFixed(1)}`);

  const cost = Geo.fuelCost({ distanceKm: 100, mileageKmpl: 10, pricePerLiter: 100 });
  assert('100 km @ 10 km/L @ ₹100 = ₹1000', Math.abs(cost.cost - 1000) < 0.01);

  const bf = Geo.bruteForce(mum, stops);
  assert('Brute-force ≤ 2-opt', Geo.pathLength([...bf, mum]) <= opt.distanceKm + 1e-6);
  console.groupEnd();
}

function boot() {
  DB.load();
  bindShell();
  refreshSideStats();
  Router.go('dashboard');
  // Auto-seed on first run for instant demo.
  if (DB.list('trucks').length === 0 && DB.list('orders').length === 0) {
    seedDemoData(); refreshSideStats(); Router.go('dashboard');
    UI.toast('Demo data loaded automatically','ok');
  }
}
document.addEventListener('DOMContentLoaded', boot);
