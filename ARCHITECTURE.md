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

The live file is `src/data/egll.json`; the loader is `src/data/airport.ts`.

Provenance: the airport reference point, runway threshold coordinates, elevations and
displaced thresholds come from the OurAirports open dataset (`airports.csv`, `runways.csv`);
navaid positions and frequencies from `navaids.csv`. Retrieved 2026-08-21 and recorded in a
`provenance` block inside the JSON.

Key values as loaded:

| Item | Value |
|---|---|
| ARP | 51.470748 N, 0.459909 W, 83 ft |
| 27R threshold | 51.477681 N, 0.433227 W -- 0.997 NM E, 0.416 NM N of ARP |
| 27L threshold | 51.464957 N, 0.434048 W -- 0.967 NM E, 0.347 NM S of ARP |
| 27R / 27L centreline separation | 0.764 NM (1415 m), matching the published figure |
| Runway bearing | 270 true published; 269.7 computed from the thresholds |
| LAM (Lambourne) | 25.1 NM on 065 -- VOR-DME 115.60 |
| BIG (Biggin) | 20.3 NM on 114 -- VOR-DME 115.10 |
| BNN (Bovingdon) | 15.7 NM on 348 -- VOR-DME 113.75 |
| OCK (Ockham) | 10.0 NM on 177 -- VOR-DME 115.30 |

Two things the real data changed:

- **The four holds are not diagonal corners.** The design doc frames them as NE / SE / NW /
  SW entries. In fact LAM and BIG are both well to the east, BNN is almost due north and OCK
  almost due south. Anything assuming diagonal symmetry -- spawn placement, hold rendering,
  sequencing hints -- has to cope with the real layout.
- **3000 ft and the 10 NM FAF are not the same point.** A 3 degree glideslope climbs
  318.4 ft/NM, putting it at about 3262 ft AMSL over the 10 NM FAF. An aircraft levelled at
  the 3000 ft intercept altitude is therefore *below* the glideslope at the FAF and captures
  it from underneath at about 9.2 NM. That is correct procedure, but `ils.ts` must not treat
  reaching the FAF and reaching the glideslope as one event.

All bearings in the config are TRUE. `magVarDeg` is 0, because magnetic declination over
London is currently within about a degree of zero, so true and magnetic are interchangeable
for gameplay; the roughly 2.2 degrees west of slaved variation in the source dataset reflects
older VOR calibration epochs and is deliberately unused. Hold inbound legs are not published
in the open dataset, so the loader derives each one as the bearing from the fix to the field
and flags it with `inboundIsDerived`; real STAR data overrides it per fix.

### Surrounding traffic picture

The config carries three further sections, all projected by the same loader:

- **`navaids`** -- thirteen VOR/VOR-DME within about 45 NM, with real frequencies. The four
  approach holds (LAM, BIG, BNN, OCK) are entries in this list that additionally carry a
  `hold` object, so there is one source of navaid truth rather than two overlapping ones.
  `airport.holdingFixes` is the derived subset.
- **`airports`** -- fifteen aerodromes within roughly 40 NM: Northolt, London City, Biggin
  Hill, Gatwick, Luton, Stansted, Farnborough, Blackbushe, Fairoaks, Denham, Elstree, Wycombe,
  Redhill, Odiham and Oxford. Each carries its longest runway so the strip can be drawn on its
  real bearing rather than as a generic dot.
- **`airspace`** -- the London TMA, six control zones and ten aerodrome traffic zones.

Note that the **BIG VOR sits on Biggin Hill aerodrome**, about 160 m from its reference point.
That is real, not a data error, and it means a holding fix symbol and an aerodrome symbol
land on top of each other; the renderer has to tolerate collisions rather than assume they
cannot happen. There is a test pinning it.

### Airspace: what is published and what is derived

Airspace boundaries come from the **VATSIM UK Sector File**, an open transcription of UK
airspace. See `ATTRIBUTION.md` -- it is GPL-3.0, which has consequences for how this project
can be distributed.

| Volume type | Count | Geometry | Drawn |
|---|---|---|---|
| London TMA | 20 volumes, class A, 2500 ft to FL195 | Published line work | Solid |
| CTRs and CTAs | Heathrow, City, Gatwick, Luton, Stansted, Farnborough | Published line work | Solid |
| ATZ / MATZ | Biggin Hill, Wycombe, Odiham | Published circles | Solid |
| Other traffic zones | 7 fields the source omits | UK rule: 2 NM to 1850 m of runway, else 2.5 NM, to 2000 ft aal | Dotted |

**They are line work, not polygons.** This is the single most important thing to know about
this data. Each record in the source is an independent boundary line, and when chained, only
**2 of 60** regions closed into a ring -- the rest left gaps of up to 30 NM. Storing them as
polygons would have drawn thirty-mile edges that do not exist. So a volume's shape is
`lines`: one or more OPEN polylines, stroked without closure.

The consequence to plan around: a `lines` volume **cannot answer "is this aircraft inside the
zone"**. Containment needs ordered closed rings. If the simulation ever needs that -- for
airspace infringement warnings, say -- it is separate work: either order and close the rings,
or transcribe closed boundaries from the AIP. The schema keeps `polygon` for exactly that,
and a test loads one to prove the path works.

