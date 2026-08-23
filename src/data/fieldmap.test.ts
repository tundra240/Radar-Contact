import { describe, expect, it } from 'vitest'

import { distanceNM, type Vec2NM } from '../core/geo'
import { inPolygon } from '../sim/airspace'
import { AIRPORT_IDS, airportOf } from './airports'
import type { Airport } from './airport'

/**
 * The map every field is drawn on, and the airspace over it.
 *
 * Heathrow had a coastline, forty aerodromes, thirteen navigation aids and
 * sixty-one airspace volumes; Faro had two circles and an empty sea. The
 * gap was not a decision -- Heathrow was built against a UK-only sector
 * file, so the parts that came from UK-only sources stayed UK-only -- but
 * it was the difference between a scope you can orient yourself on and one
 * you cannot. These are the tests that say every field now has a map.
 */
const fields = AIRPORT_IDS.map((icao) => airportOf(icao))

const byIcao = (icao: string): Airport => {
  const f = fields.find((a) => a.icao === icao)
  expect(f, `${icao} is not in the register`).toBeDefined()
  return f!
}

describe('every field is drawn on a map', () => {
  it('gives each one a coastline', () => {
    for (const f of fields) {
      const coast = f.geography.find((g) => g.kind === 'coastline')
      expect(coast, `${f.icao} has no coastline`).toBeDefined()
      expect(coast!.paths.length, `${f.icao} coastline`).toBeGreaterThan(20)
    }
  })

  it('chunks the coastline tightly enough for the cull to mean anything', () => {
    // The renderer rejects a path on its bounding box. One path running the
    // length of a country has a box containing the field, so it would never
    // be rejected however far the scope is zoomed in.
    for (const f of fields) {
      const coast = f.geography.find((g) => g.kind === 'coastline')
      for (const path of coast!.paths) {
        const span = Math.max(path.maxNM.x - path.minNM.x, path.maxNM.y - path.minNM.y)
        expect(span, `${f.icao} has a coast chunk spanning ${span.toFixed(0)} nm`).toBeLessThan(14)
      }
    }
  })

  /**
   * Places the drawn shoreline has to pass close to.
   *
   * The same check Heathrow's coastline carries, which is what proves the
   * line is the real one and is in the right place rather than merely
   * present: a shoreline projected with the wrong sign, or clipped to the
   * wrong box, still draws a plausible squiggle.
   */
  const ASHORE: Record<string, readonly [string, number, number][]> = {
    LPFR: [
      ['Faro, at the Ria Formosa', 37.0, -7.93],
      ['Portimao', 37.118, -8.535],
      ['Cape St Vincent', 37.023, -8.997],
    ],
    LEBL: [
      ['Barcelona harbour', 41.35, 2.17],
      ['Sitges', 41.232, 1.81],
      ['Blanes', 41.673, 2.792],
    ],
    LFMN: [
      ['Nice', 43.695, 7.271],
      ['Cannes', 43.548, 7.017],
      ['Monaco', 43.734, 7.42],
    ],
    EGLL: [
      ['Brighton', 50.82, -0.137],
      ['Southend', 51.535, 0.712],
    ],
  }

  it('puts the shoreline where the shore is', () => {
    for (const f of fields) {
      const coast = f.geography.find((g) => g.kind === 'coastline')!
      for (const [place, lat, lon] of ASHORE[f.icao] ?? []) {
        const at = f.projection.toWorld({ lat, lon })
        let nearest = Infinity
        for (const path of coast.paths) {
          for (const p of path.pointsNM) nearest = Math.min(nearest, distanceNM(p, at))
        }
        expect(nearest, `${f.icao}: ${place} is ${nearest.toFixed(2)} nm from the drawn coast`)
          .toBeLessThan(2)
      }
    }
  })

  it('puts the neighbouring aerodromes on it', () => {
    for (const f of fields) {
      expect(f.airports.length, `${f.icao} has no neighbours`).toBeGreaterThanOrEqual(3)
      for (const a of f.airports) {
        expect(a.icao, `${f.icao} lists itself as a neighbour`).not.toBe(f.icao)
        expect(a.icao, `${f.icao}: ${a.icao} is not an ICAO code`).toMatch(/^[A-Z]{4}$/)
        // Drawn as a runway, so it needs one.
        expect(a.primaryRunway, `${f.icao}: ${a.icao} has no runway`).not.toBeNull()
        expect(a.distanceFromArpNM, `${f.icao}: ${a.icao}`).toBeLessThan(145)
      }
      expect(new Set(f.airports.map((a) => a.icao)).size).toBe(f.airports.length)
    }
  })

  it('gives each one navigation aids beyond its own entry gates', () => {
    for (const f of fields) {
      const stations = f.navaids.filter((n) => n.station !== null)
      expect(stations.length, `${f.icao} has no real stations`).toBeGreaterThanOrEqual(2)
      for (const n of stations) {
        // A station identifier is two to four letters. A five-letter name
        // with a frequency on it is a waypoint pretending to be a beacon,
        // which puts a number on the scope that tunes nothing.
        expect(n.name, `${f.icao}: ${n.name}`).toMatch(/^[A-Z]{2,4}$/)
        expect(n.station!.freqMHz, `${f.icao}: ${n.name}`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps every gate the traffic generator asks for', () => {
    // The map build rewrites the navaid list. The entry gates are gameplay
    // furniture referred to by name, so losing one to a rebuild would
    // silently stop a stream of arrivals.
    for (const f of fields) {
      const holds = new Set(f.holdingFixes.map((n) => n.name))
      for (const airline of f.traffic.airlines) {
        for (const fix of Object.keys(airline.preferredFixes)) {
          expect(holds.has(fix), `${f.icao}: ${airline.code} wants ${fix}, which is gone`).toBe(true)
        }
      }
    }
  })
})

describe('the airspace over it', () => {
  it('is more than a circle and a cylinder', () => {
    for (const f of fields) {
      expect(f.airspace.length, `${f.icao} airspace`).toBeGreaterThanOrEqual(10)
    }
  })

  it('stacks the terminal area rather than stating one base for all of it', () => {
    // The whole point of the sub-areas: a terminal area is not a cylinder,
    // and a display that says 3000 everywhere is telling you nothing about
    // where you can actually descend.
    for (const icao of ['LPFR', 'LEBL', 'LFMN']) {
      const bases = new Set(
        byIcao(icao)
          .airspace.filter((v) => v.airspaceClass === 'C')
          .map((v) => v.floorFt),
      )
      expect(bases.size, `${icao} terminal bases`).toBeGreaterThanOrEqual(3)
    }
  })

  it('brings the base down along the final approach', () => {
    // An approach corridor is the one added area that changes a level
    // rather than only a line: outside the zone, controlled airspace has to
    // reach lower over the final than it does anywhere else, or a twelve
    // mile final is outside it.
    for (const icao of ['LPFR', 'LEBL', 'LFMN']) {
      const f = byIcao(icao)
      const corridors = f.airspace.filter((v) => v.id.includes('approach CTA'))
      expect(corridors.length, `${icao} approach corridors`).toBeGreaterThanOrEqual(2)
      const lowestElse = Math.min(
        ...f.airspace
          .filter((v) => !v.id.includes('approach CTA') && v.floorFt > 0)
          .map((v) => v.floorFt),
      )
      for (const c of corridors) {
        expect(c.floorFt, `${icao}: ${c.id}`).toBeLessThan(lowestElse)
      }
    }
  })

  /**
   * The invariant that keeps the added detail from moving the job.
   *
   * sim/airspace.ts builds the area of responsibility out of whichever
   * controlled volumes enclose the field. So anything added to the airspace
   * that happens to enclose the field silently redraws the boundary a
   * controller is working to and changes where arrivals are released --
   * which is why every added area is an annulus, a corridor or a circle
   * somewhere else, and none of them contains the aerodrome.
   */
  it('leaves the area of responsibility to the control zone and the terminal area', () => {
    const origin: Vec2NM = { x: 0, y: 0 }
    for (const icao of ['LPFR', 'LEBL', 'LFMN']) {
      const f = byIcao(icao)
      const enclosing = f.airspace.filter(
        (v) =>
          v.shape.kind === 'polygon' &&
          inPolygon(v.shape.verticesNM, origin) &&
          v.airspaceClass !== 'G',
      )
      expect(
        enclosing.map((v) => v.id),
        `${icao}: an added area encloses the field`,
      ).toEqual([])
      // And what remains is what always was: the terminal area alone.
      // The control zone is stored as a circle and a circle has no ring, so
      // it has never contributed to this -- worth pinning down, because it
      // is the sort of thing that looks like a bug until you check.
      expect(f.controlZone.map((v) => v.label)).toEqual([`${f.shortName.toUpperCase()} TMA`])
    }
  })

  it('never bases a sub-area above a gate inside it', () => {
    // An arrival is released at its gate at a level the traffic config
    // picks. A sub-area based above that says, on the display, that the
    // aeroplane is beneath controlled airspace the moment it is handed
    // over.
    for (const f of fields) {
      for (const fix of f.holdingFixes) {
        const level = fix.entry?.minAltFt ?? 5000
        for (const v of f.airspace) {
          if (v.shape.kind !== 'polygon') continue
          if (!inPolygon(v.shape.verticesNM, fix.posNM)) continue
          expect(v.floorFt, `${f.icao}: ${v.id} is based above ${fix.name}`).toBeLessThanOrEqual(
            level,
          )
        }
      }
    }
  })

  it('sizes every traffic zone by the same rule', () => {
    for (const f of fields) {
      for (const v of f.airspace.filter((x) => x.airspaceClass === 'G')) {
        expect(v.shape.kind, v.id).toBe('circle')
        if (v.shape.kind !== 'circle') continue
        expect([2, 2.5], `${f.icao}: ${v.id} radius`).toContain(v.shape.radiusNM)
        expect(v.ceilingFt - v.floorFt, `${f.icao}: ${v.id} height`).toBeGreaterThan(1900)
      }
    }
  })

  it('says out loud which volumes are not published', () => {
    // The three constructed fields have no sector file behind them and the
    // display is honest about it. Heathrow's do come from one, so nothing
    // there should be claiming to be approximate that is not.
    for (const icao of ['LPFR', 'LEBL', 'LFMN']) {
      const f = byIcao(icao)
      expect(f.airspace.every((v) => v.approximate)).toBe(true)
      expect(f.provenance['notes']).toContain('CONSTRUCTED')
    }
  })
})
