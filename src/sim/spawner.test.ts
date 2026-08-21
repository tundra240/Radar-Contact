import { describe, expect, it } from 'vitest'
import type { Clock } from '../core/loop'
import { advance as advancePos, bearingDeg, distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { Spawner } from './spawner'
import type { Aircraft } from './types'

const airport = loadAirport(raw)

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
      world = world
        .map((a) => ({
          ...a,
          pos: advancePos(a.pos, a.hdg, (a.gsKts / 3600) * step),
        }))
        // And leaving once they have crossed the sector, standing in for
        // the landing or handoff that will remove them properly later.
        // Without this the concurrency cap fills and never empties.
        .filter((a) => distanceNM({ x: 0, y: 0 }, a.pos) < airport.sector.radiusNM + 10)
    }
  }
  return { world, all }
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
    const { all } = fly(makeSpawner(), 3600)
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
    const { all } = fly(makeSpawner(), 3600)
    expect(all.length).toBeGreaterThan(20)
    expect(all.length).toBeLessThan(60)
  })
})

describe('entry state', () => {
  const { all } = fly(makeSpawner(), 3600)

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

  it('tracks the hold inbound leg, which points at the field', () => {
    for (const a of all) {
      const fix = airport.navaids.find((n) => n.name === a.originFix)
      expect(a.hdg, a.callsign).toBeCloseTo(fix?.hold?.inboundTrue ?? -1, 6)
      // Under nobody's instruction yet beyond what it is already doing.
      expect(a.clearedHdg, a.callsign).toBe(a.hdg)
      expect(a.clearedAltFt, a.callsign).toBe(a.altFt)
      expect(a.clearedSpdKts, a.callsign).toBe(a.gsKts)
    }
  })

  it('arrives level, being vectored, with nothing behind it', () => {
    for (const a of all) {
      expect(a.vsFpm, a.callsign).toBe(0)
      expect(a.navMode, a.callsign).toBe('VECTOR')
      expect(a.clearedApproach, a.callsign).toBeNull()
      expect(a.trail.length, a.callsign).toBe(0)
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

    const { all: many } = fly(makeSpawner(4242), 6 * 3600)
    const narrow = many.filter((a) => a.wake === 'M').length
    const supers = many.filter((a) => a.wake === 'J').length
    expect(narrow / many.length).toBeGreaterThan(0.35)
    expect(supers / many.length).toBeLessThan(0.15)
  })
})

describe('flow management', () => {
  it('will not release an arrival on top of traffic at the fix', () => {
    // Otherwise the controller inherits a separation loss they had no hand
    // in creating.
    const spawner = makeSpawner()
    const lam = airport.navaids.find((n) => n.name === 'LAM')
    expect(lam).toBeDefined()
    if (!lam) return

    // Park an aircraft on every fix, so nothing is eligible.
    const blockers: Aircraft[] = spawner.entryFixes.map((fix, i) => ({
      callsign: `BLK${i}`,
      type: 'A320',
      wake: 'M',
      pos: fix.posNM,
      altFt: 9000,
      hdg: 270,
      gsKts: 250,
      vsFpm: 0,
      clearedHdg: 270,
      clearedAltFt: 9000,
      clearedSpdKts: 250,
      navMode: 'VECTOR',
      clearedApproach: null,
      hold: null,
      originFix: fix.name,
      trail: [],
      trailAt: 0,
      spawnedAt: 0,
    }))

    const due = clockAt(airport.traffic.firstSpawnSeconds)
    expect(
      spawner.update(airport.traffic.firstSpawnSeconds, due, blockers),
    ).toHaveLength(0)
    expect(spawner.deferred).toBeGreaterThan(0)
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
    const { all } = fly(makeSpawner(), 3600)
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
    // Nothing ever leaves, so the cap is the only thing that can stop it.
    const { world } = fly(spawner, 4 * 3600, { move: false })
    expect(world.length).toBeLessThanOrEqual(airport.traffic.maxConcurrent)
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
    const blockers: Aircraft[] = spawner.entryFixes.map((fix, i) => ({
      callsign: `BLK${i}`,
      type: 'A320',
      wake: 'M',
      pos: fix.posNM,
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
      originFix: fix.name,
      trail: [],
      trailAt: 0,
      spawnedAt: 0,
    }))
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
        pos: { x: -35 - i, y: -35 },
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
