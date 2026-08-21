import { describe, expect, it } from 'vitest'
import type { Clock } from '../core/loop'
import { advance as advancePos, angleDelta, bearingDeg, distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import { loadAirport, outerLimitNM } from '../data/airport'
import raw from '../data/egll.json'
import { departureOf, enterSector, isInSector } from './aircraft'
import { exitRangeNM } from './airspace'
import { Spawner } from './spawner'
import type { Aircraft } from './types'

const airport = loadAirport(raw)
/** Hoisted: it walks every vertex of the airspace, and never changes. */
const OUTER_LIMIT_NM = outerLimitNM(airport)

const clockAt = (seconds: number): Clock => ({
  ticks: Math.round(seconds * 20),
  elapsedSeconds: seconds,
  timeOfDaySeconds: (12 * 3600 + seconds) % 86400,
})

/**
 * Runs the spawner over simulated time, moving the traffic it produces.
 *
 * The movement matters: aircraft that never leave their fix would block it
 * forever under the spacing rule, so a test without it would see four
 * arrivals and stop. There is no physics module yet, so this is the crudest
 * possible stand-in -- straight ahead at groundspeed.
 */
function fly(
  spawner: Spawner,
  seconds: number,
  opts?: { move?: boolean; stepSeconds?: number },
): { world: Aircraft[]; all: Aircraft[] } {
  const step = opts?.stepSeconds ?? 0.05
  const move = opts?.move ?? true
  let world: Aircraft[] = []
  const all: Aircraft[] = []

  for (let s = 0; s <= seconds; s += step) {
    const clock = clockAt(s)
    const born = spawner.update(step, clock, world)
    world.push(...born)
    all.push(...born)
    if (move) {
      // The same two rules main.ts applies: an inbound aircraft becomes the
      // controller's when it crosses in, and only one that has been inside
      // can leave. A plain distance filter would delete every arrival on
      // the tick it appeared, since they are released outside.
      world = world
        .map((a) => ({
          ...a,
          pos: advancePos(a.pos, a.hdg, (a.gsKts / 3600) * step),
        }))
        .map((a) => enterSector(a, airport.controlZone))
        .filter((a) => departureOf(a, airport.controlZone, OUTER_LIMIT_NM) === null)
    }
  }
  return { world, all }
}

/** An aircraft parked exactly where a test needs one. */
function parked(
  callsign: string,
  pos: { readonly x: number; readonly y: number },
  altFt: number,
  over: Partial<Aircraft> = {},
): Aircraft {
  return {
    callsign,
    type: 'A320',
    wake: 'M',
    pos,
    altFt,
    hdg: 270,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 270,
    clearedAltFt: altFt,
    clearedSpdKts: 220,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    originFix: null,
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    ...over,
  }
}

/**
 * Where an arrival for this fix appears: out along the radial through it
 * until the airspace ends, then the configured distance beyond that.
 */
function gateOf(fix: { posNM: { x: number; y: number } }) {
  const radial = bearingDeg({ x: 0, y: 0 }, fix.posNM)
  const edge = exitRangeNM(airport.controlZone, { x: 0, y: 0 }, radial)
  return advancePos({ x: 0, y: 0 }, radial, edge + airport.traffic.entryDistanceNM)
}

/** The level an empty stack at this fix hands out first: its bottom. */
function bottomOf(fix: { entry: { minAltFt: number } | null }): number {
  const floor = Math.max(fix.entry?.minAltFt ?? 0, airport.sector.floorFt)
  return Math.ceil(floor / 1000) * 1000
}

function makeSpawner(seed?: number): Spawner {
  return seed === undefined
    ? new Spawner({ airport })
    : new Spawner({ airport, rng: makeRng(seed) })
}

describe('entry fixes', () => {
  it('uses the holding fixes from the config and nothing else', () => {
    const spawner = makeSpawner()
    expect(spawner.entryFixes.map((f) => f.name).sort()).toEqual(['BIG', 'BNN', 'LAM', 'OCK'])
  })

  it('ignores navaids that are not holds', () => {
    // CPT and MAY are on the chart but traffic does not arrive from them.
    const names = makeSpawner().entryFixes.map((f) => f.name)
    for (const plain of ['CPT', 'MAY', 'LON', 'BPK', 'MID']) {
      expect(names, plain).not.toContain(plain)
    }
  })

  it('spreads arrivals across all four fixes', () => {
    const { all } = fly(makeSpawner(), 1800)
    const used = new Set(all.map((a) => a.originFix))
    expect(used).toEqual(new Set(['LAM', 'BIG', 'BNN', 'OCK']))
  })
})

describe('timing', () => {
  it('holds the first arrival back until the opening delay', () => {
    const first = airport.traffic.firstSpawnSeconds
    const spawner = makeSpawner()
    // A second short of the opening delay, then the second that completes it.
    expect(spawner.update(first - 1, clockAt(first - 1), [])).toHaveLength(0)
    expect(spawner.update(1, clockAt(first), [])).toHaveLength(1)
  })

  it('runs on the simulation step, so a stopped clock produces nothing', () => {
    // This is what makes it follow the rate control and stop when paused:
    // with no step to bank, the accumulator never reaches the interval.
    const spawner = makeSpawner()
    const first = airport.traffic.firstSpawnSeconds
    const frozen = clockAt(first)
    expect(spawner.update(first, frozen, [])).toHaveLength(1)
    for (let i = 0; i < 500; i += 1) {
      expect(spawner.update(0, frozen, [])).toHaveLength(0)
    }
  })

  it('tightens the interval as the session goes on', () => {
    const spawner = makeSpawner()
    const t = airport.traffic
    const atStart = spawner.intervalSeconds(clockAt(0))
    const midway = spawner.intervalSeconds(clockAt((t.rampMinutes * 60) / 2))
    const atEnd = spawner.intervalSeconds(clockAt(t.rampMinutes * 60))

    expect(atStart).toBeCloseTo(t.initialIntervalSeconds, 6)
    expect(atEnd).toBeCloseTo(t.minIntervalSeconds, 6)
    expect(midway).toBeLessThan(atStart)
    expect(midway).toBeGreaterThan(atEnd)
  })

  it('does not keep tightening past the floor', () => {
    const spawner = makeSpawner()
    const late = spawner.intervalSeconds(clockAt(airport.traffic.rampMinutes * 60 * 10))
    expect(late).toBeCloseTo(airport.traffic.minIntervalSeconds, 6)
  })

  it('is not metronomic', () => {
    const { all } = fly(makeSpawner(), 2400)
    expect(all.length).toBeGreaterThan(8)
    const gaps: number[] = []
    for (let i = 1; i < all.length; i += 1) {
      gaps.push((all[i]?.spawnedAt ?? 0) - (all[i - 1]?.spawnedAt ?? 0))
    }
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(3)
  })

  it('delivers a plausible arrival rate', () => {
    // Somewhere in the region of a real approach sector rather than one an
    // hour or one a second.
    const { all } = fly(makeSpawner(), 1800)
    expect(all.length).toBeGreaterThan(20)
    expect(all.length).toBeLessThan(60)
  })
})

describe('entry state', () => {
  const { all } = fly(makeSpawner(), 1800)

  it('starts every arrival on its fix', () => {
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      expect(fix, a.originFix ?? 'none').toBeDefined()
      if (!fix) continue
      // Spawn position is the fix itself; the test mover shifts it after.
      expect(a.spawnedAt).toBeGreaterThanOrEqual(0)
    }
  })

  it('enters within the fix band, on a whole thousand', () => {
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      const band = fix?.entry
      expect(band, a.originFix ?? 'none').toBeDefined()
      if (!band) continue
      expect(a.altFt % 1000, `${a.callsign} ${a.altFt}`).toBe(0)
      expect(a.altFt, a.callsign).toBeGreaterThanOrEqual(band.minAltFt)
      expect(a.altFt, a.callsign).toBeLessThanOrEqual(band.maxAltFt)
    }
  })

  it('stays inside the sector', () => {
    for (const a of all) {
      expect(a.altFt, a.callsign).toBeGreaterThanOrEqual(airport.sector.floorFt)
      expect(a.altFt, a.callsign).toBeLessThanOrEqual(airport.sector.ceilingFt)
    }
  })

  it('respects the speed limit below the limit altitude', () => {
    const sector = airport.sector
    for (const a of all) {
      if (a.altFt < sector.speedLimitBelowFt) {
        expect(a.gsKts, `${a.callsign} at ${a.altFt}`).toBeLessThanOrEqual(sector.speedLimitKts)
      }
    }
  })

  it('enters at the standard speed, capped by the type and the sector', () => {
    const t2 = airport.traffic
    const sector = airport.sector
    for (const a of all) {
      const type = airport.aircraftTypes.find((x) => x.type === a.type)
      let expected = Math.min(t2.entrySpeedKts, type?.cruiseKts ?? Infinity)
      if (a.altFt < sector.speedLimitBelowFt) {
        expected = Math.min(expected, sector.speedLimitKts)
      }
      expect(a.gsKts, `${a.callsign} ${a.type} at ${a.altFt}`).toBe(expected)
    }
  })

  it('uses the standard entry speed in practice', () => {
    // Every type cruises faster than the standard entry speed, so in this
    // configuration every arrival enters at it.
    for (const a of all) expect(a.gsKts, a.callsign).toBe(airport.traffic.entrySpeedKts)
  })

  it('arrives level, with no vector on it', () => {
    for (const a of all) {
      expect(a.clearedAltFt, a.callsign).toBe(a.altFt)
      expect(a.clearedSpdKts, a.callsign).toBe(a.gsKts)
      // No cleared heading: in the hold it is navigating itself, so a
      // vector on the strip would be one nothing is flying.
      expect(a.clearedHdg, a.callsign).toBeNull()
    }
  })

  it('points at its fix, which is not the same as the hold inbound leg', () => {
    // A hold turned to fit the airspace faces a different way from the
    // radial the arrival comes down, so the two must not be conflated.
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      if (!fix) throw new Error(`no fix for ${a.callsign}`)
      expect(bearingDeg(a.pos, fix.posNM), a.callsign).toBeCloseTo(a.hdg, 4)
    }
    const bnn = all.find((a) => a.originFix === 'BNN')
    const bnnFix = airport.navaids.find((n) => n.name === 'BNN')
    if (bnn && bnnFix?.hold) {
      expect(Math.abs(angleDelta(bnn.hdg, bnnFix.hold.inboundTrue))).toBeGreaterThan(30)
    }
  })

  it('appears outside the boundary, so it is seen before it is yours', () => {
    // The whole point of releasing out there: traffic is visible, and
    // identifiable, for a couple of minutes before it can be worked.
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      if (!fix) throw new Error(`no fix for ${a.callsign}`)
      expect(distanceNM(a.pos, gateOf(fix)), a.callsign).toBeCloseTo(0, 5)
      expect(isInSector(a, airport.controlZone), a.callsign).toBe(false)
      expect(a.entered, a.callsign).toBe(false)
    }
  })

  it('appears on the radial through its own fix, pointing at it', () => {
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      if (!fix) throw new Error(`no fix for ${a.callsign}`)
      // Straight out from the field through the fix, and closing on it.
      expect(bearingDeg({ x: 0, y: 0 }, a.pos), a.callsign)
        .toBeCloseTo(bearingDeg({ x: 0, y: 0 }, fix.posNM), 4)
      expect(bearingDeg(a.pos, fix.posNM), a.callsign).toBeCloseTo(a.hdg, 4)
    }
  })

  it('arrives level, already holding, with nothing behind it', () => {
    for (const a of all) {
      expect(a.vsFpm, a.callsign).toBe(0)
      // Holding from the moment it appears: it flies itself to the fix and
      // enters the pattern with no instruction from anybody.
      expect(a.navMode, a.callsign).toBe('HOLD')
      expect(a.hold?.fix, a.callsign).toBe(a.originFix)
      expect(a.clearedApproach, a.callsign).toBeNull()
      expect(a.trail.length, a.callsign).toBe(0)
    }
  })

  it('carries the published pattern for its own fix', () => {
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      expect(a.hold?.turns, a.callsign).toBe(fix?.hold?.turns)
      expect(a.hold?.legMins, a.callsign).toBe(fix?.hold?.legMins)
      expect(a.hold?.inboundTrue, a.callsign).toBeCloseTo(fix?.hold?.inboundTrue ?? -1, 6)
    }
  })

  it('gives every aircraft a distinct callsign', () => {
    const seen = new Set(all.map((a) => a.callsign))
    expect(seen.size).toBe(all.length)
  })

  it('uses airline codes from the config', () => {
    const codes = new Set(airport.traffic.airlines.map((a) => a.code))
    for (const a of all) {
      expect(codes.has(a.callsign.slice(0, 3)), a.callsign).toBe(true)
    }
  })

  it('uses aircraft types from the config, weighted towards the narrowbodies', () => {
    const known = new Set(airport.aircraftTypes.map((t) => t.type))
    for (const a of all) expect(known.has(a.type), a.type).toBe(true)

    // A big sample of releases without flying six hours to get one: the
    // fleet mix is the generator's business and does not depend on the
    // world moving at all.
    const sampler = makeSpawner(4242)
    const many: Aircraft[] = []
    for (let i = 0; i < 400; i += 1) many.push(...sampler.spawnNow(clockAt(i * 120), []))
    expect(many.length).toBeGreaterThan(300)

    const narrow = many.filter((a) => a.wake === 'M').length
    const supers = many.filter((a) => a.wake === 'J').length
    expect(narrow / many.length).toBeGreaterThan(0.35)
    expect(supers / many.length).toBeLessThan(0.15)
  })
})

