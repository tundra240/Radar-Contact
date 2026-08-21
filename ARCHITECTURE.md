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

### The map underneath

`geography` is a fourth section, holding the things the airspace sits on top of: the
**coastline**, the **River Thames** and the **London FIR boundary** -- the lateral limit of UK
airspace. `ATTRIBUTION.md` has the sources; `tools/build-geography.mjs` regenerates the block
from the original downloads and reproduces the committed data exactly.

**Why not part of `airspace`.** None of the three is an airspace volume. There is no class and
no vertical extent to a coastline, and forcing one in would mean inventing a floor, a ceiling
and a class letter for a shoreline. So `geography` has its own small schema and its own
provenance vocabulary: `survey | aip`, rather than airspace's `aip | rule | approx`. Calling a
surveyed shoreline "aip" would be a small lie in the data, and the point of keeping these
vocabularies separate is that neither has to stretch.

**Zoom is unchanged.** The map extends what is *drawn*, not how far out the scope will go: the
ceiling is still twice the area of responsibility. What the coastline fixes is that zooming out
to that ceiling used to show empty ground.

**Chunking, and why the obvious cull does not work.** The renderer rejects a whole path on its
bounding box before projecting any of its points. Done naively that achieves nothing: one
Natural Earth path runs from the Bristol Channel round the south coast to East Anglia, and its
bounding box *contains Heathrow*, so it would never be rejected however far the scope zoomed
in. The build script therefore splits every path into chunks spanning at most 12 NM, and
inserts colinear points along any segment longer than 8 NM so that long straight legs -- the
FIR boundary is published as a handful of 60 NM legs -- have somewhere to be cut. The drawn
line is identical; the boxes are tight enough for the test to mean something. 2801 points in
307 chunks, and at close range almost all of them are rejected on two comparisons.

**The river is drawn at its real width.** `GeoPath` carries an optional per-point width in NM,
and the Thames is stroked in pixels derived from it -- a thread at Windsor, visibly a mile
across off Canvey, and wider as the scope zooms in because it is a width rather than a line
weight. Segments of equal drawn width are batched into one stroke, so the 150-point river costs
a handful of draw calls rather than 150. Two honest caveats: the widths are **interpolated from
a table of fifteen real widths**, because the source is a bare centreline, and there is a
one-pixel floor so the upper river does not vanish when zoomed out.

**Water is water.** The river takes the coastline's colour rather than a third one. The kinds
are separated by colour and weight, never by dash pattern, because in this codebase dashes mean
provenance -- reusing that vocabulary to mean "different kind of thing" would break the one
convention the display is most careful about.

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

### Colour

The palettes are period references rather than a light and a dark theme of the same design.
`beige` follows the desktop software of the era: a warm tan tube at `#c3bda9`, an interface
face in the canonical `#d4d0c8` with a white highlight and a mid-grey shadow, and symbology
taken from the VGA system colours -- navy for class A, purple for the control zones, olive
for class G, teal for navaids, burnt amber for holds. Those are dark and saturated, which is
what survives on a light ground; a modern neon turns to mud there. `dark` is the same
instrument as a colour CRT: near-black with bright cyan symbology and phosphor amber for the
holds. `amber` is a monochrome phosphor tube, and being monochrome is the constraint that
makes it interesting: the airspace classes cannot be separated by hue, so they are separated
by brightness the way a single-gun display had to, and the brightest thing on the scope is
whatever traffic is holding at.

Schemes cycle rather than toggle -- `PALETTE_ORDER` is the single place that order is
stated, and the control, the keyboard shortcut and the stored preference all read from it, so
adding a fourth scheme is a palette plus one array entry.

Legibility is a test, not a hope. `theme.test.ts` measures WCAG contrast for every colour
against its own ground and asserts that primary text and runways clear 4.5:1, all symbology
clears 3:1, dim text clears 3.5:1, and the grid furniture stays in a band -- faint enough to
recede, but never invisible. There is an **upper** bound on the grid deliberately: rings that
shout compete with the traffic. Writing those tests immediately caught two things by eye I
would have missed: the per-mile centreline ticks are symbology rather than furniture, because
they are how spacing is judged, and the dark palette's bevel highlight was too weak to read
as raised.

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
- **The window furniture** leans on two details that place the era immediately: a flat
  saturated caption strip on the menu panel -- navy with white lettering in the beige
  scheme -- and a two-pixel sunken edge around the whole scope, so the display reads as a
  viewport recessed into an application window rather than a picture filling the browser.
