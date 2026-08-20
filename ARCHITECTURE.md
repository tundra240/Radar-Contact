# Radar Ops: London Approach -- Build Plan & Architecture

Companion to `EGLL_Approach_Radar_Design.md`. That document defines *what* the game is;
this one defines *how* it gets built, in what language, and in what order.

---

## 1. Stack Decision

**TypeScript + Vite, a single `<canvas>` for the radar, plain DOM for the strip bay and
command console. Zero runtime dependencies.**

Verified locally: Node v26.7.0, npm 11.19.0. Python is not installed, which rules out a
pygame build without extra setup.

### Why this stack

| Concern | Rationale |
|---|---|
| **TypeScript over JS** | The bug-prone core is geometry and a per-aircraft state machine. Types on `Aircraft`, `Clearance` and `NavMode` catch the mistakes that actually happen here: mixing degrees with radians, screen pixels with nautical miles, cleared altitude with actual altitude. Worth the ten-minute setup. |
| **Vite** | Zero-config TS transpile, instant HMR (which matters a lot when tuning turn rates and colours by eye), single-command static build. |
| **No UI framework** | The radar is canvas, so React would only be managing ~20 flight strips. Not worth reconciling a 20 Hz simulation loop against a framework's render cycle. Strips are hand-rolled DOM, diffed at 5 Hz. |
| **No runtime deps** | Audio is synthesized with WebAudio oscillators, so there is no asset pipeline. The output is a static site that runs from any file server. |

Dev dependencies only: `vite`, `typescript`, `vitest`.

**Fallback:** if the build step is unwanted, everything below ports to vanilla JS in ES
modules with no structural change -- drop the type annotations and serve `index.html`
directly. The architecture does not depend on TypeScript.

---

## 2. The Foundational Decision: Three Coordinate Spaces

The design doc stores fixes and runway thresholds as raw pixels (`threshold_pos: [450, 400]`,
`LAM: [700, 150]`) while the rules are in nautical miles (3 NM separation, 20 NM range rings).
That works for exactly one canvas size, and it fights both the multi-airport goal and window
resizing. Fixing it costs an afternoon now and saves rewrites on Day 2 and Day 3.

```
   GEO SPACE                 WORLD SPACE                  SCREEN SPACE
   lat / lon      ------>    x,y in NM from ARP  ------>   x,y in device px
   (config data)  project    +x = East, +y = North         camera transform
                  once at    altitude in ft AMSL           (pan, zoom, DPR)
                  load
                             ^ ALL physics, separation
                               and ILS geometry live here
```

1. **Geo space** -- real lat/lon in the airport JSON. Projected once at load through a local
   tangent-plane approximation about the Airport Reference Point:
   `x_nm = dLon * cos(lat_ref) * 60`, `y_nm = dLat * 60`. Accurate to well under a tenth of
   a mile across a 40 NM terminal area.
2. **World space** -- nautical miles, origin at the ARP. Every rule in the design doc is
   expressed natively here: separation, range rings, the 30 deg intercept cone, FAF distance.
   Altitude is a separate scalar in feet, never folded into the 2D vector.
3. **Screen space** -- pixels, produced by one camera object
   `{ centreNM, pxPerNM, canvasSize, dpr }` and two functions, `worldToScreen` and
   `screenToWorld`. Pan, zoom, range-scale selection, high-DPI crispness and window resize
   all fall out of this for free, and nothing else in the codebase ever touches a pixel
   coordinate.

### Conventions, fixed once

- **Headings** are compass degrees: 0 = north, increasing clockwise, always normalized
  to `[0, 360)`.
- **Velocity in world space** is `vx = gs * sin(hdg)`, `vy = gs * cos(hdg)`.
  The doc's `dy = -v * cos(hdg)` bakes screen-space y-down into the physics; that negation
  belongs in the camera transform, not the flight model.
- **Angular differences** always go through one `angleDelta(a, b) -> [-180, 180]` helper.
  Hand-rolled wraparound arithmetic is the most reliable source of bugs in this genre.

### Two inconsistencies in the design doc to settle