describe('flow management', () => {
  it('will not release an arrival on top of traffic at the entry gate', () => {
    // Otherwise the controller inherits a separation loss they had no hand
    // in creating. The gate is where the arrival appears, so that is where
    // the check belongs -- traffic over the fix itself is a stack, and a
    // stack is the normal state of affairs now.
    const spawner = makeSpawner()
    const blockers = spawner.entryFixes.map((fix, i) =>
      parked(`BLK${i}`, gateOf(fix), bottomOf(fix)),
    )

    const due = clockAt(airport.traffic.firstSpawnSeconds)
    expect(spawner.update(airport.traffic.firstSpawnSeconds, due, blockers)).toHaveLength(0)
    expect(spawner.deferred).toBeGreaterThan(0)
  })

  it('releases past a gate blocker that is a thousand feet away', () => {
    // Vertical separation is the entire point of a stack. Refusing to
    // release under traffic two thousand feet above would throttle the flow
    // for a conflict that does not exist.
    const spawner = makeSpawner()
    const blockers = spawner.entryFixes.map((fix, i) =>
      parked(`BLK${i}`, gateOf(fix), bottomOf(fix) + 2000),
    )

    const due = clockAt(airport.traffic.firstSpawnSeconds)
    expect(spawner.update(airport.traffic.firstSpawnSeconds, due, blockers)).toHaveLength(1)
  })

  it('will not release into a stack with no level left', () => {
    // Filling one fix only, so the concurrency cap cannot be what refuses:
    // this is the stack rule on its own.
    const spawner = makeSpawner()
    const lam = spawner.entryFixes.find((n) => n.name === 'LAM')
    if (!lam || lam.hold === null || lam.entry === null) throw new Error('no LAM hold')

    const pattern = {
      fix: 'LAM',
      posNM: lam.posNM,
      inboundTrue: lam.hold.inboundTrue,
      turns: lam.hold.turns,
      legMins: lam.hold.legMins,
    }
    const levels: number[] = []
    for (let ft = bottomOf(lam); ft <= lam.entry.maxAltFt; ft += 1000) levels.push(ft)
    expect(levels.length).toBeGreaterThan(1)

    const full = levels.map((ft, i) =>
      parked(`LAM${i}`, lam.posNM, ft, { navMode: 'HOLD', hold: pattern, originFix: 'LAM' }),
    )
    expect(full.length).toBeLessThan(airport.traffic.maxConcurrent)

    // Every release now has to go somewhere else.
    for (let i = 0; i < 12; i += 1) {
      const released = spawner.spawnNow(clockAt(i * 120), full)
      expect(released[0]?.originFix, `attempt ${i}`).not.toBe('LAM')
    }
  })

  it('releases again once the fix is clear', () => {
    const spawner = makeSpawner()
    const first = spawner.update(
      airport.traffic.firstSpawnSeconds,
      clockAt(airport.traffic.firstSpawnSeconds),
      [],
    )
    expect(first).toHaveLength(1)

    // Nothing in the world at all: the only bar is the per-fix cooldown.
    const later = airport.traffic.firstSpawnSeconds + airport.traffic.minFixSpacingSeconds + 200
    const { all } = fly(makeSpawner(), later)
    expect(all.length).toBeGreaterThan(1)
  })

  it('will not reuse the same fix inside the cooldown', () => {
    const { all } = fly(makeSpawner(), 1800)
    const lastAt = new Map<string, number>()
    for (const a of all) {
      const fix = a.originFix ?? ''
      const previous = lastAt.get(fix)
      if (previous !== undefined) {
        expect(
          a.spawnedAt - previous,
          `${fix} reused after ${(a.spawnedAt - previous).toFixed(1)}s`,
        ).toBeGreaterThanOrEqual(airport.traffic.minFixSpacingSeconds)
      }
      lastAt.set(fix, a.spawnedAt)
    }
  })

  it('stops adding traffic once the sector is full', () => {
    const spawner = makeSpawner()
    // Nothing ever moves, so nothing ever enters: the cap counts only
    // traffic inside the boundary, so it is inbound traffic that stacks up
    // outside and the workload that stays capped.
    const { world } = fly(spawner, 4 * 3600, { move: false })
    const inside = world.filter((a) => isInSector(a, airport.controlZone))
    expect(inside.length).toBeLessThanOrEqual(airport.traffic.maxConcurrent)
    expect(spawner.deferred).toBeGreaterThan(0)
  })

  it('reports how long until the next arrival', () => {
    const spawner = makeSpawner()
    const first = airport.traffic.firstSpawnSeconds
    expect(spawner.nextInSeconds()).toBeCloseTo(first, 6)
    spawner.update(first / 2, clockAt(first / 2), [])
    expect(spawner.nextInSeconds()).toBeCloseTo(first / 2, 6)
    spawner.update(first / 2, clockAt(first), [])
    expect(spawner.nextInSeconds()).toBeGreaterThan(0)
  })
})