- **The DOM controls** get their colours as CSS custom properties set from the active palette
  in `main.ts`, so the stylesheet owns the bevel geometry and `theme.ts` stays the only
  place a hex value is written down. Checkboxes are restyled to square sunken indicators,
  because a platform checkbox would break the period immediately.

Drawing the readouts on the scope rather than in an HTML status bar is also the more faithful
choice: displays of this era put their data on the tube.

### The options menu

Every setting -- as opposed to every instruction -- lives behind one button in the corner of
the scope, in `ui/menu.ts`: the simulation rate and pause, interface sound, the display scheme
and the overlay layers. Before that each was its own floating control, which cost three rows
of chrome over the radar picture and gave no clue that they belonged together.

Three things make it hold together:

- **The menu is a view, not a state holder.** The loop owns the rate, `theme.ts` owns the
  palette, `main.ts` owns the overlay record. The menu reports clicks through callbacks and is
  told what to display by a single `paint(state)` call, so a change made from the keyboard and
  a change made from the menu cannot end up disagreeing. The only state it keeps is whether it
  is open.
- **Nothing is enumerated twice.** The rates come from `SPEEDS`, the schemes from
  `PALETTE_ORDER`, the layers from `OVERLAY_ITEMS`. A rate or a layer cannot exist in the
  simulation or the render path without being reachable in the menu.
- **Hiding the controls must not hide the state.** The status bar already draws the clock and
  the current rate on the tube, so the menu can be shut without losing sight of whether time
  is running and how fast. `D` also still cycles the schemes directly, because comparing them
  is a by-eye decision that should not need a panel open over the picture.

The schemes became named buttons rather than the old cycling toggle: with three of them,
picking the one you want beats pressing until it comes round. The active rate and scheme are
drawn pressed in, in the caption colours, so the current setting reads at a glance instead of
by comparing four buttons with each other.

### The command system

Three modules, and the split between them is the point.

**`commands/parse.ts`** turns a typed line into `Command` objects and knows nothing about
aircraft state. It is forgiving in the ways that cost nothing -- verb glued to its value or
apart from it, abbreviated or spelled out, callsign shortened to anything unique or omitted in
favour of the selected strip -- and strict in one place: an altitude has to be unambiguous.
`A30` is 3,000 ft and `A3000` is 3,000 ft, told apart by **length rather than magnitude**,
because a magnitude threshold is a rule nobody could guess and a mistyped altitude is the most
expensive kind of typo in this game.

**`commands/apply.ts`** is the gate. It validates against the sector and the type's envelope
and returns a new aircraft plus a readback, or a refusal with a reason. Pure, and given
everything it needs through `ApplyContext`, so it is tested without a DOM, a clock or a config
file.

Two decisions in it worth defending:

- **It refuses rather than clamps.** Silently turning "descend 200" into the sector floor
  teaches the controller that the number they typed was accepted. The refusals say why: an
  A320 asked for 90 kt is told it will not fly below 140, not just "no".
- **A line is all or nothing.** `applyAll` threads the aircraft through each command and
  abandons the lot on the first refusal, so `H270 A30 S400` does not leave the aircraft turned
  and descending before complaining about the speed. It also means each instruction is judged
  against the ones before it in the same line -- the descent below 10,000 ft is what makes
  280 kt illegal, and both can be in one line.

**`ui/console.ts`** is a dumb terminal: a prompt, a log, and a history. It does not know what a
command is. The history keeps refused lines deliberately, because a refused line is usually one
character away from a good one.

The seam that matters is that `main.ts` routes the **tag menu through the same `issue()`
path** as the typed line. That is decision 5 in section 3 finally paying off: one validation
path, one readback format, and the mouse rubber-band will join it without a third
implementation of "is this clearance legal".

A clearance sets the CLEARED fields and never the actual ones -- `autopilot.ts` closes the gap
at 3 deg/sec, 1500 fpm and 1.5 kt/sec. An integration test runs the whole chain, from a typed
line through the parser and the gate into the autopilot, and asserts the aircraft is actually
turning ten seconds later.

The handoff command **parses but is refused**, with a reason saying it is not flyable yet: it
needs somewhere to hand off to. The alternative -- accepting a clearance and doing nothing with
it -- would be worse than the refusal.

Two clearances refuse for reasons worth noting. A **level is refused once established on the
glidepath**, because the path owns the level from there and accepting one the approach would
overwrite on the next tick is exactly what this module exists not to do. A **speed is still
accepted**, because that is how traffic is spaced on final. And a **heading breaks an aircraft
off an approach** at any stage, clearing the approach with it -- otherwise the next tick would
steer it straight back onto the localiser.

### The area of responsibility

