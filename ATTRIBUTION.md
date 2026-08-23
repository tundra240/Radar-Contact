# Third-party data attribution

Everything in `src/data/egll.json` that came from somewhere else is listed here. The two
scripts in `tools/` regenerate the derived blocks from the original downloads, so the
provenance is reproducible rather than a claim: running them against the same inputs
reproduces the committed data exactly.

## VATSIM UK Sector File -- airspace boundaries

- **Source:** https://github.com/VATSIM-UK/UK-Sector-File
- **Licence:** GNU General Public License v3.0
- **Retrieved:** 2026-08-21

Airspace boundary coordinates in `src/data/egll.json` are derived from this project.
Specifically:

| Taken from | Used for |
|---|---|
| `ARTCC/High/London TMA.txt` | London TMA, 20 class A volumes, 2500 ft to FL195 |
| `Airports/EGLL/Airspace.txt` | London (Heathrow) CTR |
| `Airports/EGLC/Airspace.txt` | London City CTA |
| `Airports/EGKK/Airspace.txt` | Gatwick CTR and CTA |
| `Airports/EGGW/Airspace.txt` | Luton CTR and CTAs |
| `Airports/EGSS/Airspace.txt` | Stansted CTAs |
| `Airports/EGLF/Airspace.txt` | Farnborough CTR and CTAs |
| `Airports/EGKB`, `EGTB`, `EGVO` | Biggin Hill, Wycombe and Odiham ATZ / MATZ circles |

The coordinates were converted from the sector file's degrees-minutes-seconds notation to
decimal degrees, chained into polylines, and annotated with the class and vertical limits
given in each region's header comment. Nothing else was copied: no code, no ground layouts,
no SIDs, STARs, sector ownership or position data.

### What this means for licensing

GPL-3.0 is a copyleft licence. Because this repository now distributes material derived from
a GPL-3.0 work, the combined work is subject to GPL-3.0 when distributed. In practice there
are three consistent options:

1. **Licence this project under GPL-3.0.** Simplest, and the assumption until decided
   otherwise. Add the GPL-3.0 text as `LICENSE` and keep this attribution.
2. **Keep the data but separate it.** Distribute the airspace data as its own GPL-3.0
   component and keep the game under another licence. This is a real distinction only if the
   two are genuinely separable works, which is a judgement call, not a technical switch.
3. **Replace the data.** Transcribe boundaries from the UK AIP directly, or use openAIP under
   its own terms. The loader accepts `lines`, `polygon` and `circle` shapes, so swapping the
   source needs no code change -- only a different `airspace` block.

No `LICENSE` file has been added, because choosing the project's licence is the maintainer's
call rather than something to assume. Until one is chosen, treat the repository as
GPL-3.0-encumbered.

## VATSIM UK Sector File -- London FIR boundary and the Thames

Same source and same licence as the airspace above, so the same consequences.

| Taken from | Used for |
|---|---|
| `ARTCC/High/EGTT London FIR.txt` | The London FIR boundary -- the lateral limit of UK airspace |
| `Misc Geo/Rivers.txt` | The River Thames |

Two notes on how each was handled, because neither was a straight copy.

**The FIR boundary chains.** Its 39 published segments join end to end into a single closed
ring, unlike the TMA line work in the same repository where only 2 of 60 regions closed. So it
is stored as continuous polylines rather than as disconnected strokes. Only the part inside the
clipping box is kept; the Scottish FIR boundary is about 215 NM north of Heathrow and is
therefore absent entirely.

**The rivers file has no names in it.** Every line ends in the colour word `river` and nothing
identifies the watercourse, so the Thames could not be selected by name. `tools/build-geography.mjs`
chains the 4438 segments on shared endpoints into 35 polylines and then identifies the Thames
geometrically: exactly one chain passes within a mile of Windsor, Richmond, Westminster, Tower
Bridge, Woolwich and Gravesend. The script fails loudly if that stops being true of a future
version of the file, rather than silently drawing the wrong river.

The river's **widths are not from the source** -- see "Derived rather than sourced" below.

## Natural Earth -- coastline

- **Source:** https://www.naturalearthdata.com/ (`ne_10m_coastline.geojson` via
  https://github.com/nvkelso/natural-earth-vector)
- **Terms:** public domain
- **Retrieved:** 2026-08-21

Chosen over the coastline in the VATSIM UK sector file deliberately. That file has one
(`Misc Geo/Coastline High Detail.txt`) and it would have been convenient, but it is GPL-3.0 and
this repository is already encumbered by that licence. Taking the coastline from a public-domain
dataset instead means one less GPL-derived block to disentangle if option 2 or 3 above is
ever chosen.

Processing: clipped to a box roughly 180 NM around the field, simplified with Douglas-Peucker
to a 0.1 NM tolerance, and split into chunks spanning at most 12 NM so the renderer can reject
an off-screen chunk on its bounding box. The code is in `tools/lib/lines.mjs`, which
`tools/build-geography.mjs` and `tools/build-field-map.mjs` both run through -- there is no
version of "the coastline is prepared differently at Nice" that is not a bug.

All four fields are drawn on it: 209 chunks at Heathrow, 85 at Faro, 94 at Nice, 109 at
Barcelona. The projection is flat and centred on the aerodrome, so each field's copy is its own
numbers rather than a shared one.

Accuracy was measured rather than assumed, per field. Distance from the drawn line to known
coastal points:

