import { describe, expect, it } from 'vitest'
import { distanceNM, type Vec2NM } from '../core/geo'
import { isControlled } from '../sim/airspace'
import { headwindKts, TAILWIND_LIMIT_KTS } from '../sim/atis'
import { DIFFICULTIES } from '../sim/difficulty'
import { belowMinimumSafe, infringingNoise, inShape } from '../sim/zones'
import type { Aircraft } from '../sim/types'
import type { Runway } from './airport'
import { AIRPORT_IDS, airportOf, airportSummaries, DEFAULT_AIRPORT } from './airports'

/**
 * Every field, loaded through the real loader.
 *
 * The point of the framework is that a new airport is a config file and
 * nothing else, so the test for it is that every config file survives the
 * same parser and produces something workable. A profile that loads but
 * has no way in, or a hold outside its own airspace, would be a map you
 * could open and not control.
 */
const fields = AIRPORT_IDS.map((icao) => airportOf(icao))

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'TEST1',
    type: 'A320',
    wake: 'M',
    role: 'arrival',
    pos: { x: 0, y: 0 },
    altFt: 5000,
    hdg: 90,
    iasKts: 220,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 5000,
    clearedSpdKts: 220,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    route: [],
    routeLeg: 0,
    originFix: null,
    destination: null,
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    squawk: '4271',
    emergencyAt: null,
    ...over,
  }
}

describe('the register of fields', () => {
  it('offers four, gentlest first', () => {
    expect(AIRPORT_IDS).toEqual(['LPFR', 'EGLL', 'LEBL', 'LFMN'])
    expect(AIRPORT_IDS).toContain(DEFAULT_AIRPORT)
  })

  it('runs easy, normal, hard, pro', () => {
    // The progression the whole set exists to provide, and it has to be in
    // that order: the list is offered gentlest first and a tier out of
    // sequence would make the ladder a lie.
    expect(airportSummaries().map((s) => s.tier)).toEqual(['easy', 'normal', 'hard', 'pro'])
  })

  it('never goes backwards down the ladder', () => {
    const rank = { easy: 0, normal: 1, hard: 2, pro: 3 } as const
    const tiers = airportSummaries().map((s) => rank[s.tier as keyof typeof rank])
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i], AIRPORT_IDS[i]).toBeGreaterThan(tiers[i - 1] as number)
    }
  })

  it('falls back rather than throwing on a field it does not have', () => {
    expect(airportOf('ZZZZ').icao).toBe(DEFAULT_AIRPORT)
  })

  it('gives the same object back rather than parsing twice', () => {
    // Parsing one walks every airspace boundary in it.
    expect(airportOf('LFMN')).toBe(airportOf('LFMN'))
  })

  it('describes each one well enough to choose from', () => {
    for (const s of airportSummaries()) {
      expect(s.name.length, s.icao).toBeGreaterThan(3)
      expect(s.brief.length, s.icao).toBeGreaterThan(200)
    }
  })
})