The sector circle is what the controller owns, and three things now follow from it.

**The map outside it is washed back towards the ground colour.** One path -- the whole display
with the sector punched out of it, filled odd-even -- at partial alpha over the finished map,
before the traffic. Drawn there so that all of the map is covered and none of the traffic is,
and the boundary itself and its cardinals are then drawn *over* the wash, so the one line that
matters most is also the crispest thing on the display. The alpha is set back to 1 explicitly
rather than by save/restore, because a leaked alpha would dim everything drawn after it.

**Arrivals are released outside it and fly in.** `entryDistanceNM` is measured from the
boundary rather than from the fix, so every feed hands traffic over at the same range whether
its fix is ten miles out or twenty-five. Traffic is therefore visible and identifiable for a
couple of minutes before it can be worked, which is most of what makes a sequence plannable.

**Nothing outside it takes a clearance.** `applyCommand` refuses every kind, by name, before it
looks at the command at all -- that is the rule that makes a boundary mean something rather than
being a circle on a display. The interface agrees rather than duplicating: `pickTarget` is given
only the traffic inside, so an aircraft that is not yours cannot be clicked, dragged or
right-clicked either.

`entered` on the Aircraft record is what holds this together. Being outside the boundary means
two opposite things -- not yours yet, or gone -- and nothing about a position distinguishes
them. It also drives the display: dimmed targets, the strip bay's third group, and the
distinction between an aircraft that has never arrived and one that has left.

Two things that had to be got right and were not obvious:

- **The concurrency cap counts everything, inbound included.** Capping on in-sector traffic
  alone let an unbounded queue build up outside waiting to come in -- sixty-five aircraft in a
  measured hour. Inbound traffic transits in a couple of minutes, so counting it costs two or
  three off the workload and bounds the world.
- **There is an outer limit.** An inbound aircraft turned away never enters, so the "has been
  inside and now is not" rule can never fire for it and it would fly outward for ever. Nothing
  exists beyond the ring arrivals are released on, plus a little.

### The score

`sim/score.ts`. Two events move it, because two things happen to an arrival: +100 for a
landing, -50 for one lost off the boundary. Losing one costs less than landing one earns, so a
session that lands most of its traffic still climbs; it is a penalty, not a punishment.

Deliberately not more. A score built out of things the simulation does not model yet -- conflicts,
go-arounds, delay against a schedule -- would be a number that means nothing. It is a value
rather than a counter object, so what a session came to is a single thing you can hold, compare
and replay to, in the same spirit as the seeded traffic.

### Coming off the scope

An aircraft leaves the world for exactly two reasons, and `departureOf` in `sim/aircraft.ts` is
the only thing that decides which: it landed, or it crossed the sector boundary. Both are
announced in the console -- the landing as a readback, the departure as a refusal, because an
arrival that leaves unlanded is one you lost and the log should read like it -- and the status
bar carries both counts, since a landing rate means nothing without knowing what it cost.

Two things about that were wrong and are worth recording, because both looked like a bug from
the scope:

- **The boundary used to be five miles outside the one that is drawn.** Removal was at the
  sector radius plus a margin, and the only circle on the display is the radius itself. So a
  target crossed the visible edge, flew on through empty space, and vanished at an invisible
  line. The margin is gone: the line you can see is the line that matters.
- **Leaving was silent.** No message, no counter, nothing in the log. Landing had a readback
  from the day it worked; leaving had a bare `continue`.

Related, and found while checking the first: **an arrival must be released inside the boundary.**
LAM's fix is 25 NM out of a 40 NM sector, so a twelve mile entry puts its arrivals at 37 NM --
three miles of headroom. A slightly larger `entryDistanceNM` would have released them outside
the boundary, to be removed on the tick they appeared, which on the scope is a target flickering
into existence and disappearing. The spawner now pulls the entry point in to keep it inside, and
a test asserts every release from every fix lands inside the boundary.

### The ILS

`sim/ils.ts`. `CLEARED ILS` only **arms** the capture; every tick the armed test asks all six
questions together, and an aircraft that fails any of them flies straight through on the vector
it was given and has to be taken round again -- which is what makes setting up an intercept a
job worth doing:

    1. on the approach side of the threshold      (not behind it)
    2. inside localiser coverage
    3. within half a beam width of the centreline
    4. within maxInterceptDeg of the inbound course
    5. at or below the intercept altitude
    6. and actually closing on the centreline