- **Heathrow** -- Brighton 0.02 NM, Southend 0.04 NM, North Foreland 0.05 NM, Bournemouth
  0.04 NM, Dover 0.20 NM, Harwich 0.24 NM, Beachy Head 0.61 NM, Ostend 0.78 NM, Calais 1.09 NM.
- **Faro** -- Cape St Vincent 0.10 NM, Portimao 0.12 NM, Vila Real de Santo Antonio 0.14 NM,
  Faro waterfront 0.15 NM, Huelva 1.05 NM.
- **Nice** -- Toulon 0.27 NM, Nice 0.42 NM, Cannes 0.59 NM, Sanremo 0.60 NM, Monaco 1.18 NM,
  Saint-Tropez 1.26 NM.
- **Barcelona** -- Blanes 0.24 NM, Cap de Creus 0.26 NM, Sitges 0.54 NM, Barcelona harbour
  1.07 NM, Tarragona 1.62 NM.

The larger residuals are town-centre coordinates sitting inland of the shore, not line error.
`src/data/fieldmap.test.ts` asserts a subset of these, which is what catches a shoreline
projected with the wrong sign or clipped to the wrong box -- either still draws a plausible
squiggle.

## Natural Earth -- rivers

- **Source:** https://www.naturalearthdata.com/
  (`ne_10m_rivers_lake_centerlines.geojson`, same repository as above)
- **Terms:** public domain
- **Retrieved:** 2026-08-24

One river, the Guadiana at Faro: the Portuguese border, 28 NM east of the field, and the fix
Faro's eastern gate is named after. It carries no width, and the renderer strokes a widthless
river as a plain line.

The Llobregat at Barcelona and the Var at Nice both run past the end of their runway and would
be worth having. Neither is in this dataset -- at ten-million scale they are below its
resolution -- so their absence is the data's rather than an omission.

## OurAirports -- positions and runways

- **Source:** https://ourairports.com/data/ (https://davidmegginson.github.io/ourairports-data/)
- **Terms:** public domain / CC0
- **Retrieved:** 2026-08-21

Airport reference points, runway thresholds, elevations, displaced thresholds, navaid
positions and frequencies in `src/data/egll.json` come from `airports.csv`, `runways.csv` and
`navaids.csv`.

The neighbouring aerodromes and the navigation aids at Faro, Barcelona and Nice come from the
same three files, through `tools/build-field-map.mjs`: every large airport within 140 NM,
every medium one within 90 NM and every small one within 30 NM with a runway of at least
2000 ft, plus every VOR, VOR-DME and VORTAC within 55 NM to a limit of twelve. Bare ILS DMEs
and low-powered NDB locators are excluded -- Nice alone has three inside seven miles, on top of
the two VOR-DMEs anybody is actually navigating by.

The five-letter entry gates at those three fields are NOT from this dataset. They are invented
gameplay furniture and always have been; the build keeps them and puts the real stations around
them.

The surrounding aerodrome list was extended from the original fifteen within 40 NM out to
forty, by `tools/build-airports.mjs`: every large airport within 100 NM and every medium one
within 90 NM that the dataset records a runway for. Small aerodromes were deliberately not
touched -- the close-in strips were curated by hand, and at that size the dataset holds
hundreds of farm strips.

Each runway bearing is **computed from the two published threshold coordinates**, not taken
from the dataset's heading column, which is frequently blank and is magnetic in some records.
Spot checks against reality: Southend 05/23 comes out 054, Southampton 02/20 at 019,
Bournemouth 08/26 at 075, Birmingham 15/33 at 146.

## Derived rather than sourced

**The airspace at Faro, Barcelona and Nice is constructed and is not from any AIP or sector
file.** There is no open equivalent of the VATSIM UK sector file for Portugal, Spain or France,
and this is the one part of those three fields that could not be taken from data. What is
there, built by `tools/build-airspace.mjs`: a control zone and a terminal area outline (both
rule-derived, both unchanged from the original pair), approach corridors along the extended
centrelines, and terminal sub-areas whose bases step up away from the arrival direction and
over the terrain in the same file. Every constructed volume carries `derivation: "approx"`,
which the loader turns into `approximate: true`.

Two constraints on it are worth writing down. None of the added areas encloses its aerodrome,
because `sim/airspace.ts` builds the area of responsibility out of whichever controlled volumes
do -- so an added area that enclosed the field would silently move the boundary a controller is
working to. And no sub-area is based above a holding fix inside it, because an arrival released
at that gate would appear beneath controlled airspace at the moment it was handed over. Both
are asserted in `src/data/fieldmap.test.ts`.

Aerodrome traffic zones for fields the sector file does not cover are computed from the UK
rule -- 2 NM radius where the longest runway is 1850 m or less, 2.5 NM otherwise, extending
to 2000 ft above aerodrome level. These carry `derivation: "rule"` and are drawn dotted so
the display never presents them as published. Where the source does publish a zone it wins:
Biggin Hill is notified as 2.5 NM although the rule would give 2 NM.

**The width of the Thames is an approximation and is the one piece of invented geometry in the
file.** The source is a centreline and carries no width at all. `tools/build-geography.mjs`
interpolates a width along the line from a table of fifteen real widths at known places -- 25 m
at Oxford, 65 m at Windsor, 250 m at Westminster, 450 m at Woolwich, 1300 m at Gravesend, 5 km
off Canvey. The shape of the profile is right and the numbers are the right order of magnitude,
but no individual value should be treated as surveyed. It exists because a river drawn at one
width everywhere loses the most recognisable thing about the Thames, and because the estuary
really is a mile across where the upper river is a stream.