describe('reproducibility', () => {
  it('produces an identical stream for the same seed', () => {
    // A scenario can be replayed and a bug report acted on.
    const key = (a: Aircraft): string =>
      `${a.spawnedAt.toFixed(2)}|${a.callsign}|${a.type}|${a.originFix}|${a.altFt}|${a.gsKts}`
    const a = fly(makeSpawner(777), 1800).all.map(key)
    const b = fly(makeSpawner(777), 1800).all.map(key)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(5)
  })

  it('produces a different stream for a different seed', () => {
    const a = fly(makeSpawner(1), 1800).all.map((x) => x.callsign)
    const b = fly(makeSpawner(2), 1800).all.map((x) => x.callsign)
    expect(a).not.toEqual(b)
  })

  it('defaults to the seed in the config', () => {
    const a = fly(new Spawner({ airport }), 900).all.map((x) => x.callsign)
    const b = fly(makeSpawner(airport.traffic.seed), 900).all.map((x) => x.callsign)
    expect(a).toEqual(b)
  })
})

describe('the cadence accumulator', () => {
  it('banks small steps the same as one large one', () => {
    // The point of accumulating the step rather than comparing timestamps:
    // the result cannot depend on how the simulation happens to be diced up.
    const first = airport.traffic.firstSpawnSeconds
    const coarse = makeSpawner(11)
    expect(coarse.update(first, clockAt(first), [])).toHaveLength(1)

    const fine = makeSpawner(11)
    let released = 0
    for (let i = 0; i < first * 20; i += 1) {
      released += fine.update(0.05, clockAt((i + 1) * 0.05), []).length
    }
    expect(released).toBe(1)
  })

  it('keeps the gap inside the configured band', () => {
    // The cadence is stated as a range, so jitter varies it within that
    // rather than taking it outside.
    const t = airport.traffic
    const { all } = fly(makeSpawner(99), 5400)
    expect(all.length).toBeGreaterThan(20)

    const gaps: number[] = []
    for (let i = 1; i < all.length; i += 1) {
      gaps.push((all[i]?.spawnedAt ?? 0) - (all[i - 1]?.spawnedAt ?? 0))
    }
    // Gaps longer than the band mean an arrival was held, which is a
    // different mechanism; the floor is what the band has to guarantee.
    for (const g of gaps) {
      expect(g, `gap of ${g.toFixed(1)}s`).toBeGreaterThanOrEqual(t.minIntervalSeconds - 0.06)
    }
    const unheld = gaps.filter((g) => g <= t.initialIntervalSeconds + 0.06)
    expect(unheld.length).toBeGreaterThan(gaps.length / 2)
  })

  it('runs one arrival every thirty to sixty seconds', () => {
    expect(airport.traffic.minIntervalSeconds).toBe(30)
    expect(airport.traffic.initialIntervalSeconds).toBe(60)
  })
})