The first five are the design doc's; the sixth is not implied by them and matters. An aircraft
tracking parallel to the localiser a mile off, or drifting away from it at twenty degrees, is
inside the beam and inside thirty degrees, and without the closing test would capture. The
signs of the offset and of the angle to the course agree when it is converging and disagree
when it is not, which is the whole test. Inside half-scale deflection it is waived, because an
aircraft vectored onto the localiser heading two hundred yards off the centreline is exactly
parallel to it and refusing that capture would be refusing the normal case.

**The centreline is flown by aiming at a point on it a couple of miles ahead**, not by
correcting in proportion to the offset. That is inherently damped: the intercept angle shrinks
as the aircraft converges, there is no gain to tune, and there is no weaving about the beam. A
test asserts the offset after capture never exceeds the offset it captured at.

**The glidepath is captured when it descends onto the aircraft**, not at the fix. Level at
3,000 ft a three degree path arrives at about 9.2 NM, which is inside the 10 NM fix -- so the
glideslope is armed from a little outside it and the capture happens where the geometry puts it.

Landing is `toRunNM <= 0`: across the threshold, on the published elevation, and `main.ts`
takes it off the scope and says so in the console. The approach clearance carries the whole
geometry, as a hold does, so `sim/` still knows nothing about the airport.

A whole session is tested end to end: the spawner releasing into the stacks, a crude controller
vectoring each arrival to a gate and clearing it for 27R, every instruction going through
`applyCommand`, and the ILS flying them down. Half an hour of it lands more than ten and keeps
the spawner releasing past the concurrency cap -- which it can only do because landings free
the stacks it is waiting on.

### Holding

`sim/hold.ts` flies the racetrack, and **stores nothing**. Which of the four legs an aircraft
is on -- inbound, turning outbound, outbound, turning inbound -- is read back out of where it
is and which way it is pointing, every tick, from the pattern it is carrying:

    inbound          heading within 90 deg of the inbound track, fix still ahead
    turningOutbound  heading within 90 deg of the inbound track, fix behind
    outbound         heading reciprocal-ish, less than one leg run off the fix
    turningInbound   heading reciprocal-ish, a full leg run off the fix

The alternative -- a stored leg plus a stored timer -- is state that has to be initialised on
entry, advanced every tick, and cleared by every command that ends the hold. Miss any one of
those and an aircraft circles a leg it finished ten minutes ago. Derived state cannot fall out
of step with the aeroplane, and it means an aircraft told to hold **from anywhere, on any
heading** joins the pattern without an entry procedure having to be chosen for it.

Three consequences worth stating:

- **The turns are not drawn, they are flown.** Aiming the aeroplane at the next track and
  letting the autopilot's 3 deg/sec do the rest produces the two parallel legs and the two
  half-circles, at the right width, for nothing. At 220 kt the pattern comes out 3.7 NM long
  and 2.3 NM wide, and a circuit takes four minutes -- a minute inbound, a minute round, a
  minute outbound, a minute round. A test flies twenty minutes of it and asserts exactly five
  right-hand circuits, no drift, and the fix crossed every 240 seconds.
- **A forced turn is led, not commanded.** The autopilot always takes the short way to what it
  is given, and a 180 degree reversal has no short way. So the hold hands it a heading a
  quarter-turn ahead and re-aims as the nose comes round, which makes the short way the
  published way and removes the ambiguity.
- **Legs are timed, so their length follows the speed.** `legMins` at the aircraft's current
  groundspeed, which is the real behaviour: slow an aircraft in the hold and its pattern
  shrinks.

The clearance carries the whole pattern -- fix, position, inbound track, turn direction, leg
time -- rather than a fix name the flight model would have to look up. That is what keeps
`sim/` free of any knowledge of the airport: a hold, like a heading, is just something the
aeroplane is carrying. A vector clears it, or the next tick would steer the aircraft straight
back round the pattern.

### Vectoring with the mouse

Press on a target and drag: `render/layers/targets.ts` draws an elastic line from the
aircraft's live position to the cursor with the heading and distance on it, and releasing puts
a `heading` command through `issue()` -- the same gate as a typed line and a menu pick.

The decision that makes it feel deliberate is taken at the moment of the press, not after it:
a press that lands on a target starts a vector, and a press on empty scope pans. Working it out
afterwards from how far the pointer moved would mean dragging the map out from under the
aircraft being aimed at, which is the opposite of useful. Below `DRAG_MIN_PX` a release is
treated as a click instead, because a heading taken from a three-pixel drag is decided by hand
tremor.

The line is redrawn from the aircraft's current position every frame rather than from where it
was when the press landed, because the simulation does not stop for the mouse.

