# FleetOS — AI-Powered Logistics & Route Optimization Suite

> A zero-dependency, single-page **fleet management platform** that combines classical operations-research algorithms with a **trained machine-learning ETA model** and a **multi-criteria smart-assignment engine**. Built end-to-end in vanilla JavaScript — no framework, no build step, no backend — and designed to demonstrate production-grade thinking in a portfolio-friendly package.

![status](https://img.shields.io/badge/status-v2.0%20industry--ready-success) ![stack](https://img.shields.io/badge/stack-vanilla%20JS%20%C2%B7%20Leaflet%20%C2%B7%20OSM-blue) ![ml](https://img.shields.io/badge/ML-OLS%20regression-purple) ![algorithms](https://img.shields.io/badge/algorithms-Haversine%20%C2%B7%202--opt%20%C2%B7%20Brute--force%20TSP-orange)

---

## Why this project stands out

Most "fleet management" student projects are CRUD apps with a map. FleetOS goes further:

| What recruiters look for | How FleetOS demonstrates it |
|---|---|
| **Algorithms beyond CRUD** | Haversine great-circle distance, Nearest-Neighbor TSP, 2-opt local search, brute-force optimal TSP for small *n*, capacity-aware co-loading with **peak-load timeline analysis**. |
| **Real machine learning** | Closed-form OLS linear regression trained in-browser on completed-trip telemetry to predict door-to-door ETA. Reports R², coefficients, and sample size — fully inspectable. |
| **Decision systems** | Multi-criteria scoring engine for truck assignment (7 weighted dimensions, hard-constraint filtering, explainable score breakdown per option). |
| **Proactive operations** | Maintenance scheduler with overdue/due-soon alerts and dashboard alert strips for delayed trips (predicted-ETA vs. wall clock). |
| **Engineering hygiene** | In-app self-test runner with unit-style assertions, deterministic seed data, JSON export/import, single-file architecture documented with section markers. |
| **Polish** | Editorial dark UI · Syne/DM Sans typography · semantic design tokens · accessible status badges · live Leaflet maps. |

---

## Live feature tour

### 1. Smart truck assignment on order creation
Every new order is **automatically ranked against every truck in the fleet** using a transparent weighted-score model. The top match is pre-selected; operators can override in one click with the score breakdown visible per row.

```
Score = 0.18·CargoCompat
      + 0.22·CapacityFit          (bell curve around 70% utilisation)
      + 0.18·DepotProximity       (km from truck home-depot to pickup)
      + 0.12·MaintenanceHealth    (km until next service)
      + 0.10·DriverExperience
      + 0.10·FuelEfficiency
      + 0.10·CurrentStatus
```

Hard blockers (wrong cargo type, over capacity, in maintenance) zero out the score and surface as red badges.

### 2. ML-based ETA prediction
A four-feature ordinary least-squares regression is trained on completed trips:

```
durationMinutes ≈ β₀ + β₁·distanceKm + β₂·stopCount + β₃·peakLoadTons
```

* Solved via closed-form `(XᵀX)⁻¹ Xᵀy` using a hand-written 4×4 Gauss-Jordan inverse — **no external ML library**.
* Falls back to a tuned heuristic (40 km/h + 8 min/stop) when fewer than 4 completed trips exist.
* Persisted to `localStorage` and surfaced in the Trip Planner result and Reports panel with R², coefficients, and trained-on sample size.
* Used at dispatch time to populate `estimatedFinishAt` — which then drives delay alerts.

### 3. Capacity-aware route optimization
* **Brute-force optimal TSP** for ≤ 7 stops (40,320 permutations).
* **Nearest-Neighbor + 2-opt** local search above that.
* **Peak-load timeline**: tracks running weight/volume after every pickup *and* drop along the route so a delivery that frees up space in the middle of a trip can correctly enable a later pickup. Greedy co-loader uses this to bin-pack orders by priority.

### 4. Maintenance scheduling
* Per-truck odometer, last-service-km, and configurable service-interval.
* Dashboard alert strip when any truck is overdue or within 500 km of service.
* Dedicated Maintenance view with one-click "Mark serviced" that resets the counter.

### 5. Upgraded analytics
* KPIs: on-time %, cost per km, fleet utilization, lifetime revenue, distance, fuel.
* Driver leaderboard and per-trip cost breakdown.
* ML model inspector with all learned coefficients.

### 6. Operations basics done right
Trucks · Drivers · Depots · Orders · Multi-stop Trip Planner · Live Leaflet Map · Reports · Settings · JSON Export/Import · Global search · In-app self-tests.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Vanilla JavaScript** (ES2020+) | Zero build, zero dependencies, runs from `file://`. Demonstrates fundamentals without a framework abstracting them away. |
| Maps | **Leaflet** + OpenStreetMap | Industry-standard open tiles, no API key. |
| Storage | **`localStorage`** | Honest stand-in for Postgres/Mongo at the demo scale; the `DB` module is a one-file swap from a real API. |
| ML | **In-browser OLS** | Trained, evaluated, and persisted entirely client-side — auditable and free. |
| Styling | Hand-written CSS with **semantic design tokens** + Syne/DM Sans | Production-style design system, not Bootstrap. |

---

## Running locally

```bash
# Any static server works — pick one:
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. Demo data auto-seeds on first run (18 orders, 7 trucks, 8 historical completed trips for ML training).

> Opening `index.html` directly via `file://` works too — Leaflet tiles still load.

---

## Architecture at a glance

```
index.html  ─ shell, sidebar, topbar, modal/toast roots
styles.css  ─ design system (tokens, components, dark editorial theme)
app.js      ─ single file, 8 sections clearly marked:
              §1 Utils
              §2 Geo / Routing algorithms       (Haversine, NN, 2-opt, brute-force TSP)
              §2.5 ML, Scoring, Maintenance     ← v2.0 industry layer
              §3 Database (localStorage CRUD)
              §4 Seed data (realistic Indian cities)
              §5 UI helpers (toast, modal, render)
              §6 Router
              §7 Views (Dashboard, Trucks, Drivers, Depots, Orders,
                        Trip Planner, Trips, Live Map, Maintenance, Reports, Settings)
              §8 Bootstrap + self-tests
```

The `Assigner`, `ML`, and `Maintenance` modules are **pure functions on plain data** — they can be lifted into a Node service or unit-tested in isolation with no changes.

---

## Roadmap to production

The codebase is structured so each of these is a focused, well-scoped change rather than a rewrite:

* Swap `DB` module for a thin `fetch`-based client against a real REST/GraphQL backend.
* Replace Haversine with OSRM/Mapbox driving distances for traffic-aware routing.
* Move ML training off the main thread into a Web Worker; persist the model server-side and add k-fold cross-validation.
* Add multi-tenant auth (Supabase / Auth0) and role-based access (dispatcher vs. driver vs. admin).
* Driver mobile companion app (PWA) for live GPS pings.
* Push notifications for delay/maintenance alerts.

---

## Self-tests

Settings → **Run tests**. Open DevTools to see:

```
✓ Mumbai→Pune ≈ 120 km
✓ Nearest-Neighbor returns full chain
✓ Optimized route ≤ naive route
✓ 100 km @ 10 km/L @ ₹100 = ₹1000
✓ Brute-force ≤ 2-opt
✓ ETA > 0 minutes
✓ Maintenance due-soon flag
✓ Maintenance overdue flag
✓ OLS β₁ recovers ≈ 3
```

---

## License & credits

MIT — fork it, ship it, mention it in your portfolio.
Originally built as a B.Tech IT Sem-5 mini-project, then upgraded to v2.0 with an industry-grade ML, assignment, and maintenance layer.

> Built to be the first project on a fresh résumé that a recruiter actually opens twice.