- Runway heading is given as `272` in the JSON but headings elsewhere in the doc use `270`.
  The real 27L/27R bearing at Heathrow is about 270 deg magnetic. Config carries one field,
  `bearingTrue`, and the centreline, intercept cone and glideslope all derive from it.
  Recommend **270** for clean mental maths; it is a one-line change if realism is preferred.
- The north-west feeder fix is written `BOVN`; Bovingdon's actual navaid identifier is
  **BNN** (the four classic Heathrow holds being LAM, BIG, BNN and OCK). Cosmetic, but free
  to get right.

---

## 3. Module Architecture

```
radar-ops/
  index.html
  package.json
  tsconfig.json
  src/
    main.ts                 bootstrap: load config, build world, wire UI, start loop

    core/
      loop.ts               fixed-timestep accumulator; sim 20 Hz, render on rAF
      geo.ts                lat/lon -> NM projection, distance, bearing, angleDelta
      camera.ts             world <-> screen, pan/zoom, DPR-aware resize
      rng.ts                seeded PRNG (mulberry32) -- reproducible traffic and replays

    sim/
      types.ts              Aircraft, Clearance, NavMode, Conflict, WakeCategory
      world.ts              owns the aircraft list; tick(dt); emits domain events
      aircraft.ts           integration: turn, climb/descend, accelerate, advance position
      autopilot.ts          drives actual state toward cleared state, rate-limited
      ils.ts                localizer/glideslope arm, capture test, tracking guidance
      separation.ts         conflict detection plus wake-category minima
      spawner.ts            arrival generation, flight plans, difficulty ramp

    commands/
      parse.ts              "BAW178 H270 A30 S180" -> Command[]
      apply.ts              validate against flight envelope -> accept + readback | reject

    render/
      radar.ts              per-frame draw orchestration, fixed layer order
      theme.ts              every colour, font and line weight -- one file
      layers/
        background.ts       range rings, sector boundary, compass rose
        airport.ts          runways, extended centrelines, FAF and mile ticks
        fixes.ts            feeder fixes, hold racetracks
        targets.ts          blips, fading history trails, speed vectors
        datablocks.ts       leader lines, three-line blocks, de-overlap placement
        alerts.ts           conflict rings, flash timing

    ui/
      interaction.ts        select, rubber-band heading drag, scroll alt/speed
      stripbay.ts           flight progress strips (DOM), quick-action buttons
      console.ts            command bar: history, autocomplete, readback log
      hud.ts                clock, score, landing rate, wind, time-acceleration

    audio/
      sfx.ts                WebAudio-synthesized chimes, beeps, conflict alarm

    data/
      egll.json             airport configuration
      airport.ts            typed loader, validation, geo -> world projection
```

### Design decisions worth stating explicitly

**1. Fixed-timestep simulation, decoupled rendering.**
The sim advances in fixed 50 ms steps via an accumulator; rendering happens on
`requestAnimationFrame` and interpolates. Physics become frame-rate independent, and pause
plus 1x/2x/4x time acceleration become trivial. The latter matters enormously for
playtesting a game where a single aircraft takes four minutes to fly an approach.

**2. Aircraft are data; behaviour lives in functions.**
Each `Aircraft` record holds two parallel sets of fields:

```ts
interface Aircraft {
  // identity
  callsign: string; type: string; wake: WakeCategory;
  // ACTUAL state -- what the radar sees
  pos: Vec2NM; altFt: number; hdg: number; gsKts: number; vsFpm: number;
  // CLEARED state -- what the controller has instructed
  clearedHdg: number | null; clearedAltFt: number; clearedSpdKts: number;
  navMode: NavMode; clearedApproach: RunwayId | null;
  // presentation and bookkeeping
  trail: Vec2NM[]; strip: StripState; spawnedAt: number;
}
```

Each tick, `autopilot.ts` moves actual toward cleared under rate limits (3 deg/s turn,
1500 fpm, roughly 1 kt/s acceleration). This mirrors how real ATC sims are built, it makes
the ILS just another nav mode rather than a special case, and it means the data block
renderer can show `actual -> cleared` on every line with no extra plumbing.