**Headings here are true, not magnetic.** Every heading in the simulation is -- the tag menu's,
the console's, the hold inbound legs -- and `magVarDeg` is zero at Heathrow in the config, so
the two coincide exactly. Converting in this one input path would make a dragged vector
disagree with a typed one the day that value changed. Making the display magnetic is a change
that belongs in every heading at once.

`pickTarget` gained a `prefer` argument for this. Since arrivals stack over their fix, four
aircraft can sit within a mile of each other, which at a normal range is inside the pick radius
-- so a press near a stack could turn a neighbour of the one intended. The selected aircraft
now wins a tie, which makes "pick it out on the strip, then drag it on the scope" reliable.

### The tag menu

Instructions are issued by **right-clicking the aircraft** -- the target on the scope, or its
strip in the bay. `ui/tagmenu.ts` opens at the cursor, one page deep: the categories at the top
level, the values one click in, and the panel closes as soon as it has issued something.

This replaced three fixed quick-buttons per strip. Those could only ever offer three of the
clearances a controller needs, at values somebody had to choose in advance -- a menu that opens
on the aircraft can offer all of them, at the value actually wanted, and it is closer to how
the job is really done.

Two rules hold it together:

- **It only offers what will be accepted.** Levels come from the sector floor and ceiling,
  speeds from the aircraft type's envelope and the terminal area limit -- the same numbers
  `commands/apply.ts` validates against, including the detail that the speed limit bites on the
  *lower* of actual and cleared level. A test walks every value the menu can offer through
  `applyCommand` and asserts none of them is refused, because a menu that teaches limits the
  simulation does not have is worse than no menu.
- **It does not decide what is flyable.** Every kind in the `Command` union appears, including
  the one that is still refused. `applyCommand` is the one authority on that and it answers
  in the console; greying items out here would put the same knowledge in two places, and the
  second copy would go stale the day approaches start working.

Hit testing lives in `render/layers/targets.ts` next to the drawing, and both the symbol and
the **data block** are clickable -- the block is the bigger thing and the part a controller is
already reading. `blockBox()` is shared by the draw and the pick so the hit area cannot drift
away from the text, and the block stops being clickable at the zoom where it stops being drawn,
because an invisible hit box is a trap.

### The in-game guide

A book button beside the menu opens `TUTORIAL.md` in a window. The text is **not restated in
the code**: `main.ts` imports the file as raw text and `ui/guide.ts` renders it, so the
document a person edits and the guide the game shows are the same file. There is no second
copy to drift.

`import guideSource from '../TUTORIAL.md?raw'` is the whole mechanism. With the dev server
running, editing the file hot-reloads the panel; a production build inlines it, which costs
about 20 KB of bundle. The alternative -- fetching it at runtime from `public/` -- was rejected
because it turns a compile-time guarantee into a possible 404 and gains nothing for a game that
should work offline.

`ui/markdown.ts` is a small renderer rather than a dependency, because the project has none at
runtime and this is the only place Markdown is displayed. It implements exactly what the
project's documents use: headings, paragraphs, bullet and numbered lists, block quotes, fenced
code, tables, rules, and inline code, bold, italic and links. Three decisions in it are worth
stating:

- **No HTML pass-through.** Every string reaches the document through `textContent`, never
  `innerHTML`. The point of reading a file at runtime is that the file can be edited, and that
  must not double as a way to inject elements. There is a test for it.
- **Paragraphs join their lines.** The documents are hard-wrapped at 96 columns, so treating
  each source line as its own paragraph would break sentences in half.
- **Link text is kept and the target dropped.** Every link in the guide points at a sibling
  Markdown file, which is not a page inside the app. Something that looked clickable and was
  not would be worse than plain text.

A test renders the real `TUTORIAL.md` and asserts it comes out with headings, tables, a code
block and a quote, and with no leftover `|---` or `#` in the text -- so reorganising the
document into constructs the renderer does not know is caught here rather than noticed on
screen.

### The main menu

`ui/logon.ts` puts a modal window over the shell before the session starts: the field and
sector, a boot summary of what the radar actually loaded, a field for operating initials, the
position being worked, and two buttons.

Three decisions worth stating:

- **Settings are not reimplemented.** The Settings button opens the same `Menu` the scope uses,
  floated above the logon window in the stacking order. So there is one place the display scheme
  and the overlays are configured, and a change made before logging on is the change that
  applies afterwards. Having a second copy of those controls would have been the obvious way to
  build a main menu, and would have been the bug.
- **The clock is held stopped behind it.** The loop starts paused and the logon unpauses it, so
  no traffic accumulates while the display is being set up. The scope draws underneath, dimmed,
  which also means the radar is visibly already running before anyone logs on -- and if the
  airport config had failed to load, the boot summary is where that would show.
