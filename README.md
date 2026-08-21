# Radar-Contact

Top down, 2000's style ATC terminal game called 'Radar Contact' about managing
arrivals/departures coming out of Heathrow Airport (LHR/EGLL)

## How the game works

You are the **approach controller** for London Heathrow. Arrivals are handed to you already
in the sector, stacked over four holding fixes, and your job is to turn those four separate
streams into one landing sequence per runway -- spaced as tightly as the rules allow, with
nobody losing separation on the way. Aircraft do exactly what you tell them and nothing more,
so an aircraft you forget about carries on until it leaves the sector or hits something.

### The sector

Every figure here is read from `src/data/egll.json` rather than written into the code, so the
display, the rules and the docs cannot disagree with each other.

| | |
|---|---|
| Area of responsibility | 40 NM radius of the airport reference point |
| Vertical limits | 1,500 ft to FL150 |
| Range rings | 5, 10, 15 and 20 NM |
| Arrival runways | 27R and 27L, both ILS, both landing (mixed mode) |
| Intercept altitude | 3,000 ft or below |
| Final approach fix | 10 NM from the threshold, 3 degree glideslope |
| Speed limit | 250 kt below 10,000 ft |

### The four stacks

Arrivals appear over one of four VOR holds, and which one is decided by where the flight came
from -- each fix serves a whole quadrant of the world:

| Fix | Where it is | What it feeds |
|---|---|---|
| **BNN** Bovingdon | 15.7 NM on 348 | North Atlantic, Ireland, Scotland, north-west UK |
| **LAM** Lambourne | 25.1 NM on 065 | Scandinavia, the Baltic, northern Europe |
| **BIG** Biggin | 20.3 NM on 114 | France, Germany, Italy, the Middle East, Asia |
| **OCK** Ockham | 10.0 NM on 177 | Iberia, Africa, South America, the south-west |

The four are not tidy diagonal corners: BNN and LAM are both north, BIG and OCK both south,
and OCK is two and a half times closer in than LAM. That asymmetry is most of the difficulty.
**[TUTORIAL.md](TUTORIAL.md) covers sequencing in full** -- stack discipline, base legs,
spacing and the errors that cost the most.

### The map

The scope is not an empty grid. Under the airspace it draws real geography, so zooming out
gives you somewhere to be rather than a blank ground:

| Layer | What it is |
|---|---|
| Coastline | Natural Earth 10m, out to roughly 180 NM -- the south coast, the Thames estuary, East Anglia, and the French, Belgian and Dutch shore |
| River Thames | Drawn at its **real width**, a thread at Windsor and visibly a mile across off Canvey |
| London FIR boundary | The lateral limit of UK airspace, down the Channel and up the North Sea |
| Aerodromes | 40 fields, from Northolt at 6 NM out to Birmingham, Bristol and East Midlands, each on its real runway bearing |

Accuracy is measured rather than asserted: the drawn coastline is within 0.25 NM of Dover,
Brighton, Southend and Harwich, and the Thames passes within a mile of Windsor, Richmond,
Westminster, Tower Bridge, Woolwich and Gravesend. See [ATTRIBUTION.md](ATTRIBUTION.md) for
sources and for the one piece of approximated geometry -- the river's width profile.

**The zoom limit is unchanged.** The scope still stops at 80 NM, twice the area of
responsibility. The map extends what is drawn, not how far out you can go.

**Panning stops at the edge of the map.** The coastline data runs out at roughly 230 NM west
and 190 NM east of the field, and the camera is fenced to that, so a drag cannot take you out
into blank ground. The fence adjusts for the size of the window, so it is the edge of the
*picture* that stops at the edge of the screen rather than the middle of it.

### An arrival, end to end

```
  spawn over a hold  ->  descend and leave the stack  ->  downwind and base leg
                                                                    |
                       land  <-  glideslope  <-  localizer  <-  closing heading
```

1. The flight arrives over its stack and holds, in 1,000 ft layers.
2. You take it off the **bottom** of the stack, descending, on a heading toward its base leg.
3. The **base leg** is where spacing is made: its length sets the gap behind the aircraft in
   front.
4. You turn it onto a **closing heading** of 30 deg or less, level at or below 3,000 ft, and
   clear it for the approach.
5. It captures the localizer, then the glideslope from below at about 9.2 NM, and lands.

### The rules that bite

- **3.0 NM** lateral separation, or **1,000 ft** vertical where you have less than 3 NM.
- Localizer capture needs **all** of: 30 deg or less of intercept angle, at or below
  3,000 ft, on the approach side of the threshold, and closing. Miss any one and the aircraft
  flies through the centreline instead of capturing it.
- Wake categories (light, medium, heavy, super) are carried per aircraft type. The MVP uses a
  flat 3 NM; the real 4 / 5 / 6 NM minima behind heavier aircraft are post-MVP.

### What is playable today