**3. An explicit nav-mode state machine.**

```
  SPAWN --> HOLD <--> HEADING/VECTOR --> LOC_ARMED --> LOC_CAPTURED
                                                            |
                                                            v
              GO_AROUND <---------------- GS_TRACKING --> LANDED
```

`CLEARED ILS` only *arms* the capture. Each tick the armed test checks all three conditions
from the design doc together -- lateral offset from the centreline, intercept angle <= 30
deg, altitude <= 3000 ft -- plus, crucially, that the aircraft is on the approach side of
the threshold and closing. Checking closure prevents the classic bug where an aircraft
crossing the localizer at 90 deg snaps onto final, and the classic exploit where one
captures from behind the runway.

**4. One source of truth, event-driven periphery.**
`World` is authoritative. Renderers and UI read it and never mutate it. `World` emits
`spawn`, `landed`, `handoff`, `conflictStart`, `conflictEnd` and `goAround`, so audio and
scoring subscribe rather than poll, and the strip bay repaints on change at about 5 Hz
instead of on every one of the 20 sim ticks per second.

**5. All three input paths converge on one `Command` type.**
Mouse rubber-band, strip quick-button and typed console text all produce the same `Command`
objects, which flow through the same validation in `apply.ts`. One code path to test, one
readback format, and a command log that -- combined with the seeded RNG -- makes any
session exactly replayable. This is the highest-leverage structural choice in the plan.

**6. Airport data is data.**
No module ever branches on `"EGLL"`. Adding Gatwick means adding `egkk.json`. The loader
validates the config and performs the geo -> world projection, so a malformed airport file
fails loudly at startup rather than rendering a subtly wrong scope.

---

## 4. Airport Configuration Format

Replaces the pixel-based schema in the design doc. Positions become real coordinates; the
camera decides pixels at render time.

```jsonc
{
  "icao": "EGLL",
  "name": "London Heathrow",
  "arp": { "lat": 51.4775, "lon": -0.4614 },      // origin of world space
  "magVar": -0.5,
  "elevationFt": 83,
  "sector": {
    "radiusNM": 40,
    "ceilingFt": 15000,
    "floorFt": 1500,
    "speedLimitBelowFL100": 250,
    "rangeRingsNM": [5, 10, 15, 20]
  },
  "runways": [
    {
      "id": "27R",
      "threshold": { "lat": 51.4647, "lon": -0.4342 },  // verify against chart
      "bearingTrue": 270,
      "lengthFt": 12802,
      "ils": {
        "available": true,
        "glideslopeDeg": 3.0,
        "fafDistNM": 10,
        "minInterceptDeg": 30
      }
    },
    { "id": "27L", "note": "roughly 1415 m south of 27R -- verify" }
  ],
  "fixes": [
    { "name": "LAM", "lat": 51.646, "lon":  0.151,
      "hold": { "inboundTrue": 233, "turns": "right", "legMins": 1 } },
    { "name": "BIG", "lat": 51.331, "lon":  0.035,
      "hold": { "inboundTrue": 304, "turns": "right", "legMins": 1 } },
    { "name": "BNN", "lat": 51.726, "lon": -0.549,
      "hold": { "inboundTrue": 116, "turns": "right", "legMins": 1 } },
    { "name": "OCK", "lat": 51.305, "lon": -0.447,
      "hold": { "inboundTrue":  32, "turns": "right", "legMins": 1 } }
  ],
  "aircraftTypes": [
    { "type": "A320", "wake": "M", "cruiseKts": 250, "approachKts": 140 },
    { "type": "B789", "wake": "H", "cruiseKts": 280, "approachKts": 150 }
  ]
}
```

The latitudes and longitudes above are approximate and flagged for verification against a
current chart or an open dataset before they are trusted; the four fixes themselves are the
real Heathrow holds. Nothing in the code depends on their precision, so they can be refined
at any point without touching a module.

---

## 5. Revised Roadmap

The design doc's three days hold, with a short foundation block pulled to the front. The
coordinate system and the game loop are what Days 2 and 3 would otherwise have to be
rewritten around.