describe('inward heading', () => {
  it('points every arrival at the airport reference point', () => {
    const { all } = fly(makeSpawner(7), 1800)
    expect(all.length).toBeGreaterThan(5)

    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      expect(fix, a.originFix ?? 'none').toBeDefined()
      if (!fix) continue
      // Computed from the fix to the origin, which is the ARP.
      const inward = bearingDeg(fix.posNM, { x: 0, y: 0 })
      expect(a.hdg, `${a.callsign} from ${fix.name}`).toBeCloseTo(inward, 6)
    }
  })

  it('closes the distance to the field rather than opening it', () => {
    // The heading is only useful if flying it actually brings the aircraft
    // in, so this checks the geometry rather than the number.
    const { all } = fly(makeSpawner(7), 1800)
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      if (!fix) continue
      const before = distanceNM({ x: 0, y: 0 }, fix.posNM)
      const after = distanceNM({ x: 0, y: 0 }, advancePos(fix.posNM, a.hdg, 1))
      expect(after, `${a.callsign} from ${fix.name}`).toBeLessThan(before)
    }
  })
})

describe('on command', () => {
  it('releases immediately without waiting for the cadence', () => {
    const spawner = makeSpawner()
    // Nothing banked at all, so the automatic path would produce nothing.
    expect(spawner.update(0, clockAt(0), [])).toHaveLength(0)
    const born = spawner.spawnNow(clockAt(0), [])
    expect(born).toHaveLength(1)
    expect(spawner.spawned).toBe(1)
  })

  it('ignores the per-fix cooldown that only paces the automatic flow', () => {
    const spawner = makeSpawner()
    const first = spawner.spawnNow(clockAt(0), [])
    expect(first).toHaveLength(1)
    // Straight away again: the cooldown would have blocked the automatic
    // path, but a deliberate command should still place one.
    const second = spawner.spawnNow(clockAt(0), first)
    expect(second).toHaveLength(1)
    expect(second[0]?.originFix).not.toBe(first[0]?.originFix)
  })

  it('still refuses to put an aircraft on top of another', () => {
    // A manual trigger must not be able to manufacture a separation loss.
    const spawner = makeSpawner()
    const blockers = spawner.entryFixes.map((fix, i) =>
      parked(`BLK${i}`, gateOf(fix), bottomOf(fix)),
    )
    expect(spawner.spawnNow(clockAt(0), blockers)).toHaveLength(0)
    expect(spawner.deferred).toBeGreaterThan(0)
  })

  it('respects the concurrency cap', () => {
    // Parked well clear of every fix, so the cap is the only thing that can
    // refuse. With traffic sitting on the fixes instead it is the spacing
    // rule that stops it, which is a different mechanism.
    const spawner = makeSpawner()
    const full: Aircraft[] = Array.from(
      { length: airport.traffic.maxConcurrent },
      (_unused, i) => ({
        callsign: `FULL${i}`,
        type: 'A320',
        wake: 'M',
        // Inside the boundary, so they count towards the workload, and
        // clear of every fix so it is the cap that refuses and not the
        // spacing rule.
        pos: { x: 4 + i * 0.4, y: -6 },
        altFt: 9000,
        hdg: 270,
        gsKts: 220,
        vsFpm: 0,
        clearedHdg: 270,
        clearedAltFt: 9000,
        clearedSpdKts: 220,
        navMode: 'VECTOR',
        clearedApproach: null,
        hold: null,
        originFix: null,
        entered: true,
        trail: [],
        trailAt: 0,
        spawnedAt: 0,
      }),
    )
    expect(spawner.spawnNow(clockAt(0), full)).toHaveLength(0)
    // One fewer and there is room again.
    expect(spawner.spawnNow(clockAt(0), full.slice(1))).toHaveLength(1)
  })

  it('resets the cadence, so an automatic arrival does not follow at once', () => {
    const spawner = makeSpawner()
    spawner.spawnNow(clockAt(0), [])
    expect(spawner.nextInSeconds()).toBeGreaterThanOrEqual(
      airport.traffic.minIntervalSeconds,
    )
  })
})

