# Third-party data attribution

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

## OurAirports -- positions and runways

- **Source:** https://ourairports.com/data/ (https://davidmegginson.github.io/ourairports-data/)
- **Terms:** public domain / CC0
- **Retrieved:** 2026-08-21

Airport reference points, runway thresholds, elevations, displaced thresholds, navaid
positions and frequencies in `src/data/egll.json` come from `airports.csv`, `runways.csv` and
`navaids.csv`.

## Derived rather than sourced

Aerodrome traffic zones for fields the sector file does not cover are computed from the UK
rule -- 2 NM radius where the longest runway is 1850 m or less, 2.5 NM otherwise, extending
to 2000 ft above aerodrome level. These carry `derivation: "rule"` and are drawn dotted so
the display never presents them as published. Where the source does publish a zone it wins:
Biggin Hill is notified as 2.5 NM although the rule would give 2 NM.