- **Nothing is authenticated, and the screen says so.** This is a position logon in the sense a
  controller means it: who is working, and what they are working. Initials are validated as two
  or three letters and remembered; there is no password field and no credential of any kind,
  because there is nothing to check one against and a box that looked like one would be a lie.
  A line under the buttons states this outright.

Once logged on, the operating initials and the position appear as a third line in the scope's
title block -- with the identity of the display, rather than among the readouts that change.

### Overlay density

`render/overlays.ts` defines which layers are optional and three presets over them
(minimal, standard, full), with the menu built from the same list so a key cannot exist in
the render path without being switchable. The split is deliberate: the runways being worked,
the holding fixes, the sector boundary and the readouts are **always drawn**, because they
are the job. Everything else -- controlled airspace, class G traffic zones, airspace labels,
other aerodromes, non-hold navaids, navaid frequencies, range rings, extended centrelines --
is context that helps or clutters depending on what you are doing.

Class G traffic zones are switched separately from controlled airspace, because there are
ten of them and they are small enough to be noise at range. The preference persists in local
storage, read key by key rather than trusting the stored blob, so a stale entry cannot put a
non-boolean into the render path.

### Where the camera may go

Two separate limits, for two separate reasons.

**The zoom ceiling** is how far out the scope will go. It is a constructor argument rather than
a constant, because how far out is useful depends on the size of the sector being worked:
`main.ts` passes twice the area of responsibility, so EGLL's 40 NM sector gives 80 NM -- far
enough to see what is coming, close enough that the sector still fills the scope.
`MAX_RANGE_NM` remains as a fallback only.

**The fence** is how far the view may be panned: the bounding box of everything the map draws,
which `loadAirport` reports as `mapBoundsNM` from the per-path boxes the renderer already culls
on. So it cannot disagree with what is actually drawn, and a config with no `geography` block is
simply not fenced. Past that edge there is nothing but empty ground, and being able to drag out
there reads as a broken display rather than as freedom.

The fence is applied to the **centre, adjusted for the half-extents of the viewport**, so it is
the edge of the picture that stops at the edge of the screen rather than the middle of it. It
therefore has to be re-applied on anything that changes those half-extents -- a resize, a range
change, a zoom about the cursor -- not just on a pan. Where the map is narrower than the
viewport on an axis, that axis is centred on it instead: there is nothing to choose between two
positions that both show everything.

For EGLL the map runs about 230 NM west to 190 NM east and 180 south to 190 north, which is
comfortably more than twice the zoom ceiling on every side. A test asserts that, because a
fence that bit before the scope had finished zooming out would be worse than no fence at all.

### Keyboard shortcuts

One `keydown` handler for the whole application, not one per feature, and it asks two questions
before anything else: is a modifier held, and `isTypingTarget(e.target)`.

That guard is not a detail. The shortcuts are bare letters -- R, D, M, N -- which is
period-correct and was harmless right up until the interface grew a text field: typing operating
initials into the logon window released aircraft on every N and switched the display scheme on
every D. Consolidating into one handler means the guard is asked once, and the next shortcut
cannot be added without it.

`ui/keys.ts` holds the two predicates. They are deliberately not the same question:

- `isTypingTarget` -- a text field, textarea, select or contenteditable. A **checkbox is not**
  one: a letter pressed while one has focus is still a shortcut.
- `ownsSpace` -- additionally true for a checkbox, because the space bar is its only keyboard
  control and the options menu is full of them. Everywhere else space belongs to the clock.

Two shortcuts are also gated on someone having logged on -- pause and the arrival release --
since there is no shift to pause or add traffic to before then.

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

### The arrival spawner

`sim/spawner.ts` reads the holding fixes and their entry bands from the airport config and
releases arrivals onto them.

**An arrival arrives already holding.** It appears `entryDistanceNM` out along its hold's
inbound leg, tracks direct to the fix, and enters the pattern when it gets there -- all of
which `sim/hold.ts` does from the clearance alone, with no entry procedure to choose. So the
controller is handed what an approach controller is actually handed: traffic parked over four
fixes, at assigned levels, waiting to be dealt with. Nothing crosses the sector unless somebody
sends it somewhere.

That changed what "is this fix usable" means, because the airspace over a fix is now occupied
by design. The spawner picks a **slot** -- a fix *and* a level in its stack -- not just a fix:

