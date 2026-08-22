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
| Runways | Four faces, all ILS. **Segregated**: 27R lands, 27L departs -- changeable on the ATIS |
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

Arrivals fly, and they take headings, altitudes and speeds -- typed, or picked off the
right-click menu on the target.

**Aircraft land.** `CLEARED ILS 27R` arms the approach; the localiser is captured when the
geometry actually allows it -- inside the beam, within 30 degrees of the course, at or below
3,000 ft, on the approach side and closing -- and the glidepath is picked up when it descends
onto the aircraft. From there it flies the path to the numbers and comes off the scope, and the
`LANDED n LOST n` cell on the status bar counts them against the ones that got away.

**Only your airspace is lit, and it is the real shape.** The area of responsibility is the
published controlled airspace over the field -- the London CTR from the surface to 2,500 ft and
London TMA 1 from there to FL195, both closed rings out of the sector file -- not a radius.
Everything outside is washed back towards the background, so the part of the map you are working
is obvious at a glance without the rest being hidden.

It is emphatically not circular: the boundary is 39 NM out to the south-east and 11 NM to the
south-west. And it has a floor -- below 2,500 ft the only controlled airspace is the CTR, so a
descent below the base of the TMA out in the country is refused rather than quietly losing you
the aircraft.

**Or turn it off.** An **Airspace** checkbox in the logon window, beside the initials. Unticked,
nothing is dimmed and everything on the display takes a clearance wherever it is. It is a rule
for the shift rather than a display setting, so it is chosen at logon, remembered between
sessions, and recorded in a save.

**You see traffic before it is yours.** Arrivals are released outside the boundary and fly in,
drawn dimmed, listed at the bottom of the strip bay as `INBOUND` with no sequence number. Any
clearance for one is refused -- *"not in your airspace yet"* -- until it crosses in.

**Sessions save and load.** SAVE and LOAD in the menu, under *Session*. A save is the shift as
it stands -- every aircraft and its clearances, the clock, the score, who is on position, and
how far through the current gap the spawner is -- and a load puts it back and pauses so you can
read the picture first. One slot; a save from another airport or another version is refused
rather than loaded.

**There is an ATIS, and you can turn the field round.** An **ATIS** button beside WX shows and
hides a small board on the scope: information letter, runways landing, runways departing, wind.
The board picks the **direction** the field faces and the **operation** it runs in that
direction. Segregated is the default and what the real field does: **27R lands, 27L departs**, so
arrivals and departures are not queueing for the same concrete. You can swap which runway lands,
or go to mixed mode with both landing. Each direction shows its headwind and crosswind so the
choice is informed. Unlike the options menu the board does not dismiss itself when you click on
the radar -- a readout that vanished the moment you touched an aircraft would be one you could
never use while working -- and whether it is up is remembered between sessions. Change the direction and the
scope follows: the localisers move to the runways now being landed on, an approach for a runway
nobody is using is refused, the entry fixes re-pair to the runway on their side of the field, and
the letter steps on to the next one. Anything already cleared for a runway that has gone out of
use has its approach cancelled and holds its heading, which is your problem to re-sequence.

**The weather is alive.** A cell forms every fifteen minutes or so, grows, drifts, reshapes
itself and collapses inside a quarter of an hour. Most of it is a green shower; a **red core is in
front of you when you log on about one session in twenty-seven**, which is what makes one worth
noticing. Cells do not move as a block either -- each has its own track, up to thirty degrees off
the mean wind and a third faster or slower, so a group spreads out as it crosses instead of
sliding across like a panned picture.
Precipitation is drawn in three contours -- green, amber, red -- growing as a cell builds, fading
as it collapses and drifting
downwind meanwhile, with a **WX** button on the scope to show and hide them. Fly into moderate
or heavy and the crew asks for a vector out: the strip reads *WX -- REQUESTING VECTOR*, the data
block flags **WX** in red, and the console says so. Turning the layer off stops it being drawn,
not being there.

**And there is wind.** Applied at a fraction of its reported strength, so groundspeed visibly
differs from the assigned airspeed depending which way an aircraft is pointing, and a long leg
drifts a couple of degrees. The data block reads the groundspeed, as radar does; the strip reads
what you assigned.

**There is a score.** `SCORE` on the status bar: +100 for a landing, -50 for an aircraft lost
off the boundary unlanded. Losing one costs less than landing one earns, so landing most of
your traffic still climbs.

**Nothing leaves silently.** An aircraft comes off the scope for exactly two reasons -- it landed,
or it crossed the sector boundary -- and both are announced in the console. The boundary it
crosses is the circle the scope actually draws, so a target never disappears in open space.

An aircraft lined up badly **flies straight through the localiser** and has to be taken round
again, which is the point: setting the intercept up is the job. A heading breaks one off an
approach at any stage.

Conflict detection and scoring are still to come. See **Status** below.

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

Arrivals are released by `sim/spawner.ts` on a timer that tightens as the session goes on, and
**which stack each one arrives over follows where it has flown from**: transatlantic over
Bovingdon to the north-west, Iberia over Ockham to the south-west, northern Europe over
Lambourne to the north-east, the Middle East and Asia over Biggin to the south-east. Each
airline carries a `preferredFixes` table in the config, so an American 777 arriving over Biggin
-- wrong in a way a controller notices at once -- cannot happen. Each
one appears twelve miles out along its hold's inbound leg, tracks **direct to its VOR, and
enters the hold when it gets there** -- so traffic parks itself over the four fixes, stacked in
1,000 ft layers, and waits for you. Nothing crosses the sector unless you send it somewhere.

