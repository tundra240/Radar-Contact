# Radar-Contact

Top down, 2000's style ATC terminal game called 'Radar Contact' about managing
arrivals/departures coming out of Heathrow Airport (LHR/EGLL)

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

On the scope: drag to pan, wheel to zoom, `R` to reset the view, `D` to switch between the
display schemes, `O` to open the overlay panel, and space to pause. The buttons in the top
right do the same.

Controls click. `SND` mutes them, and the choice persists.

The simulation runs in fixed 50 ms steps at 20 Hz and the rate buttons run it at 0.5x, 1x, 2x
or 4x. Changing the rate changes how many steps happen per real second, never the size of a
step, so fast-forward is the same simulation sooner rather than a different one. The status
bar clock keeps simulated time and stops when paused.

Three display schemes cycle in order: **beige** (a Windows-2000-era desktop with a tan tube),
**dark** (a colour CRT), and **amber** (a monochrome phosphor tube). The choice persists.

The overlay panel controls how much context is drawn -- airspace, traffic zones, other
aerodromes, other navaids, labels, range rings, centrelines -- with minimal / standard / full
presets. The runways being worked, the holding fixes and the sector boundary are always
drawn: they are the job rather than decoration.

## Where things are

| Path | What it is |
|---|---|
| `EGLL_Approach_Radar_Design.md` | The game design specification |
| `ARCHITECTURE.md` | Build plan, coordinate system, module layout, roadmap |
| `ATTRIBUTION.md` | Third-party data sources and **licensing implications** |
| `src/core/` | Geodesy, world/screen camera, game loop |
| `src/data/` | Airport configuration and its validating loader |
| `src/render/` | Palettes and the scope renderer |
| `src/sim/` | The aircraft model, and a placeholder roster until Day 1 |
| `src/ui/` | The flight progress strip bay |
| `src/commands/` | The one instruction type every input path produces |

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
