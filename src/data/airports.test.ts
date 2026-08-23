import { describe, expect, it } from 'vitest'
import { isControlled } from '../sim/airspace'
import { headwindKts, TAILWIND_LIMIT_KTS } from '../sim/atis'
import { DIFFICULTIES } from '../sim/difficulty'
import { belowMinimumSafe, infringingNoise, inShape } from '../sim/zones'
import type { Aircraft } from '../sim/types'
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