The radar picture is on screen and interactive -- real airspace, the map, the four holds, the
runways and their centrelines -- along with the logon screen, the strip bay, the simulation
clock and its rate control. Arrivals are generated onto the holds with real callsigns and
types, and appear on their strips.

**Nothing moves yet.** There is no physics step, so an arrival stays where it was released and
the flow stalls once every fix is occupied. Aircraft motion, clearances and ILS capture are
Day 1 and Day 2 of the roadmap in [ARCHITECTURE.md](ARCHITECTURE.md). So the sections above
describe the game being built rather than one you can play through -- but every figure in them
is live in the config, and the geometry they depend on is already drawn correctly. See
**Status** below for the detail.

## Logging on

The session starts at a main menu: a system logon window over the scope, showing what the
radar has loaded and asking for your operating initials -- two or three letters. The
simulation clock is held stopped behind it, so no traffic builds up while you set the display
up, and **Settings** on that window opens the same options menu the scope uses, so anything
you change before logging on is what applies afterwards.

There is no account and no password. Initials identify the position, in the sense a controller
means it -- once you are on, they appear in the scope's title block with the position, as
`EGLL_APP  NF`.

## Running it

```
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Type-check and build to `dist/` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watching |
| `npm run typecheck` | Type-check only |

On the scope: drag to pan, wheel to zoom, `R` to reset the view, space to pause, `D` to cycle
the display schemes, and `M` to open the menu (`O` does too).

Arrivals are released onto the four holds by `sim/spawner.ts`, on a timer that tightens as
the session goes on. They do not move yet -- there is no physics step -- so the flow stalls at
four, one per hold, and the `TRAFFIC n HELD n` readout shows the spacing rule refusing to
stack more on top.

### The guide

The book button in the top right opens the how-to-play guide in a window. **It is not a copy
of anything** -- it reads [TUTORIAL.md](TUTORIAL.md) and renders it, so that one file is both
the document you would edit and the guide the game shows.

To change what players read, edit `TUTORIAL.md`. With `npm run dev` running the panel updates
as soon as you save; a production build takes whatever the file said at build time. There is
nothing else to keep in step.

It is reachable before you log on as well, which is where someone opening the game for the
first time will look for it.

### The menu

One button in the top right of the scope opens everything that is a setting rather than an
instruction, in three sections. Every preference in it persists.

**Simulation.** Pause, and the four rates. The simulation runs in fixed 50 ms steps at 20 Hz,
and the rate changes how many steps happen per real second, never the size of a step -- so
fast-forward is the same simulation sooner rather than a different one. The status bar keeps
the clock and the current rate on the scope itself, so you can see whether time is running
without opening anything. Interface sound is switched here too; controls click when it is on.

**Display scheme.** Three period palettes, picked by name: **beige** (a Windows-2000-era
desktop with a tan tube), **dark** (a colour CRT), and **amber** (a monochrome phosphor tube).
`D` still cycles them without opening the menu, because that is a by-eye choice.

**Overlays.** How much context is drawn -- coastline, the Thames, the FIR boundary, airspace,
traffic zones, other aerodromes, other navaids, labels, range rings, centrelines -- with
minimal / standard / full presets. The runways being worked, the holding fixes and the sector
boundary are always drawn: they are the job rather than decoration.

## Where things are

| Path | What it is |
|---|---|
| `TUTORIAL.md` | How to sequence arrivals: the stacks, base legs, spacing |
| `EGLL_Approach_Radar_Design.md` | The game design specification |
| `ARCHITECTURE.md` | Build plan, coordinate system, module layout, roadmap |
| `ATTRIBUTION.md` | Third-party data sources and **licensing implications** |
| `src/core/` | Geodesy, world/screen camera, game loop |
| `src/data/` | Airport configuration and its validating loader |
| `src/render/` | Palettes and the scope renderer |
| `src/sim/` | The aircraft model, and a placeholder roster until Day 1 |
| `src/ui/` | The strip bay, the options menu, the logon screen and the guide |
| `tools/` | Scripts that regenerate the map and aerodrome data from their sources |
| `src/commands/` | The one instruction type every input path produces |
| `src/audio/` | Interface sounds |

## Status

Day 0 of the roadmap is complete: real EGLL data, the coordinate converter, the canvas
scaler, the surrounding traffic picture and published airspace boundaries, all rendered.

The flight progress strip bay is built and wired to its sync seam, but **there is no aircraft
simulation yet** -- that is Day 1. The bay is currently fed a frozen placeholder roster and
says so with a DEMO badge; its quick-action buttons produce real `Command` objects and log a
readback, because Day 2 points that sink at `commands/apply.ts`.

## Licensing

Airspace boundaries are derived from the VATSIM UK Sector File, which is **GPL-3.0**. That
has consequences for how this project can be distributed, and no `LICENSE` file has been
chosen yet. See [ATTRIBUTION.md](ATTRIBUTION.md) before publishing or reusing this.