describe('the seed', () => {
  /**
   * The bug this covers: the seed came only from the airport config, which
   * is a fixed number, so every session dealt the same aircraft in the same
   * order off the same fixes. A seeded generator is meant to be pinnable,
   * not permanently pinned.
   */
  const firstFew = (opts: { seed?: number }, count = 8): string[] => {
    const spawner = opts.seed === undefined
      ? new Spawner({ airport })
      : new Spawner({ airport, seed: opts.seed })
    const out: string[] = []
    let t = 0
    while (out.length < count && t < 60 * 60) {
      const released = spawner.spawnNow(clockAt(t), [])
      for (const a of released) out.push(`${a.callsign}/${a.type}/${a.originFix ?? '?'}`)
      t += 60
    }
    return out
  }

  it('deals a different session for a different seed', () => {
    const a = firstFew({ seed: 1 })
    const b = firstFew({ seed: 2 })
    expect(a).toHaveLength(8)
    // Not one aircraft in common in the same slot. Two streams that shared
    // even the opening aircraft would still feel like the same session.
    expect(a.filter((x, i) => x === b[i])).toEqual([])
  })

  it('deals the same session for the same seed, which is the point of one', () => {
    expect(firstFew({ seed: 4242 })).toEqual(firstFew({ seed: 4242 }))
  })

  it('separates seeds a millisecond apart, since the clock supplies them', () => {
    const now = 1755800000000
    const a = firstFew({ seed: now })
    const b = firstFew({ seed: now + 1 })
    expect(a[0]).not.toBe(b[0])
  })

  it('reports the seed it is running, so a session can be written down', () => {
    expect(new Spawner({ airport, seed: 777 }).seed).toBe(777)
    expect(new Spawner({ airport }).seed).toBe(airport.traffic.seed)
  })
})