### Day 0 -- Foundation (about 3 hours)
Scaffold Vite, TS and Vitest. Implement `geo.ts`, `camera.ts`, `loop.ts`, `theme.ts` and the
airport loader with `egll.json`. Unit-test the geo maths.
**Milestone:** a scope with range rings, a compass rose and the two runways drawn in correct
relative geometry, which survives a window resize and pans and zooms cleanly.

### Day 1 -- Physics and Rendering
`types.ts`, `aircraft.ts`, `autopilot.ts`, `world.ts`, then the target, trail and data block
layers, including de-overlap placement for the blocks.
**Milestone:** several hard-coded aircraft flying, turning and descending on command from a
dev console, with correct three-line data blocks and fading trails.

### Day 2 -- Control and ILS
`commands/parse.ts` and `apply.ts`. Then all three input paths: `interaction.ts` (select,
rubber-band drag, scroll wheel), `stripbay.ts`, `console.ts`. Then `ils.ts` -- arm, capture,
localizer track, glideslope descent, touchdown.
**Milestone:** you can vector an aircraft from LAM onto 27R by hand, by mouse or by typed
command, and watch it land.

### Day 3 -- Game
`separation.ts` with conflict rings and flashing alerts, `spawner.ts` with a difficulty
ramp, `sfx.ts`, `hud.ts`, scoring, and a game-over summary.
**Milestone:** a playable game with pressure.

### Beyond the three days
Departures off 27L; wake-turbulence minima properly enforced (4/5/6 NM behind a heavy rather
than the flat 3 NM the MVP uses); go-around handling; handoff to Tower; wind and its effect
on groundspeed; Gatwick as the proof that the config abstraction holds.

---

## 6. Testing

Vitest over the pure modules, which by design is where the hard logic lives:

- `geo.ts` -- projection round-trips, bearing and distance against known pairs, `angleDelta`
  wraparound across 359 / 001.
- `parse.ts` -- every command form in the design doc, plus malformed input.
- `ils.ts` -- capture accepted inside the cone; **rejected** at a 45 deg intercept, at
  5000 ft, from behind the threshold, and when crossing the centreline outbound.
- `separation.ts` -- 2.9 NM co-altitude is a conflict; 2.9 NM with 1100 ft is not.
- `autopilot.ts` -- a 350 -> 010 turn goes right through north, not 340 deg the long way.

Rendering and interaction get checked by eye, which is what HMR is for.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Data blocks overlap illegibly at high density | De-overlap pass on Day 1, not Day 3; leader lines are draggable as the escape hatch. |
| ILS capture edge cases (overshoot, wrong-side capture) | Closure and side checks inside the capture test; the five unit tests above written before it is wired to the UI. |
| The three-day scope is tight | Day 0 exists precisely so that nothing needs rewriting later; departures and wake minima are already parked as post-MVP. |
| Tuning feels wrong (turn rates, spawn pressure, scoring) | Every constant lives in `theme.ts` or in config, never inline; time acceleration makes a full approach testable in under a minute. |
| Performance | A non-issue. Under 30 targets, O(n^2) separation is roughly 400 comparisons per tick. No spatial index needed. |

---

## 8. Open Questions

1. **Radar background shade.** Section 2 of the design doc describes the background as
   "charcoal slate beige" without a hex value, which reads as a conflict between a
   near-black and a warm light tone. `theme.ts` holds this as a single `bg` token plus a
   derived set of line and text colours, so it is one edit either way -- but the direction
   changes every other colour in the palette, since the existing neon teal, green and
   crimson accents assume a dark ground and would need desaturating and darkening
   substantially to stay legible on a light one. Worth pinning down before Day 0.
2. **Runway mode.** The MVP lands both 27R and 27L. Real Heathrow segregates arrivals and
   departures and alternates at 15:00. Mixed-mode is simpler and is what is planned; the
   config can carry a `mode` field later.
3. **Scoring weights.** Landings versus separation losses versus average holding time.
   Worth leaving as tunable constants and settling by feel on Day 3.