The spawner picks a fix *and* a level, so two aircraft holding over the same VOR are never at
the same altitude, and vectoring one out frees its level for the next arrival. A sector nobody
works fills to the concurrency cap and then holds releases back, which is why the
`TRAFFIC n HELD n` readout climbs -- there is genuinely nowhere to put them until you clear a
stack.

### Issuing clearances

**Drag a vector.** Press on a target or its data block and drag: an elastic line follows the
cursor with the heading and distance written beside it, and releasing issues that heading.
Pressing on empty scope pans instead, Escape abandons a drag, and a press that does not really
move is just a click.


The command line under the scope takes one aircraft's whole clearance in a line:

```
BAW178 H270 A30 S180
```

Turn onto 270, descend to 3,000 ft, reduce to 180 kt. Headings are `H`/`HDG`/`HEADING`,
altitudes `A`/`ALT` (or `C`/`CLIMB` and `D`/`DES`, same field), speeds `S`/`SPD`. Altitudes
work in hundreds of feet or in feet -- `A30` and `A3000` both mean 3,000 ft. The callsign can
be shortened to anything unique (`178`, `BAW1`) or left out entirely if a strip is selected,
and the up arrow walks back through what you typed.

A clearance the aircraft or the sector cannot accept is **refused with a reason** rather than
quietly adjusted, and a line with several instructions is all or nothing. The right-click tag
menu produces the same commands and goes through the same gate, so there is one place a
clearance can be refused however it was issued -- and the menu only offers values that gate
will accept, derived from the same sector limits it checks against. [TUTORIAL.md](TUTORIAL.md) has the detail --
and so does the in-game guide, which is that file.

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

**Display scheme.** Four palettes in two families.

**TRACON Dark** is the shipped look: a present-day terminal radar position taken from
photographs of real control rooms -- a dark blue-slate ground, mint-green symbology, and flat
panels with hairline borders instead of bevels. **TRACON Light** is the same position under room
lighting. It is not an inversion: a dark scope glows and a light one is ink on paper, so the
symbology goes dark and the ground goes pale while the hues stay put, mint for the navaids and
traffic and warm for the holds. The two read as one instrument in two lighting conditions.

**Classic Light** and **Classic Dark** are the period schemes, kept exactly as they were for
anyone who preferred them: a Windows-2000-era desktop with a tan tube, and a colour CRT. They keep
their bevelled furniture; only the two TRACON schemes are flat.

The two modern schemes sit together at the front of the cycle, so changing the lighting does not
mean walking through three period tubes to get from one to the other. `D` still cycles them
without opening the menu, because that is a by-eye choice.

**The difference is not only colour -- it is the furniture.** The palette carries which idiom
the interface is drawn in, and that changes the arrangement as well as the edges:

| | Classic schemes | TRACON schemes |
|---|---|---|
| Readouts | a bevelled cell each, label beside value, inset from the corner | a ruled table, heading over value, flush along the bottom |
| Position | a raised panel with a margin round it | a strip hard into the corner |
| Controls | wide labelled buttons in the top right | a rail of small square buttons down the left edge |
| Captions | a saturated bar with light lettering | a ruled heading |
| Strips | raised cards | raised cards, recoloured -- see below |

Both the canvas and the stylesheet read that one field, so a scheme cannot come out half 1999
desktop and half modern position. The readouts themselves are one list either way -- only the
arrangement changes.

**Overlays.** How much context is drawn -- coastline, the Thames, the FIR boundary, airspace,
traffic zones, other aerodromes, other navaids, **hold patterns**, labels, range rings,
centrelines -- with minimal / standard / full presets. The runways being worked, the holding
fixes and the sector boundary are always drawn: they are the job rather than decoration.

**Hold patterns** draws the racetrack at each of the four fixes, sized from the real geometry:
a one-minute leg at 220 kt is 3.7 NM, and a rate-one turn at that speed gives a 1.2 NM radius,
so the pattern comes out about 3.7 by 2.3 NM. That is a thin sliver rather than the fat oval a
chart draws, because a chart is not to scale. The inbound leg is stroked heavier so you can see
which way round it goes. With the layer off -- or zoomed too far out for the racetrack to be
more than a smudge -- each fix keeps a short stub along its inbound leg instead, so the inbound
direction is always readable.

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
| `src/commands/` | The one instruction type, its parser and the gate that validates it |
| `src/audio/` | Interface sounds |

## Status

Day 0 of the roadmap is complete: real EGLL data, the coordinate converter, the canvas
scaler, the surrounding traffic picture and published airspace boundaries, all rendered.

The flight progress strip bay is fed by the running simulation, and every instruction is
issued by right-clicking an aircraft -- on the scope or on its strip. The three fixed
quick-buttons that used to sit on every strip are gone: they could only ever offer three
clearances at values somebody had to guess in advance, and a strip is a view.

**The bay is the arrival sequence**, not a list of the radar labels again. Strips are ordered
nearest the field first and numbered, holding traffic drops underneath as the stack, and each
strip carries the distance still to run and the gap to the aircraft in front against what that
pair of wake categories needs -- flagged when it is short. The gap is measured in distance to
run rather than as the range between the two aircraft, because two aircraft on opposite base
legs can be twenty miles apart and heading for the same slot.

**Traffic differs every session.** The seed comes from the clock, not from the config, and the
console prints it at logon; `?seed=<number>` pins it so a session can be flown again.

## Licensing

Airspace boundaries are derived from the VATSIM UK Sector File, which is **GPL-3.0**. That
has consequences for how this project can be distributed, and no `LICENSE` file has been
chosen yet. See [ATTRIBUTION.md](ATTRIBUTION.md) before publishing or reusing this.