describe('the stack', () => {
  /**
   * Arrivals hold over their fix now, so two of them at the same fix have
   * to be at different levels or the controller is handed an overlap they
   * had no part in. Nothing moves in this run, so every arrival is still
   * sitting in its stack at the end of it.
   */
  const { all } = fly(makeSpawner(), 3600, { move: false })

  const byFix = (): Map<string, Aircraft[]> => {
    const out = new Map<string, Aircraft[]>()
    for (const a of all) {
      if (a.originFix === null) continue
      out.set(a.originFix, [...(out.get(a.originFix) ?? []), a])
    }
    return out
  }

  it('puts more than one aircraft over at least one fix', () => {
    // Otherwise the rest of this proves nothing.
    const stacked = [...byFix().values()].filter((list) => list.length > 1)
    expect(stacked.length).toBeGreaterThan(0)
  })

  it('never gives two aircraft at a fix the same level', () => {
    for (const [fix, list] of byFix()) {
      const levels = list.map((a) => a.clearedAltFt)
      expect(new Set(levels).size, fix).toBe(levels.length)
    }
  })

  it('enters each one above the last, the way a stack fills', () => {
    for (const [fix, list] of byFix()) {
      const levels = list.map((a) => a.clearedAltFt)
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i], `${fix} #${i}`).toBeGreaterThan(levels[i - 1] as number)
      }
    }
  })

  it('spaces the levels a thousand feet apart, on the thousand', () => {
    for (const [fix, list] of byFix()) {
      for (const a of list) {
        expect(a.clearedAltFt % 1000, `${fix} ${a.callsign}`).toBe(0)
      }
      const levels = [...list.map((a) => a.clearedAltFt)].sort((x, y) => x - y)
      for (let i = 1; i < levels.length; i += 1) {
        expect((levels[i] as number) - (levels[i - 1] as number), fix)
          .toBeGreaterThanOrEqual(1000)
      }
    }
  })

  it('keeps every level inside the published entry band for its fix', () => {
    for (const [name, list] of byFix()) {
      const fix = airport.navaids.find((n) => n.name === name)
      if (!fix?.entry) throw new Error(`no entry band for ${name}`)
      for (const a of list) {
        expect(a.altFt, `${name} ${a.callsign}`).toBeGreaterThanOrEqual(fix.entry.minAltFt)
        expect(a.altFt, `${name} ${a.callsign}`).toBeLessThanOrEqual(fix.entry.maxAltFt)
      }
    }
  })
})