`derivation` records where each boundary came from and the line style follows it, so the
display never implies more precision than the data has: **solid** published, **dotted**
rule-derived. `verticalSource` does the same for altitudes -- `file` from the source header,
`rule` for ATZ tops at 2000 ft aal, `assumed` where the header omitted limits (London City
CTA, both Gatwick volumes, the Odiham MATZ). Assumed limits render in parentheses.

Using the published data earned its keep immediately: **Biggin Hill's ATZ is notified as
2.5 NM**, where the runway-length rule gives 2 NM. The rule was wrong, and the source
corrected it.

### Chrome and readouts

The interface furniture is deliberately in the idiom of early-2000s terminal software:
square corners, two-pixel bevels, uppercase letter-spaced labels. A bevel is a light edge
along the top and left with a shadow edge along the bottom and right, and the two swapped to
read as sunken -- so each palette carries `chromeFace`, `chromeLight`, `chromeShadow`,
`chromeWell`, `chromeText` and `chromeDim` rather than deriving them with a filter, which
would fall apart between a light and a dark ground.

Two separate mechanisms, one source of truth:

- **On the scope**, `render/scope.ts` draws the title block and the status bar itself with a
  `bevel()` helper. Readouts sit in sunken cells as label/value pairs. Layout uses monospace
  advance-width arithmetic rather than `measureText`, so it is deterministic and testable
  without a real canvas. Cells are dropped when the window is too narrow rather than allowed
  to spill, and the key hints go first.
- **The DOM controls** get their colours as CSS custom properties set from the active palette
  in `main.ts`, so the stylesheet owns the bevel geometry and `theme.ts` stays the only
  place a hex value is written down. Checkboxes are restyled to square sunken indicators,
  because a platform checkbox would break the period immediately.

Drawing the readouts on the scope rather than in an HTML status bar is also the more faithful
choice: displays of this era put their data on the tube.

### Overlay density

`render/overlays.ts` defines which layers are optional and three presets over them
(minimal, standard, full), with the panel built from the same list so a key cannot exist in
the render path without being switchable. The split is deliberate: the runways being worked,
the holding fixes, the sector boundary and the readouts are **always drawn**, because they
are the job. Everything else -- controlled airspace, class G traffic zones, airspace labels,
other aerodromes, non-hold navaids, navaid frequencies, range rings, extended centrelines --
is context that helps or clutters depending on what you are doing.

Class G traffic zones are switched separately from controlled airspace, because there are
ten of them and they are small enough to be noise at range. The preference persists in local
storage, read key by key rather than trusting the stored blob, so a stale entry cannot put a
non-boolean into the render path.

### Zoom limits

The camera's zoom ceiling is a constructor argument, not a constant: how far out is useful
depends on the size of the sector. `main.ts` passes twice the area of responsibility, so
EGLL's 40 NM sector gives an 80 NM maximum -- far enough to see what is coming, close enough
that the sector still fills the scope. `MAX_RANGE_NM` remains as a fallback only.

### Display scale

Runways are about two miles long inside a forty mile sector, so at the default range they
collapse to a couple of dozen pixels. `render.runwayExaggeration` (3) magnifies the painted
strip, fading linearly to true scale by `exaggerationCutoffPxPerNM` (45), and the current
factor is shown on the display. It is applied **from the threshold**, so the threshold, the
extended centreline, the FAF and every future approach calculation stay exactly where they
really are -- the exaggeration is paint, never geometry. Neighbouring aerodromes get
`neighbourRunwayMinPx` instead, a floor on drawn length, because a 900 m grass strip is a
third of a pixel at 40 NM.

---

## 5. Revised Roadmap

The design doc's three days hold, with a short foundation block pulled to the front. The
coordinate system and the game loop are what Days 2 and 3 would otherwise have to be
rewritten around.

### Day 0 -- Foundation  [DONE]
Scaffold Vite, TS and Vitest. Implement `geo.ts`, `camera.ts`, `loop.ts`, `theme.ts` and the
airport loader with `egll.json`. Unit-test the geo maths.
**Milestone reached.** `core/geo.ts` (projection, bearings, angleDelta), `core/camera.ts`
(world/screen transform, pan, zoom, range-preserving resize), `data/egll.json` with real
coordinates, `data/airport.ts` (validating loader), `render/theme.ts` and `render/scope.ts`
(range rings, runways, extended centrelines with FAF ticks, holds). 56 unit tests, including
the projection measured against great-circle distance and a headless render check that the
scope geometry lands on the right pixels.

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

1. **Radar background shade -- DECIDED: beige.** The display now runs a warm chart-paper
   ground with dim, saturated accents, after the early-2000s terminals that drew dark
   symbology on a light surface. As predicted, this was a repaint rather than a token swap:
   the accents were retuned whole, because a colour that glows on black turns to mud on
   beige. Both palettes live in `render/theme.ts` as `palettes.beige` and `palettes.dark`,
   and the active one is a single named export, so reverting or adding a third scheme is one
   line -- and there is now a light/dark button in the top right, plus `D`, so the choice is
   the player's at runtime and the preference persists in local storage. Remaining
   sub-question: whether aircraft symbology in Day 1 wants a fourth accent
   for "established on ILS" that reads against beige without competing with the amber used
   for holds.
2. **Runway mode.** The MVP lands both 27R and 27L. Real Heathrow segregates arrivals and
   departures and alternates at 15:00. Mixed-mode is simpler and is what is planned; the
   config can carry a `mode` field later.
3. **Scoring weights.** Landings versus separation losses versus average holding time.
   Worth leaving as tunable constants and settling by feel on Day 3.
