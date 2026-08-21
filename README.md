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
beige and dark displays. The button in the top right does the same.

## Where things are

| Path | What it is |
|---|---|
| `EGLL_Approach_Radar_Design.md` | The game design specification |
| `ARCHITECTURE.md` | Build plan, coordinate system, module layout, roadmap |
| `ATTRIBUTION.md` | Third-party data sources and **licensing implications** |
| `src/core/` | Geodesy, world/screen camera, game loop |
| `src/data/` | Airport configuration and its validating loader |
| `src/render/` | Palettes and the scope renderer |

## Status

Day 0 of the roadmap is complete: real EGLL data, the coordinate converter, the canvas
scaler, the surrounding traffic picture and published airspace boundaries, all rendered.
There is no aircraft simulation yet -- that is Day 1.

## Licensing

Airspace boundaries are derived from the VATSIM UK Sector File, which is **GPL-3.0**. That
has consequences for how this project can be distributed, and no `LICENSE` file has been
chosen yet. See [ATTRIBUTION.md](ATTRIBUTION.md) before publishing or reusing this.
