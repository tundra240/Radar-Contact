import { describe, expect, it } from 'vitest'
import { bearingDeg, distanceNM } from '../core/geo'
import { makeRng } from '../core/rng'
import { loadAirport, outerLimitNM } from '../data/airport'
import type { ControlZone } from './airspace'
import raw from '../data/egll.json'
import {
  TRAIL_INTERVAL_SECONDS,
  TRAIL_POINTS,
  advancePosition,
  departureOf,
  enterSector,
  isInSector,
  distanceFlownNM,
  stepAircraft,
  stepTrail,
} from './aircraft'
import { Spawner } from './spawner'
import type { Aircraft } from './types'

const airport = loadAirport(raw)
/** Hoisted: it walks every vertex of the airspace, and never changes. */
const OUTER_LIMIT_NM = outerLimitNM(airport)
const ORIGIN = { x: 0, y: 0 }

const base: Aircraft = {
  callsign: 'BAW123',
  type: 'A320',
  wake: 'M',
  pos: { x: 0, y: 0 },
  altFt: 9000,
  hdg: 90,
  gsKts: 220,
  vsFpm: 0,
  clearedHdg: 90,
  clearedAltFt: 9000,
  clearedSpdKts: 220,
  navMode: 'VECTOR',
  clearedApproach: null,
  hold: null,
  originFix: 'LAM',
  entered: true,
  trail: [],
  trailAt: 0,
  spawnedAt: 0,
}

/** Runs the simulation the way the loop does: fixed fifty millisecond steps. */
function flyFor(a: Aircraft, seconds: number, startAt = 0): Aircraft {
  const step = 0.05
  let current = a
  const steps = Math.round(seconds / step)
  for (let i = 1; i <= steps; i += 1) {
    // Multiplied rather than accumulated, exactly as the loop derives
    // simulated time from its tick count.
    current = stepAircraft(current, step, startAt + i * step)
  }
  return current
}

describe('distance flown', () => {
  it('is speed times time', () => {
    expect(distanceFlownNM(220, 3600)).toBeCloseTo(220, 9)
    expect(distanceFlownNM(220, 0.05)).toBeCloseTo(220 / 72000, 12)
    expect(distanceFlownNM(0, 60)).toBe(0)
    expect(distanceFlownNM(220, -1)).toBe(0)
  })
})

describe('position advancement', () => {
  it('moves along the heading', () => {
    // One hour at 220 knots is 220 miles, and the compass convention puts
    // 090 due east and 000 due north.
    const east = advancePosition(ORIGIN, 90, 90, 220, 3600)
    expect(east.x).toBeCloseTo(220, 6)
    expect(east.y).toBeCloseTo(0, 6)

    const north = advancePosition(ORIGIN, 0, 0, 220, 3600)
    expect(north.y).toBeCloseTo(220, 6)
    expect(north.x).toBeCloseTo(0, 6)

    const south = advancePosition(ORIGIN, 180, 180, 100, 3600)
    expect(south.y).toBeCloseTo(-100, 6)

    const west = advancePosition(ORIGIN, 270, 270, 100, 3600)
    expect(west.x).toBeCloseTo(-100, 6)
  })

  it('stays put with no speed or no time', () => {
    expect(advancePosition({ x: 5, y: 5 }, 90, 90, 0, 10)).toEqual({ x: 5, y: 5 })
    expect(advancePosition({ x: 5, y: 5 }, 90, 90, 220, 0)).toEqual({ x: 5, y: 5 })
    expect(advancePosition({ x: 5, y: 5 }, 90, 90, 220, -1)).toEqual({ x: 5, y: 5 })
  })

  it('flies the arc of a turn rather than the chord', () => {
    // Mid-heading integration. Turning from 090 to 000 over the step, the
    // track should lie between the two, not along either.
    const turned = advancePosition(ORIGIN, 90, 0, 220, 60)
    const track = bearingDeg(ORIGIN, turned)
    expect(track).toBeGreaterThan(0)
    expect(track).toBeLessThan(90)
    expect(track).toBeCloseTo(45, 6)
  })

  it('covers the same ground however finely the step is diced', () => {
    // Not a given for a turning aircraft, and the reason for integrating on
    // the mid-heading rather than the start or the end.
    const coarse = advancePosition(ORIGIN, 90, 90, 220, 60)
    let fine = ORIGIN
    for (let i = 0; i < 1200; i += 1) fine = advancePosition(fine, 90, 90, 220, 0.05)
    expect(distanceNM(coarse, fine)).toBeLessThan(0.001)
  })
})

