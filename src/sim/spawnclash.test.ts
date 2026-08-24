import { describe, expect, it } from 'vitest'

import { advance, distanceNM, type Vec2NM } from '../core/geo'
import { airportOf } from '../data/airports'
import type { Clock } from '../core/loop'
import { DIFFICULTIES } from './difficulty'
import { FlightGenerator } from './flightgen'
import { Overflights } from './overflight'
import { Spawner } from './spawner'
import type { Aircraft } from './types'

/**
 * Two aeroplanes released in the same second, in the same place.
 *
 * Pressing the release key repeatedly is a dev shortcut and it is meant to
 * skip the cadence -- that is the whole point of it. What it is not meant
 * to do is skip the check that there is somewhere to put the aeroplane,
 * because two targets drawn on one blip is not a hard exercise, it is a
 * broken display: the second one is invisible until it moves, and by the
 * time it has moved it is already in conflict with the first.
 */
const nice = airportOf('LFMN')

/** A stopped clock: every press lands in the same second, which is the point. */
const clockAt = (seconds: number): Clock => ({
  ticks: Math.round(seconds * 20),
  elapsedSeconds: seconds,
  timeOfDaySeconds: (12 * 3600 + seconds) % 86400,
})

/** The smallest gap between any two aircraft on the display. */
function closest(traffic: readonly Aircraft[]): { nm: number; ft: number; who: string } {
  let worst = { nm: Infinity, ft: Infinity, who: '' }
  for (let i = 0; i < traffic.length; i += 1) {
    for (let j = i + 1; j < traffic.length; j += 1) {
      const a = traffic[i]!
      const b = traffic[j]!
      const nm = distanceNM(a.pos, b.pos)
      if (nm < worst.nm) {
        worst = { nm, ft: Math.abs(a.altFt - b.altFt), who: `${a.callsign} and ${b.callsign}` }
      }
    }
  }
  return worst
}

describe('releasing traffic on command', () => {
  it('never puts two transits on one blip', () => {
    // The transit key, pressed as fast as it can be pressed. Every release
    // has to land somewhere a controller can see it as a separate target.
    const clock = clockAt(0)
    const overflights = new Overflights({
      airport: nice,
      difficulty: DIFFICULTIES.pro,
      flights: new FlightGenerator(nice),
      seed: 4242,
    })

    let traffic: Aircraft[] = []
    for (let i = 0; i < 12; i += 1) {
      traffic = [...traffic, ...overflights.spawnNow(clock, traffic)]
    }

    // Two is enough to prove it: there are only so many corridors, and
    // once each has somebody sitting on its entry point the generator is
    // right to decline rather than to stack them up.
    expect(traffic.length, 'nothing was released at all').toBeGreaterThan(1)
    const worst = closest(traffic)
    expect(
      worst.nm,
      `${worst.who} are ${worst.nm.toFixed(2)} nm and ${worst.ft} ft apart at release`,
    ).toBeGreaterThan(1)
  })

  it('never puts two arrivals on one blip', () => {
    const clock = clockAt(0)
    const spawner = new Spawner({ airport: nice, seed: 4242 })

    let traffic: Aircraft[] = []
    for (let i = 0; i < 12; i += 1) {
      traffic = [...traffic, ...spawner.spawnNow(clock, traffic)]
    }

    expect(traffic.length, 'nothing was released at all').toBeGreaterThan(2)
    const worst = closest(traffic)
    expect(
      worst.nm,
      `${worst.who} are ${worst.nm.toFixed(2)} nm and ${worst.ft} ft apart at release`,
    ).toBeGreaterThan(1)
  })

  it('still fills the sector once the traffic starts moving', () => {
    // The other half of the bargain. Refusing a release because the gate
    // is occupied is right while the gate IS occupied, and wrong if it
    // stays refused after the aeroplane has gone -- an arrival clears its
    // gate in well under a minute, and a rule that throttled the feed for
    // longer than that would have turned a display bug into a gameplay one.
    //
    // Only the gate rule is under test here, so the concurrency cap is kept
    // out of it: each release is dropped once it has flown clear of where
    // it appeared, which is the moment the gate is free again.
    const spawner = new Spawner({ airport: nice, seed: 99 })
    let traffic: (Aircraft & { bornAt: Vec2NM })[] = []
    let released = 0

    for (let second = 0; second < 600; second += 1) {
      // Pressed once a second, for ten minutes.
      const born = spawner.spawnNow(clockAt(second), traffic)
      released += born.length
      traffic = [...traffic, ...born.map((a) => ({ ...a, bornAt: a.pos }))]
        .map((a) => ({ ...a, pos: advance(a.pos, a.hdg, a.gsKts / 3600) }))
        .filter((a) => distanceNM(a.pos, a.bornAt) < 8)
    }

    // What the rule should cost, worked out rather than guessed: three
    // gates at Nice, and about sixty-five seconds for an arrival at 220
    // knots to put four miles between itself and the point it appeared on.
    // Ten minutes of that is a shade under thirty releases, so anything
    // above twenty is the geometry rather than a throttle -- and the old
    // behaviour, for comparison, would have released six hundred, every
    // one of them on somebody else.
    expect(released, 'the gate rule is throttling the feed').toBeGreaterThan(20)
  })

  it('never puts a transit on top of an arrival', () => {
    const clock = clockAt(0)
    const spawner = new Spawner({ airport: nice, seed: 77 })
    const overflights = new Overflights({
      airport: nice,
      difficulty: DIFFICULTIES.pro,
      flights: new FlightGenerator(nice),
      seed: 77,
    })

    let traffic: Aircraft[] = []
    for (let i = 0; i < 8; i += 1) {
      traffic = [...traffic, ...spawner.spawnNow(clock, traffic)]
      traffic = [...traffic, ...overflights.spawnNow(clock, traffic)]
    }

    const worst = closest(traffic)
    expect(
      worst.nm,
      `${worst.who} are ${worst.nm.toFixed(2)} nm and ${worst.ft} ft apart at release`,
    ).toBeGreaterThan(1)
  })
})