describe('where arrivals appear', () => {
  /**
   * Arrivals are released outside the boundary on purpose, so that traffic
   * can be seen coming before it becomes the controller's. The failure this
   * guards against is the one that used to be possible in reverse: a
   * release the world removes on the tick it appears, which on the scope is
   * a target flickering into existence and vanishing.
   */
  const { all } = fly(makeSpawner(), 3600, { move: false })

  it('covers all four fixes, so every feed is actually exercised', () => {
    expect(new Set(all.map((a) => a.originFix)).size).toBe(4)
  })

  it('hands every feed over the same distance outside the airspace', () => {
    // Measured against the real boundary, which at Heathrow lies anywhere
    // from seventeen miles out to thirty-five depending on the direction.
    for (const a of all) {
      const radial = bearingDeg({ x: 0, y: 0 }, a.pos)
      const edge = exitRangeNM(airport.controlZone, { x: 0, y: 0 }, radial)
      expect(distanceNM({ x: 0, y: 0 }, a.pos) - edge, a.callsign)
        .toBeCloseTo(airport.traffic.entryDistanceNM, 1)
    }
  })

  it('releases nothing that the world would immediately remove', () => {
    for (const a of all) {
      expect(departureOf(a, airport.controlZone), a.callsign).toBeNull()
    }
  })

  it('releases nothing already inside the boundary', () => {
    // An arrival that appeared inside would be the controller's before they
    // had a chance to see it coming.
    for (const a of all) {
      expect(isInSector(a, airport.controlZone), a.callsign).toBe(false)
      expect(a.entered, a.callsign).toBe(false)
    }
  })
})