- **Levels are a thousand feet apart and one aircraft each.** A level is occupied by whoever is
  holding at that fix, read off the clearance they are carrying, and by their *cleared* level
  rather than their current one, so an aircraft descending to 7,000 owns 7,000 from the moment
  it is told to. Vectoring an aircraft out of the hold frees its level in the same instant,
  because the clearance is what goes.
- **A stack is entered from the top**, and fills the lowest gap instead once the band is
  exhausted upwards -- refusing an arrival while a level sits empty would starve the flow to no
  purpose.
- **The gate check is vertical as well as lateral.** An arrival is refused if traffic is within
  `minFixSpacingNM` of where it would appear *and* within a thousand feet of it. Checking
  laterally alone would have the four stacks throttling each other through airspace they are
  separated in, which is the entire point of a stack.
- **It still refuses rather than spawning regardless.** No slot, or the sector at
  `maxConcurrent`, and the arrival is held and retried. Spawning anyway would hand the
  controller a separation loss that existed before they touched anything, which is the worst
  kind of unfair.
- **It runs on the tick clock, not the wall clock.** So it follows the rate control, stops
  dead when paused, and produces the same stream for a given seed however the session was
  played.

A consequence worth stating plainly: a sector nobody works fills to `maxConcurrent` and stops.
That is correct. The releases being held back are held back because there is genuinely nowhere
to put them, and the flow resumes the moment traffic is taken out of a stack -- there is an
end-to-end test that vectors the lowest aircraft out once a minute and asserts exactly that.

The interval ramps from `initialIntervalSeconds` down to `minIntervalSeconds` over
`rampMinutes`, with jitter either side so arrivals are not metronomic. Groundspeed is the
type's cruise, reduced to the sector limit below the limit altitude.

`statusText` distinguishes `TO LAM` from `HOLDING LAM` on a distance threshold clear of the
widest pattern, because an arrival still a dozen miles from its fix is not holding yet, and
whether something needs dealing with yet is the question the strip is there to answer.

Aircraft types and airlines are weighted, so the arrival stream is mostly A320-family with
British Airways prominent, which is what actually fills Heathrow. Those weights, the entry
bands and everything under `traffic` are **gameplay values, not published data** -- flagged
as such in the config provenance, and the first thing to tune if the traffic feels wrong.

`core/rng.ts` is a seeded mulberry32, deliberately not `Math.random`. Traffic generation is
the part of the simulation that invents things, so it is the part that has to be reproducible:
a seed plus a tick count identifies a session exactly, which makes a scenario repeatable, a
bug report actionable and a replay possible.

**Until the physics step exists the flow stalls at four**, one per fix, because nothing ever
leaves the fix it arrived at and the spacing rule correctly refuses to pile more on top. The
`TRAFFIC n HELD n` cell on the status bar exists so that reads as the rule working rather
than as the spawner breaking.

### Interface sound

`audio/sfx.ts` plays one short sample on every control press. Three properties matter more
than the sound:

- **It cannot break the interface.** No Web Audio, a blocked context, a missing sample, one
  that will not decode -- every path ends in silence and a `failed` flag, never an exception
  out of an event handler.
- **It starts inside a gesture.** Browsers create audio contexts suspended until the user has
  interacted, so the context is built at load, the sample decoded up front, and the context
  resumed on the first press. That way the first press is audible rather than swallowed.
- **Presses overlap.** Each play gets its own source node; a shared one would cut the previous
  press short. Presses closer together than 25 ms are dropped, so a held key cannot stack.

One delegated listener on the shell rather than a handler per control, because the strip bay
creates and destroys buttons as traffic comes and goes. `isClickable` decides what sounds:
buttons and checkboxes, never the scope -- a click on every pan would be maddening, and
dragging the map is not pressing a control. Disabled controls stay silent, since nothing
happened.

The context factory and the fetch are constructor arguments, so the tests cover the autoplay
resume, the rate limit and all four failure paths without Web Audio or a network.

The sample is 13 KB. The source recording was 487 KB, of which 2.5 of its 2.8 seconds was
silence after the click; it is trimmed to 150 ms and downmixed to mono, with a short fade so
it cannot end on a discontinuity -- which would itself be an audible click.

### The clock and the loop

`core/loop.ts` runs the simulation in fixed 50 ms steps at 20 Hz and draws on
`requestAnimationFrame`, which is decision 1 made concrete.

**Changing speed changes how many ticks happen per real second, never the size of a tick.**
A step is always 50 ms of simulated time, so 0.5x, 1x, 2x and 4x are the same simulation run
slower or sooner rather than four different ones. Scaling `dt` instead is the obvious
shortcut and it quietly breaks determinism, so there is a test asserting the step size is
identical at every rate.