describe('every profile loads into something workable', () => {
  it('has runways, and a landing runway among them', () => {
    for (const f of fields) {
      expect(f.runways.length, f.icao).toBeGreaterThan(0)
      expect(f.arrivalRunways.length, f.icao).toBeGreaterThan(0)
      for (const r of f.arrivalRunways) {
        expect(r.ils.available, `${f.icao} ${r.id}`).toBe(true)
      }
    }
  })

  it('has somewhere for arrivals to come from', () => {
    // A holding fix with an entry band is the only thing the spawner will
    // release traffic onto; a field with none is a field with no traffic.
    for (const f of fields) {
      const gates = f.navaids.filter((n) => n.hold !== null && n.entry !== null)
      expect(gates.length, f.icao).toBeGreaterThan(0)
    }
  })

  it('puts every holding fix inside its own airspace', () => {
    // A hold outside the boundary is an arrival that is never the
    // controller's, waiting somewhere they cannot touch it.
    for (const f of fields) {
      for (const fix of f.navaids.filter((n) => n.hold !== null && n.entry !== null)) {
        const level = fix.entry?.minAltFt ?? 5000
        expect(isControlled(f.controlZone, fix.posNM, level), `${f.icao} ${fix.name}`).toBe(true)
      }
    }
  })

  it('has an airline mix that only routes to fixes it has', () => {
    for (const f of fields) {
      const known = new Set(f.navaids.map((n) => n.name))
      for (const airline of f.traffic.airlines) {
        for (const fix of Object.keys(airline.preferredFixes)) {
          expect(known, `${f.icao} ${airline.code}`).toContain(fix)
        }
      }
    }
  })

  it('shares one fleet rather than each carrying its own', () => {
    const heathrow = airportOf('EGLL').aircraftTypes
    for (const f of fields) {
      expect(f.aircraftTypes.map((t) => t.type), f.icao).toEqual(
        heathrow.map((t) => t.type),
      )
    }
  })

  it('names only corridors whose fixes it has, classified', () => {
    for (const f of fields) {
      const known = new Set(f.navaids.map((n) => n.name))
      for (const c of f.overflights?.corridors ?? []) {
        for (const fix of c.via) expect(known, `${f.icao} ${c.id}`).toContain(fix)
        expect(['clear', 'crossing', 'overhead'], `${f.icao} ${c.id}`).toContain(c.crossing)
      }
    }
  })

  it('opens landing into wind rather than out of it', () => {
    // The ATIS checks this every session and says so when it is wrong, so a
    // profile shipped with the active runway downwind would greet every
    // player with a warning about its own configuration. Two of them did.
    for (const f of fields) {
      for (const r of f.arrivalRunways) {
        const head = headwindKts(r.bearingTrue, f.weather.wind)
        expect(head, `${f.icao} lands ${r.id} with the wind behind it`).toBeGreaterThan(
          -TAILWIND_LIMIT_KTS,
        )
      }
    }
  })

  it('says plainly that the new fields are not surveyed', () => {
    // Heathrow's positions come from the AIP. The other three do not, and a
    // profile that did not say so would be presenting invented coordinates
    // as real ones.
    for (const f of fields) {
      if (f.icao === 'EGLL') continue
      expect(JSON.stringify(f.provenance ?? {}).toUpperCase(), f.icao).toContain('CONSTRUCTED')
    }
  })
})

describe('what makes each field itself', () => {
  it('gives Faro one runway direction and one stream', () => {
    const faro = airportOf('LPFR')
    expect(faro.tier).toBe('easy')
    // One strip, two ends.
    // One strip: both ends are the same length because they are the same
    // piece of tarmac.
    expect(new Set(faro.runways.map((r) => r.lengthNM.toFixed(3))).size).toBe(1)
    expect(faro.arrivalRunways).toHaveLength(1)
    // No terrain and no noise: the gentle field is gentle on purpose.
    expect(faro.terrain).toEqual([])
    expect(faro.noise).toEqual([])
  })

  it('gives Nice mountains that reach above the approach', () => {
    const nice = airportOf('LFMN')
    expect(nice.tier).toBe('pro')
    expect(nice.terrain.length).toBeGreaterThan(0)
    const alps = nice.terrain.find((t) => t.id === 'maritime-alps')
    expect(alps).toBeDefined()
    // Higher than the platform an arrival is descended to, which is the
    // whole reason the vectoring happens over the water.
    expect(alps?.minimumSafeFt).toBeGreaterThan(nice.sector.interceptAltMaxFt)
    // And they are to the north: a point inland is in, a point out to sea
    // is not.
    expect(inShape(alps!.shape, { x: 0, y: 25 })).toBe(true)
    expect(inShape(alps!.shape, { x: 0, y: -25 })).toBe(false)
  })

  it('catches an aircraft flown into the Nice terrain', () => {
    const nice = airportOf('LFMN')
    const low = ac({ pos: { x: 0, y: 25 }, altFt: 5000 })
    const high = ac({ callsign: 'TEST2', pos: { x: 0, y: 25 }, altFt: 13000 })
    const outToSea = ac({ callsign: 'TEST3', pos: { x: 0, y: -25 }, altFt: 3000 })
    const caught = belowMinimumSafe(nice.terrain, [low, high, outToSea])
    expect([...caught]).toEqual(['TEST1'])
  })

  it('gives Barcelona crossing runways and noise floors', () => {
    const bcn = airportOf('LEBL')
    expect(bcn.tier).toBe('hard')
    // Two directions that are not reciprocal: 06/24 and 02/20 cross.
    const bearings = new Set(bcn.runways.map((r) => Math.round(r.bearingTrue / 10) * 10))
    expect(bearings.size).toBeGreaterThan(2)
    expect(bcn.noise.length).toBeGreaterThan(0)
    for (const zone of bcn.noise) expect(zone.penaltyPoints).toBeGreaterThan(0)
  })

  it('charges for low vectoring over Barcelona and not for landing there', () => {
    const bcn = airportOf('LEBL')
    const city = bcn.noise.find((z) => z.id === 'city')
    expect(city).toBeDefined()
    const centre = city!.shape.kind === 'circle' ? city!.shape.centreNM : { x: 0, y: 0 }

    const vectored = ac({ pos: centre, altFt: 2000 })
    const landing = ac({ callsign: 'TEST2', pos: centre, altFt: 2000, navMode: 'GS_TRACKING' })
    const above = ac({ callsign: 'TEST3', pos: centre, altFt: 6000 })
    // An aeroplane on the beam is below every floor near the field by the
    // time it gets there, and charging for that would charge for landing.
    expect([...infringingNoise(bcn.noise, [vectored, landing, above])]).toEqual(['TEST1'])
  })

  it('sends Barcelona transits across the arrivals and Faro transits round them', () => {
    const bcn = airportOf('LEBL')
    const faro = airportOf('LPFR')
    // Only the hardest setting flies an overhead corridor, and Barcelona is
    // the field that has them.
    expect((bcn.overflights?.corridors ?? []).some((c) => c.crossing === 'overhead')).toBe(true)
    expect((faro.overflights?.corridors ?? []).every((c) => c.crossing === 'clear')).toBe(true)
  })

  it('keeps the airport tier and the session difficulty separate', () => {
    // The tier is a property of the place; the difficulty scales the
    // traffic on top of it. Faro on Pro is still one runway.
    expect(airportOf('LPFR').tier).toBe('easy')
    expect(DIFFICULTIES.pro.arrivalsPerHour).toBeGreaterThan(
      DIFFICULTIES.easy.arrivalsPerHour,
    )
  })
})

