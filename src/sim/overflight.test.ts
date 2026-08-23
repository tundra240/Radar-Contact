import { describe, expect, it } from 'vitest'
import type { Clock } from '../core/loop'
import { distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { departureOf, enterSector, isInSector, stepAircraft } from './aircraft'
import { FlightGenerator } from './flightgen'
import { corridorEntry, corridorRoute, Overflights, semicircularLevelFt } from './overflight'
import { buildSequence } from './sequence'
import type { Aircraft } from './types'

const airport = loadAirport(raw)
const config = airport.overflights

const clockAt = (elapsedSeconds: number): Clock => ({
  ticks: Math.round(elapsedSeconds * 20),
  elapsedSeconds,
  timeOfDaySeconds: 43200 + elapsedSeconds,
})

function generator(seed = 4242): Overflights {
  return new Overflights({ airport, flights: new FlightGenerator(airport), seed })
}

/** Run the generator for `minutes`, collecting everything it releases. */
function releases(gen: Overflights, minutes: number): Aircraft[] {
  const out: Aircraft[] = []
  const dt = 1
  for (let t = 0; t < minutes * 60; t += dt) {
    out.push(...gen.update(dt, clockAt(t), out))
  }
  return out
}

describe('the corridors in the config', () => {
  it('are loaded', () => {
    expect(config).not.toBeNull()
    expect(config?.corridors.length).toBeGreaterThan(0)
  })

  it('name only navaids this airport publishes', () => {
    // The loader enforces it, so this is really a check that the data file
    // has not drifted -- a corridor naming a fix that is not there would be
    // one that silently never generates.
    const known = new Set(airport.navaids.map((n) => n.name))
    for (const c of config?.corridors ?? []) {
      for (const fix of c.via) expect(known, c.id).toContain(fix)
    }
  })

  it('cross the sector rather than clipping a corner of it', () => {
    // A corridor that never enters the airspace is scenery. Each one has to
    // put at least one fix inside the boundary, or there is nothing for the
    // controller to ever have to deal with.
    for (const c of config?.corridors ?? []) {
      const inside = c.via.filter((fix) => {
        const navaid = airport.navaids.find((n) => n.name === fix)
        return navaid !== undefined && navaid.distanceFromArpNM < airport.sector.radiusNM
      })
      expect(inside.length, c.id).toBeGreaterThan(0)
    }
  })
})

describe('building a corridor into a route', () => {
  it('ends past the boundary so a transit flies out rather than stopping', () => {
    for (const c of config?.corridors ?? []) {
      const route = corridorRoute(airport, c)
      expect(route.length, c.id).toBe(c.via.length + 1)
      const last = route[route.length - 1]
      expect(last?.fix, c.id).toBe(c.destination)
      // Outside the airspace, which is what makes the world let go of it.
      expect(isInSector(atFt(last?.posNM ?? { x: 0, y: 0 }, 12000), airport.controlZone)).toBe(
        false,
      )
    }
  })

  it('starts outside the airspace and already on track', () => {
    for (const c of config?.corridors ?? []) {
      const route = corridorRoute(airport, c)
      const entry = corridorEntry(airport, route, config?.entryDistanceNM ?? 6)
      expect(isInSector(atFt(entry.pos, 12000), airport.controlZone), c.id).toBe(false)
      // Far enough out to be seen and planned against before it matters.
      const first = route[0]
      expect(distanceNM(entry.pos, first?.posNM ?? { x: 0, y: 0 }), c.id).toBeGreaterThan(5)
    }
  })
})

describe('cruising levels', () => {
  it('follow the semicircular rule', () => {
    const corridor = { minAltFt: 8000, maxAltFt: 19000 } as never
    const rng = makeRng(7)
    for (let i = 0; i < 20; i += 1) {
      expect(semicircularLevelFt(rng, corridor, 90) / 1000) .toSatisfy((n: number) => n % 2 === 1)
      expect(semicircularLevelFt(rng, corridor, 270) / 1000).toSatisfy((n: number) => n % 2 === 0)
    }
  })

  it('keeps opposing traffic on one corridor a thousand feet apart', () => {
    // Which is the reason it is worth doing: without it the two directions
    // of the same corridor can be handed to the controller head-on at the
    // same level, before they have touched anything.
    const east = corridorRoute(airport, findCorridor('TRANSIT-EAST'))
    const west = corridorRoute(airport, findCorridor('TRANSIT-WEST'))
    const rng = makeRng(3)
    const a = semicircularLevelFt(rng, findCorridor('TRANSIT-EAST'), corridorEntry(airport, east, 6).hdg)
    const b = semicircularLevelFt(rng, findCorridor('TRANSIT-WEST'), corridorEntry(airport, west, 6).hdg)
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(1000)
  })

  it('still produces a level from a band too narrow to hold the right parity', () => {
    const narrow = { minAltFt: 12000, maxAltFt: 12000 } as never
    expect(semicircularLevelFt(makeRng(1), narrow, 90)).toBe(12000)
  })
})

describe('releasing transits', () => {
  it('releases them steadily rather than all at once', () => {
    const out = releases(generator(), 60)
    expect(out.length).toBeGreaterThan(4)
    // And never more at a time than the cap allows on the display.
    expect(out.length).toBeLessThan(60)
  })

  it('gives every one a route, a level and somewhere to go', () => {
    for (const a of releases(generator(), 60)) {
      expect(a.role).toBe('overflight')
      expect(a.navMode).toBe('LNAV')
      expect(a.route.length).toBeGreaterThan(1)
      expect(a.routeLeg).toBe(0)
      expect(a.destination).not.toBeNull()
      expect(a.destination).not.toBe(airport.icao)
      // Not an arrival: it came in on no feeder fix.
      expect(a.originFix).toBeNull()
      expect(a.altFt).toBeGreaterThanOrEqual(8000)
      expect(a.vsFpm).toBe(0)
    }
  })

  it('starts every one outside the airspace', () => {
    // Same as an arrival: seen for a minute or two before it is anybody's.
    for (const a of releases(generator(), 60)) {
      expect(a.entered, a.callsign).toBe(false)
      expect(isInSector(a, airport.controlZone), a.callsign).toBe(false)
    }
  })

  it('issues no callsign twice', () => {
    const out = releases(generator(), 120)
    expect(new Set(out.map((a) => a.callsign)).size).toBe(out.length)
  })

  it('deals the same session twice from the same seed', () => {
    const first = releases(generator(99), 60).map((a) => `${a.callsign}/${a.altFt}`)
    const second = releases(generator(99), 60).map((a) => `${a.callsign}/${a.altFt}`)
    expect(second).toEqual(first)
  })

  it('resumes rather than dealing again after a save and load', () => {
    // Set up the way a session is: the flight identity generator is shared
    // with the arrival spawner, and restoring the spawner restores it. A
    // reload that gave the transits a fresh one would deal fresh callsigns.
    const flights = new FlightGenerator(airport)
    const before = new Overflights({ airport, flights, seed: 5150 })
    const seen = releases(before, 30)
    const state = before.snapshot()
    const identities = flights.snapshot()

    const reloaded = new FlightGenerator(airport)
    reloaded.restore(identities)
    const after = new Overflights({ airport, flights: reloaded, seed: 1 })
    after.restore(state)
    // Both carried on from the same point, so both produce the same run.
    const a = releases(before, 30).map((x) => x.callsign)
    const b = releases(after, 30).map((x) => x.callsign)
    expect(b).toEqual(a)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('holds off when the display is already full of them', () => {
    const gen = generator()
    const full: Aircraft[] = []
    // A world already at the cap, which never empties.
    for (let i = 0; i < (config?.maxConcurrent ?? 5); i += 1) {
      full.push({ ...releases(generator(i + 1), 10)[0] } as Aircraft)
    }
    let released = 0
    for (let t = 0; t < 60 * 60; t += 1) released += gen.update(1, clockAt(t), full).length
    expect(released).toBe(0)
  })
})

describe('a transit crossing the sector', () => {
  /** Fly one until the world lets go of it, or give up. */
  function crossing(a: Aircraft): { readonly at: Aircraft; readonly why: string | null } {
    let x = a
    for (let i = 0; i < 90 * 60 * 20; i += 1) {
      x = enterSector(stepAircraft(x, 0.05, i * 0.05), airport.controlZone)
      const why = departureOf(x, airport.controlZone, 90)
      if (why !== null) return { at: x, why }
    }
    return { at: x, why: null }
  }

  it('flies in, crosses, and leaves without being touched', () => {
    // The whole feature in one test. Nobody issues a clearance; the
    // aeroplane appears outside the airspace, becomes the controller's,
    // flies its plan across and goes.
    for (const a of releases(generator(2026), 90).slice(0, 6)) {
      const { at, why } = crossing(a)
      expect(why, a.callsign).toBe('transited')
      expect(at.entered, `${a.callsign} never entered the airspace`).toBe(true)
      // Every published fix on the corridor flown. Not the whole route --
      // the last point on it lies outside the boundary, so the aircraft is
      // let go of on the way to it, which is the correct moment.
      expect(at.routeLeg, `${a.callsign} left part way round its corridor`).toBeGreaterThanOrEqual(
        a.route.length - 1,
      )
    }
  })

  it('takes long enough to be worth watching', () => {
    // A transit that crossed in ninety seconds would be scenery. These are
    // in the sector long enough to conflict with an arrival, which is the
    // only reason they are here.
    for (const a of releases(generator(2026), 90).slice(0, 4)) {
      const { at } = crossing(a)
      expect(at.spawnedAt).toBe(a.spawnedAt)
      expect(distanceNM(a.pos, at.pos), a.callsign).toBeGreaterThan(30)
    }
  })

  it('is never scored as an arrival that got away', () => {
    // The failure this exists to catch: a transit doing exactly its job and
    // being charged the lost-arrival penalty for it.
    for (const a of releases(generator(77), 90).slice(0, 6)) {
      expect(crossing(a).why).not.toBe('left')
    }
  })
})

describe('transits and the arrival sequence', () => {
  it('are kept out of the landing order', () => {
    // A transit in the sequence would take a place in the landing order and
    // the arrival behind it would be spaced against an aeroplane that is
    // not going to land.
    const transit = releases(generator(11), 60)[0] as Aircraft
    const mine: Aircraft = { ...transit, callsign: 'BAW1', role: 'arrival', entered: true }
    const built = buildSequence([{ ...transit, entered: true }, mine])
    const shown = [...built.sequence, ...built.stack, ...built.inbound].map(
      (f) => f.aircraft.callsign,
    )
    expect(shown).toContain('BAW1')
    expect(shown).not.toContain(transit.callsign)
  })
})

/* ------------------------------------------------------------- helpers */

function findCorridor(id: string): never {
  const c = (config?.corridors ?? []).find((x) => x.id === id)
  if (c === undefined) throw new Error(`no corridor ${id}`)
  return c as never
}

/** An aircraft-shaped thing at a position and level, for the airspace test. */
function atFt(pos: { x: number; y: number }, altFt: number): Aircraft {
  return { pos, altFt } as Aircraft
}