Simulated time is counted in **ticks**, not wall clock: `elapsedSeconds` is exactly
`ticks x 0.05`. That is what makes a replay possible -- the same tick count with the same
seed gives the same world -- and it is why the status bar clock keeps sim time and stops when
paused.

Three robustness details, each with a test:

- **A frame's real elapsed time is clamped** (250 ms). A backgrounded tab returns with minutes
  of elapsed time; simulating all of it in one frame stalls, and the next frame is further
  behind still. That is the classic spiral, and the clamp is what prevents it.
- **A backlog that cannot be cleared is abandoned** rather than carried forward, and counted
  in `droppedTicks` so it is visible rather than silent.
- **Pausing discards banked time**, or resuming would be followed by a burst of catch-up.

`now` and the scheduler are constructor arguments, so the tests drive time by hand instead of
waiting on it: twenty-four of them cover the rate maths, the clock, pausing and the spiral
guard without a single real timer.

Rendering is skipped when nothing has changed. `requestDraw()` marks the picture dirty and a
tick marks it advanced; a paused, untouched scope draws nothing at all rather than sixty
identical frames a second.

### The arrival sequence, and what a strip is for

`sim/sequence.ts` and `sim/separation.ts` exist because the strip bay had become worthless: it
showed the callsign, the level, the heading and the speed, all four of which are already on the
data block two inches to the left. A strip that repeats the radar is furniture.

So the bay now shows what the radar cannot: **what order the traffic is going to land in, and
whether the gaps are legal.** Strips are ordered nearest the field first and numbered; holding
traffic falls below as the stack, lowest first, because the bottom of a hold is what leaves it
next; and every strip carries its distance to run and the gap to the aircraft in front against
what that pair needs.

Two decisions in there worth defending:

- **The gap is measured in distance to run, not slant range.** Two aircraft on opposite base
  legs are twenty miles apart and heading for the same slot; the range between them says
  everything is fine and the difference in distance-to-run says they will collide in the
  sequence. The second is the number a controller needs, so it is the one shown.
- **The wake minima live in code, not in egll.json.** They are ICAO figures, identical at every
  airport, so a per-airport copy is a per-airport chance to get them wrong. Super-behind-super
  is not in the published table and is flagged in the source as **assumed** rather than quietly
  invented, in the same spirit as the assumed vertical limits in the airspace data.

`stripOrder` is gone with this. Ordering strips by phase of flight was a placeholder for having
a sequence to order them by, and keeping a tested function nothing calls is worse than deleting
it.

### The traffic seed

The seed used to come only from `traffic.seed` in the airport config, which is a fixed number --
so every session dealt the same aircraft, in the same order, off the same fixes. Every session
opened with the same A380 over BNN. The point of a seeded generator is that it *can* be pinned,
not that it always is.

`main.ts` now takes the seed from the clock and prints it in the console at logon, and
`?seed=<number>` pins it. Reproducibility is preserved -- which was the reason for seeding in
the first place -- but it is now opt-in rather than compulsory. `Spawner` takes a `seed` and
reports it back, and a test asserts that two seeds share no aircraft in the same slot and that
one seed twice is identical.

### The flight strip bay and the sync seam

The bay is built ahead of the simulation, which is only possible because the seam between
them is a data contract rather than a call graph:

```
   sim/types.ts          ui/stripbay.ts             commands/types.ts
   Aircraft[]  ------->  update(snapshot, selected)  ------->  Command
   (the world)           (a view, no state)                   (one sink)
```

Three consequences worth stating:

- **The bay holds no aircraft state.** A strip is a view over an `Aircraft` record and the
  sequence is derived from the world on every refresh, so there is nothing to keep in step and
  no chance of the panel and the scope disagreeing.
- **A strip issues nothing itself.** It has no buttons at all. Right-clicking one opens the
  same tag menu as right-clicking the target, so there is one place a clearance comes from
  however you reached it -- and nothing on a strip that can catch a stray click.
- **Refreshing is diffed, not rebuilt.** The bay updates at 5 Hz forever. Rows are keyed by
  callsign, every field is compared before it is written, and rows are moved rather than
  recreated when the running order changes. A test observes the DOM through a
  `MutationObserver` and asserts that an unchanged snapshot produces **zero** mutations --
  otherwise an idle scope would fight text selection and scrolling five times a second. That
  requirement is also why `hidden` is guarded before assignment: setting an attribute to the
  value it already holds still counts as a mutation.

Strips are ordered by what needs attention soonest -- go-around, established, on the
localizer, being vectored, holding, finished -- rather than alphabetically or by arrival time.

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