describe('the history trail', () => {
  it('lays a point down once per sweep, not once per step', () => {
    // A twenty hertz simulation would bank a thousand points a minute.
    const before = stepTrail(base, { x: 1, y: 1 }, TRAIL_INTERVAL_SECONDS - 0.1)
    expect(before.trail).toHaveLength(0)

    const after = stepTrail(base, { x: 1, y: 1 }, TRAIL_INTERVAL_SECONDS)
    expect(after.trail).toHaveLength(1)
    expect(after.trailAt).toBe(TRAIL_INTERVAL_SECONDS)
  })

  it('records where the aircraft was, so the trail sits behind it', () => {
    const previous = { x: 3, y: 4 }
    const after = stepTrail(base, previous, TRAIL_INTERVAL_SECONDS)
    expect(after.trail[0]).toEqual(previous)
  })

  it('keeps the newest first', () => {
    let a = base
    for (let i = 1; i <= 3; i += 1) {
      const t = stepTrail(a, { x: i, y: 0 }, i * TRAIL_INTERVAL_SECONDS)
      a = { ...a, trail: t.trail, trailAt: t.trailAt }
    }
    expect(a.trail.map((p) => p.x)).toEqual([3, 2, 1])
  })

  it('never grows past the length it keeps', () => {
    let a = base
    for (let i = 1; i <= TRAIL_POINTS * 4; i += 1) {
      const t = stepTrail(a, { x: i, y: 0 }, i * TRAIL_INTERVAL_SECONDS)
      a = { ...a, trail: t.trail, trailAt: t.trailAt }
    }
    expect(a.trail).toHaveLength(TRAIL_POINTS)
    // And it is the most recent ones that survive.
    expect(a.trail[0]?.x).toBe(TRAIL_POINTS * 4)
  })

  it('accumulates as an aircraft flies', () => {
    const flown = flyFor(base, TRAIL_INTERVAL_SECONDS * 3)
    expect(flown.trail.length).toBeGreaterThanOrEqual(3)
    // Consecutive points are a sweep apart, so roughly the distance flown
    // in that time.
    const expectedGap = distanceFlownNM(base.gsKts, TRAIL_INTERVAL_SECONDS)
    const first = flown.trail[0]
    const second = flown.trail[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (!first || !second) return
    expect(distanceNM(first, second)).toBeCloseTo(expectedGap, 2)
  })
})

describe('one step of everything', () => {
  it('flies the autopilot, moves, and records the trail together', () => {
    const a: Aircraft = {
      ...base,
      hdg: 90,
      clearedHdg: 180,
      altFt: 9000,
      clearedAltFt: 6000,
      gsKts: 250,
      clearedSpdKts: 200,
    }
    const next = stepAircraft(a, 1, TRAIL_INTERVAL_SECONDS)

    expect(next.hdg).toBeCloseTo(93, 9)
    expect(next.altFt).toBeCloseTo(8975, 9)
    expect(next.vsFpm).toBeCloseTo(-1500, 6)
    expect(next.gsKts).toBeCloseTo(248.5, 9)
    expect(distanceNM(a.pos, next.pos)).toBeCloseTo(distanceFlownNM(248.5, 1), 4)
    expect(next.trail).toHaveLength(1)
  })

  it('leaves identity and clearances alone', () => {
    const next = stepAircraft(base, 1, 0)
    expect(next.callsign).toBe(base.callsign)
    expect(next.type).toBe(base.type)
    expect(next.wake).toBe(base.wake)
    expect(next.clearedAltFt).toBe(base.clearedAltFt)
    expect(next.clearedSpdKts).toBe(base.clearedSpdKts)
    expect(next.navMode).toBe(base.navMode)
    expect(next.originFix).toBe(base.originFix)
    expect(next.spawnedAt).toBe(base.spawnedAt)
  })

  it('is deterministic', () => {
    const a = flyFor(base, 30)
    const b = flyFor(base, 30)
    expect(a).toEqual(b)
  })
})

describe('arrivals actually leave their entry fix', () => {
  const lam = airport.navaids.find((n) => n.name === 'LAM')

  it('closes the distance to the field', () => {
    expect(lam).toBeDefined()
    if (!lam) return

    const inbound = bearingDeg(lam.posNM, ORIGIN)
    const arrival: Aircraft = {
      ...base,
      pos: lam.posNM,
      hdg: inbound,
      clearedHdg: inbound,
      gsKts: airport.traffic.entrySpeedKts,
      clearedSpdKts: airport.traffic.entrySpeedKts,
    }

    const startDistance = distanceNM(ORIGIN, arrival.pos)
    const after = flyFor(arrival, 300)
    const endDistance = distanceNM(ORIGIN, after.pos)

    expect(endDistance).toBeLessThan(startDistance)
    // Five minutes at 220 knots is about eighteen miles.
    expect(startDistance - endDistance).toBeCloseTo(18.3, 0)
  })

  it('clears the spacing radius that was blocking the fix', () => {
    // This is the whole point of the physics step: while an arrival sat on
    // its fix the spawner refused to release another, so the flow stalled
    // at four. Once it moves, the fix frees up.
    expect(lam).toBeDefined()
    if (!lam) return

    const inbound = bearingDeg(lam.posNM, ORIGIN)
    const arrival: Aircraft = {
      ...base,
      pos: lam.posNM,
      hdg: inbound,
      clearedHdg: inbound,
      gsKts: airport.traffic.entrySpeedKts,
      clearedSpdKts: airport.traffic.entrySpeedKts,
    }

    const spacing = airport.traffic.minFixSpacingNM
    expect(distanceNM(arrival.pos, lam.posNM)).toBeLessThan(spacing)

    // At 220 knots, eight miles takes a little over two minutes.
    const after = flyFor(arrival, 150)
    expect(distanceNM(after.pos, lam.posNM)).toBeGreaterThan(spacing)
  })

  it('follows a descent clearance down while it goes', () => {
    expect(lam).toBeDefined()
    if (!lam) return
    const arrival: Aircraft = {
      ...base,
      pos: lam.posNM,
      altFt: 13000,
      clearedAltFt: 7000,
      hdg: bearingDeg(lam.posNM, ORIGIN),
      clearedHdg: bearingDeg(lam.posNM, ORIGIN),
    }
    // Six thousand feet at fifteen hundred a minute is four minutes, plus
    // a little so the level-off has been and gone.
    const after = flyFor(arrival, 250)
    expect(after.altFt).toBeCloseTo(7000, 3)
    expect(after.vsFpm).toBe(0)
  })
})

describe('the flow, end to end', () => {
  /**
   * Runs exactly what main.ts runs each tick: fly everything, release what
   * has crossed the sector, then let the spawner see the world as it now
   * is. Nothing here is a stand-in.
   */
  function runSector(seconds: number, opts: { seed?: number; work?: boolean } = {}) {
    const spawner =
      opts.seed === undefined
        ? new Spawner({ airport })
        : new Spawner({ airport, rng: makeRng(opts.seed) })

    const step = 0.05
    let traffic: readonly Aircraft[] = []
    let handedOff = 0
    let emptyAfterFirst = 0
    let peak = 0
    let worked = 0
    let firstSeen = false
    const counts: number[] = []

    for (let i = 1; i <= Math.round(seconds / step); i += 1) {
      const elapsed = i * step
      const clock = {
        ticks: i,
        elapsedSeconds: elapsed,
        timeOfDaySeconds: (12 * 3600 + elapsed) % 86400,
      }

      const flown = traffic
        .map((a) => stepAircraft(a, step, elapsed))
        .map((a) => enterSector(a, airport.controlZone))
      let kept = flown.filter((a) => departureOf(a, airport.controlZone, OUTER_LIMIT_NM) === null)
      handedOff += flown.length - kept.length

      // A controller, once a minute: take whatever is lowest in a stack and
      // send it on its way. Crude, but it is the thing the simulation
      // cannot do for itself, and without it nothing ever leaves a hold.
      if (opts.work === true && i % (20 * 60) === 0) {
        const next = kept
          .filter((a) => a.navMode === 'HOLD')
          .sort((x, y) => x.altFt - y.altFt)[0]
        if (next !== undefined) {
          const away = bearingDeg(ORIGIN, next.pos)
          kept = kept.map((a) =>
            a.callsign === next.callsign
              ? { ...a, navMode: 'VECTOR' as const, hold: null, clearedHdg: away }
              : a,
          )
          worked += 1
        }
      }

      const arrivals = spawner.update(step, clock, kept)
      traffic = arrivals.length > 0 ? [...kept, ...arrivals] : kept

      if (traffic.length > 0) firstSeen = true
      if (firstSeen && traffic.length === 0) emptyAfterFirst += 1
      peak = Math.max(peak, traffic.length)
      counts.push(traffic.length)
    }

    return { spawner, traffic, handedOff, emptyAfterFirst, peak, counts, worked }
  }

  it('fills the stacks and then waits, with nobody working the traffic', () => {
    // Arrivals hold over their fixes until they are dealt with, so a
    // sector left alone fills to the cap and stops. That is the intended
    // behaviour, not a stall: the spawner is holding releases back because
    // there is genuinely nowhere to put them.
    const { spawner, traffic } = runSector(3600)
    expect(spawner.spawned).toBe(airport.traffic.maxConcurrent)
    expect(spawner.deferred).toBeGreaterThan(0)
    expect(traffic.every((a) => a.navMode === 'HOLD')).toBe(true)
  })

  it('every one of them ends up in a hold at its own fix', () => {
    const { traffic } = runSector(3600)
    expect(traffic.length).toBeGreaterThan(4)
    for (const a of traffic) {
      expect(a.hold?.fix, a.callsign).toBe(a.originFix)
      // And parked over it rather than still routing in: the pattern is
      // about five miles across at holding speed.
      const fix = a.hold
      if (!fix) throw new Error('no hold')
      expect(distanceNM(a.pos, fix.posNM), a.callsign).toBeLessThan(8)
    }
  })

  it('keeps releasing as fast as the stacks are cleared', () => {
    // The loop that matters: hold, get dealt with, leave, be replaced.
    const { spawner, handedOff, worked } = runSector(3600, { work: true })
    expect(worked).toBeGreaterThan(20)
    expect(handedOff).toBeGreaterThan(5)
    expect(spawner.spawned).toBeGreaterThan(airport.traffic.maxConcurrent)
  })

  it('never leaves the scope empty once traffic has started', () => {
    const { emptyAfterFirst } = runSector(1800)
    expect(emptyAfterFirst).toBe(0)
  })

  it('settles at a workload once someone is working it', () => {
    const { peak, counts } = runSector(3600, { work: true })
    expect(peak).toBeLessThanOrEqual(airport.traffic.maxConcurrent)

    // Over the second half of the run it should be holding a steady few
    // aircraft, not one and not the cap.
    const later = counts.slice(Math.floor(counts.length / 2))
    const mean = later.reduce((n, c) => n + c, 0) / later.length
    expect(mean).toBeGreaterThan(2)
    expect(mean).toBeLessThan(airport.traffic.maxConcurrent)
  })

  it('gives every aircraft a trail once it has been airborne a while', () => {
    const { traffic } = runSector(1800)
    const settled = traffic.filter((a) => a.spawnedAt < 1800 - TRAIL_INTERVAL_SECONDS * 2)
    expect(settled.length).toBeGreaterThan(0)
    for (const a of settled) {
      expect(a.trail.length, a.callsign).toBeGreaterThan(0)
      expect(a.trail.length, a.callsign).toBeLessThanOrEqual(TRAIL_POINTS)
    }
  })

  it('is reproducible for a seed', () => {
    const a = runSector(600, { seed: 31 }).traffic.map(
      (x) => `${x.callsign}@${x.pos.x.toFixed(3)}`,
    )
    const b = runSector(600, { seed: 31 }).traffic.map(
      (x) => `${x.callsign}@${x.pos.x.toFixed(3)}`,
    )
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })
})

describe('departureOf', () => {
  /**
   * Why an aircraft comes off the scope, in one place.
   *
   * The area of responsibility is published controlled airspace now, so
   * this is a three-dimensional question. A square standing in for it keeps
   * the arithmetic obvious; the real shape is tested against the real data
   * in data/airport.test.ts.
   */
  const ac = (over: Partial<Aircraft>): Aircraft => ({ ...base, ...over })

  /** 40 NM square, 2,500 ft to 20,000: a TMA with no zone under it. */
  const ZONE: ControlZone = [
    {
      polygon: [
        { x: -40, y: -40 },
        { x: 40, y: -40 },
        { x: 40, y: 40 },
        { x: -40, y: 40 },
      ],
      floorFt: 2500,
      ceilingFt: 20000,
      label: 'TEST TMA',
    },
  ]

  it('keeps an aircraft that is inside it', () => {
    expect(departureOf(ac({ pos: { x: 10, y: 10 }, altFt: 8000 }), ZONE)).toBeNull()
    expect(departureOf(ac({ pos: { x: 39, y: 0 }, altFt: 8000 }), ZONE)).toBeNull()
  })

  it('reports one that has crossed the boundary', () => {
    expect(departureOf(ac({ pos: { x: 41, y: 0 }, altFt: 8000 }), ZONE)).toBe('left')
  })

  it('reports one that has descended out of it', () => {
    // The realism the shape brings with it: below the base of the airspace
    // is outside the airspace, however central the position.
    expect(departureOf(ac({ pos: { x: 0, y: 0 }, altFt: 2000 }), ZONE)).toBe('left')
    expect(departureOf(ac({ pos: { x: 0, y: 0 }, altFt: 3000 }), ZONE)).toBeNull()
  })

  it('reports one that has climbed out of the top', () => {
    expect(departureOf(ac({ pos: { x: 0, y: 0 }, altFt: 21000 }), ZONE)).toBe('left')
  })

  it('does not report one that has never been inside', () => {
    // Arrivals are released outside and fly in, so being outside means two
    // opposite things and only  separates them.
    const coming = ac({ pos: { x: 48, y: 0 }, altFt: 8000, entered: false })
    expect(departureOf(coming, ZONE)).toBeNull()
  })

  it('removes an inbound aircraft that turns away, past the outer limit', () => {
    const wandering = ac({ pos: { x: 80, y: 0 }, altFt: 8000, entered: false })
    expect(departureOf(wandering, ZONE)).toBeNull()
    expect(departureOf(wandering, ZONE, 60)).toBe('left')
  })

  it('reports a landing wherever it happens', () => {
    expect(departureOf(ac({ navMode: 'LANDED', pos: { x: 1, y: 0 } }), ZONE)).toBe('landed')
  })

  it('calls it landed rather than left when it is both', () => {
    expect(departureOf(ac({ navMode: 'LANDED', pos: { x: 99, y: 0 } }), ZONE)).toBe('landed')
  })
})

describe('enterSector', () => {
  const ZONE: ControlZone = [
    {
      polygon: [
        { x: -40, y: -40 },
        { x: 40, y: -40 },
        { x: 40, y: 40 },
        { x: -40, y: 40 },
      ],
      floorFt: 0,
      ceilingFt: 20000,
      label: 'TEST CTA',
    },
  ]
  const ac = (over: Partial<Aircraft>): Aircraft => ({ ...base, ...over })

  it('marks an arrival as owned the moment it crosses in', () => {
    const coming = ac({ pos: { x: 48, y: 0 }, entered: false })
    expect(enterSector(coming, ZONE).entered).toBe(false)
    expect(enterSector({ ...coming, pos: { x: 30, y: 0 } }, ZONE).entered).toBe(true)
  })

  it('leaves an aircraft alone once it has entered', () => {
    const inside = ac({ pos: { x: 10, y: 0 }, entered: true })
    expect(enterSector(inside, ZONE)).toBe(inside)
  })
})

describe('a session with no area of responsibility', () => {
  /**
   * The airspace rule can be switched off at logon, and the absence of a
   * boundary travels as a null zone. That keeps the rule in one place
   * rather than spreading an "if enforcing" through every caller -- so what
   * has to be true is that null behaves as no boundary everywhere.
   */
  const ac = (over: Partial<Aircraft>): Aircraft => ({ ...base, ...over })

  it('counts every aircraft as controllable', () => {
    const far = ac({ pos: { x: 500, y: 500 }, altFt: 40000 })
    expect(isInSector(far, null)).toBe(true)
  })

  it('marks an arrival as entered the moment it appears', () => {
    const coming = ac({ pos: { x: 500, y: 0 }, entered: false })
    expect(enterSector(coming, null).entered).toBe(true)
  })

  it('never reports one as having left the airspace', () => {
    const far = ac({ pos: { x: 500, y: 0 }, entered: true })
    expect(departureOf(far, null)).toBeNull()
  })

  it('still reports a landing', () => {
    expect(departureOf(ac({ navMode: 'LANDED' }), null)).toBe('landed')
  })

  it('still lets go at the outer limit, or nothing would ever leave', () => {
    // Without a boundary the outer limit is the only thing that bounds the
    // world, so it has to keep working.
    const far = ac({ pos: { x: 500, y: 0 }, entered: true })
    expect(departureOf(far, null, 100)).toBe('left')
  })
})