describe('the runways are laid out as strips', () => {
  /**
   * A runway has two ends and they are one piece of tarmac.
   *
   * The three constructed fields were generated end by end, each threshold
   * on its own radial from the reference point -- so the two ends of a
   * strip were not its length apart, and a parallel pair was not parallel.
   * Nice drew as three runways and Barcelona as a tangle.
   */
  const FT_PER_NM = 6076.11548556

  /** The reciprocal id of a runway end: 27R and 09L, 02 and 20. */
  function reciprocalOf(id: string): string {
    const digits = Number.parseInt(id.replace(/[^0-9]/g, ''), 10)
    const side = id.replace(/[0-9]/g, '')
    const other = ((digits + 17) % 36) + 1
    const flipped = side === 'L' ? 'R' : side === 'R' ? 'L' : side
    return `${String(other).padStart(2, '0')}${flipped}`
  }

  it('pairs every end with its reciprocal', () => {
    for (const f of fields) {
      const ids = new Set(f.runways.map((r) => r.id))
      for (const r of f.runways) {
        expect(ids, `${f.icao} ${r.id} has no other end`).toContain(reciprocalOf(r.id))
      }
      // An even number of ends, because they come in pairs.
      expect(f.runways.length % 2, f.icao).toBe(0)
    }
  })

  it('puts the two ends exactly a runway apart', () => {
    for (const f of fields) {
      for (const r of f.runways) {
        const other = f.runways.find((x) => x.id === reciprocalOf(r.id))
        if (other === undefined) continue
        const apart = distanceNM(r.thresholdNM, other.thresholdNM)
        // Within a hundred feet, which is the rounding in the coordinates.
        expect(
          Math.abs(apart - r.lengthNM) * FT_PER_NM,
          `${f.icao} ${r.id}/${other.id} does not close`,
        ).toBeLessThan(100)
      }
    }
  })

  it('points the two ends opposite ways', () => {
    for (const f of fields) {
      for (const r of f.runways) {
        const other = f.runways.find((x) => x.id === reciprocalOf(r.id))
        if (other === undefined) continue
        // Reciprocal, so the difference is half a turn.
        const apart = (((r.bearingTrue - other.bearingTrue) % 360) + 360) % 360
        expect(apart, `${f.icao} ${r.id}/${other.id}`).toBeCloseTo(180, 0)
      }
    }
  })

  it('makes a parallel pair actually parallel', () => {
    // Nice's two strips and Barcelona's two: same bearing, side by side.
    for (const [icao, a, b] of [
      ['LFMN', '04L', '04R'],
      ['LEBL', '06L', '06R'],
    ] as const) {
      const f = airportOf(icao)
      const one = f.runways.find((r) => r.id === a)
      const two = f.runways.find((r) => r.id === b)
      expect(one, `${icao} ${a}`).toBeDefined()
      expect(two, `${icao} ${b}`).toBeDefined()
      expect(Math.abs(one!.bearingTrue - two!.bearingTrue), icao).toBeLessThan(1)
      // Beside each other rather than on top: a real separation, and not a
      // mile of it either.
      const apart = distanceNM(one!.thresholdNM, two!.thresholdNM)
      expect(apart, icao).toBeGreaterThan(0.05)
      expect(apart, icao).toBeLessThan(1.5)
    }
  })

  /** A runway as a line segment in world space. */
  function asSegment(r: Runway): { a: Vec2NM; b: Vec2NM } {
    const rad = (r.bearingTrue * Math.PI) / 180
    return {
      a: r.thresholdNM,
      b: {
        x: r.thresholdNM.x + Math.sin(rad) * r.lengthNM,
        y: r.thresholdNM.y + Math.cos(rad) * r.lengthNM,
      },
    }
  }

  /** Whether two segments actually intersect, rather than merely converge. */
  function segmentsCross(
    p: { a: Vec2NM; b: Vec2NM },
    q: { a: Vec2NM; b: Vec2NM },
  ): boolean {
    const side = (o: Vec2NM, a: Vec2NM, b: Vec2NM): number =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    return (
      side(p.a, p.b, q.a) * side(p.a, p.b, q.b) < 0 &&
      side(q.a, q.b, p.a) * side(q.a, q.b, p.b) < 0
    )
  }

  it('crosses Barcelona 02/20 over both parallels', () => {
    // The dependency the field is known for, so the geometry has to show
    // it -- and show it by actually intersecting. An angle test alone
    // passed happily while the strip sat a third of a mile off the end of
    // the parallels, touching nothing, which is what it was doing.
    const bcn = airportOf('LEBL')
    const cross = bcn.runways.find((r) => r.id === '02')
    expect(cross).toBeDefined()
    for (const id of ['06L', '06R']) {
      const parallel = bcn.runways.find((r) => r.id === id)
      expect(parallel, id).toBeDefined()
      expect(
        segmentsCross(asSegment(cross!), asSegment(parallel!)),
        `02/20 does not cross ${id}`,
      ).toBe(true)
    }
  })

  it('keeps Barcelona parallels parallel, so they never cross', () => {
    const bcn = airportOf('LEBL')
    const north = bcn.runways.find((r) => r.id === '06L')
    const south = bcn.runways.find((r) => r.id === '06R')
    expect(segmentsCross(asSegment(north!), asSegment(south!))).toBe(false)
  })

  it('spreads a parallel pair far enough to read as two runways', () => {
    // Nice's real pair are about three hundred metres apart, which at scope
    // range draws as one thick line. They are opened out, on purpose, and
    // the provenance says so.
    for (const [icao, a, b] of [
      ['LFMN', '04L', '04R'],
      ['LEBL', '06L', '06R'],
    ] as const) {
      const f = airportOf(icao)
      const one = f.runways.find((r) => r.id === a)
      const two = f.runways.find((r) => r.id === b)
      // Perpendicular separation, which is what you actually see: the
      // along-track offset between two thresholds is not the gap.
      const rad = (one!.bearingTrue * Math.PI) / 180
      const across = {
        x: Math.sin(rad + Math.PI / 2),
        y: Math.cos(rad + Math.PI / 2),
      }
      const delta = {
        x: two!.thresholdNM.x - one!.thresholdNM.x,
        y: two!.thresholdNM.y - one!.thresholdNM.y,
      }
      const gap = Math.abs(delta.x * across.x + delta.y * across.y)
      expect(gap, `${icao} parallels are ${gap.toFixed(2)} nm apart`).toBeGreaterThan(0.3)
    }
  })
})

describe('waypoints are waypoints', () => {
  it('only puts a frequency on an actual radio aid', () => {
    // A five-letter fix is a name and a position. Giving one a VOR
    // frequency says it is something it is not, and puts a number on the
    // scope that tunes nothing.
    for (const f of fields) {
      for (const n of f.navaids) {
        if (n.station === null) continue
        // A station has a short identifier, the way a real one does.
        expect(n.name.length, `${f.icao} ${n.name} has a frequency`).toBeLessThanOrEqual(3)
      }
    }
  })

  it('still gives each field one aid to tune', () => {
    for (const f of fields) {
      const stations = f.navaids.filter((n) => n.station !== null)
      expect(stations.length, f.icao).toBeGreaterThan(0)
    }
  })
})
