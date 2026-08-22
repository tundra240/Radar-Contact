import { describe, expect, it } from 'vitest'
import { angleDelta } from '../core/geo'
import { STANDARD_RATES, autopilot, stepAltitude, stepHeading, stepSpeed } from './autopilot'
import type { Aircraft } from './types'

const base: Aircraft = {
  callsign: 'BAW123',
  type: 'A320',
  wake: 'M',
  pos: { x: 0, y: 0 },
  altFt: 9000,
  hdg: 90,
  iasKts: 220,
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

/** Repeats a step, as the loop would. */
function repeat<T>(times: number, start: T, step: (value: T) => T): T {
  let value = start
  for (let i = 0; i < times; i += 1) value = step(value)
  return value
}

describe('standard rates', () => {
  it('are the ones the specification asks for', () => {
    expect(STANDARD_RATES.turnDegPerSec).toBe(3)
    expect(STANDARD_RATES.verticalFpm).toBe(1500)
    expect(STANDARD_RATES.accelKtsPerSec).toBe(1.5)
  })
})

describe('turning', () => {
  it('turns at three degrees a second', () => {
    expect(stepHeading(0, 90, 1)).toBeCloseTo(3, 9)
    expect(stepHeading(0, 90, 10)).toBeCloseTo(30, 9)
    // Ninety degrees takes thirty seconds at standard rate.
    const after = repeat(30, 0, (h) => stepHeading(h, 90, 1))
    expect(after).toBeCloseTo(90, 6)
  })

  it('takes the short way round north', () => {
    // The classic wraparound bug: 350 to 010 is a twenty degree right turn,
    // not a three hundred and forty degree left one.
    expect(stepHeading(350, 10, 1)).toBeCloseTo(353, 9)
    const after = repeat(7, 350, (h) => stepHeading(h, 10, 1))
    expect(after).toBeCloseTo(10, 6)
  })

  it('takes the short way in the other direction too', () => {
    expect(stepHeading(10, 350, 1)).toBeCloseTo(7, 9)
    const after = repeat(7, 10, (h) => stepHeading(h, 350, 1))
    expect(after).toBeCloseTo(350, 6)
  })

  it('never overshoots the clearance', () => {
    // A step larger than the remaining turn must land exactly on it, or the
    // aircraft oscillates either side of its clearance forever.
    expect(stepHeading(88, 90, 10)).toBe(90)
    expect(stepHeading(92, 90, 10)).toBe(90)
    expect(stepHeading(90, 90, 10)).toBe(90)
  })

  it('holds its heading when no turn has been instructed', () => {
    expect(stepHeading(123, null, 10)).toBe(123)
  })

  it('resolves a reciprocal consistently rather than dithering', () => {
    const once = stepHeading(90, 270, 1)
    expect(Math.abs(angleDelta(90, once))).toBeCloseTo(3, 9)
    // And it gets there.
    const after = repeat(60, 90, (h) => stepHeading(h, 270, 1))
    expect(after).toBeCloseTo(270, 6)
  })

  it('always reports a heading in range', () => {
    for (const from of [0, 90, 180, 270, 359]) {
      for (const to of [0, 45, 200, 359]) {
        const h = stepHeading(from, to, 1)
        expect(h, `${from} -> ${to}`).toBeGreaterThanOrEqual(0)
        expect(h, `${from} -> ${to}`).toBeLessThan(360)
      }
    }
  })

  it('does nothing on a zero or negative step', () => {
    expect(stepHeading(90, 270, 0)).toBe(90)
    expect(stepHeading(90, 270, -5)).toBe(90)
  })
})

describe('climbing and descending', () => {
  it('moves at fifteen hundred feet a minute', () => {
    // Twenty-five feet a second, so a thousand feet takes forty seconds.
    expect(stepAltitude(9000, 5000, 1).altFt).toBeCloseTo(8975, 9)
    const after = repeat(40, 9000, (alt) => stepAltitude(alt, 8000, 1).altFt)
    expect(after).toBeCloseTo(8000, 6)
  })

  it('climbs as well as descends', () => {
    expect(stepAltitude(5000, 9000, 1).altFt).toBeCloseTo(5025, 9)
    expect(stepAltitude(5000, 9000, 1).vsFpm).toBeCloseTo(1500, 6)
    expect(stepAltitude(9000, 5000, 1).vsFpm).toBeCloseTo(-1500, 6)
  })

  it('never overshoots the cleared level', () => {
    expect(stepAltitude(9000, 8990, 60).altFt).toBe(8990)
    expect(stepAltitude(8990, 9000, 60).altFt).toBe(9000)
  })

  it('reports the rate it actually achieved, not the nominal one', () => {
    // On the last step before levelling off there is less than a full step
    // left, and once level there is none. The trend arrow reads this, so a
    // levelled aircraft must stop showing one.
    const nearlyThere = stepAltitude(8995, 9000, 1)
    expect(nearlyThere.altFt).toBe(9000)
    expect(nearlyThere.vsFpm).toBeCloseTo(300, 6)

    const level = stepAltitude(9000, 9000, 1)
    expect(level.vsFpm).toBe(0)
  })

  it('does nothing on a zero step', () => {
    const held = stepAltitude(9000, 5000, 0)
    expect(held.altFt).toBe(9000)
    expect(held.vsFpm).toBe(0)
  })
})

describe('speed', () => {
  it('changes at one and a half knots a second', () => {
    expect(stepSpeed(220, 160, 1)).toBeCloseTo(218.5, 9)
    expect(stepSpeed(160, 220, 1)).toBeCloseTo(161.5, 9)
    // Sixty knots takes forty seconds.
    const after = repeat(40, 220, (s) => stepSpeed(s, 160, 1))
    expect(after).toBeCloseTo(160, 6)
  })

  it('never overshoots', () => {
    expect(stepSpeed(220, 219, 10)).toBe(219)
    expect(stepSpeed(219, 220, 10)).toBe(220)
    expect(stepSpeed(220, 220, 10)).toBe(220)
  })

  it('does nothing on a zero step', () => {
    expect(stepSpeed(220, 160, 0)).toBe(220)
  })
})

describe('autopilot', () => {
  it('flies all three at once', () => {
    const a: Aircraft = {
      ...base,
      hdg: 90,
      clearedHdg: 180,
      altFt: 9000,
      clearedAltFt: 6000,
      iasKts: 250,
      gsKts: 250,
      clearedSpdKts: 200,
    }
    const next = autopilot(a, 1)
    expect(next.hdg).toBeCloseTo(93, 9)
    expect(next.altFt).toBeCloseTo(8975, 9)
    expect(next.vsFpm).toBeCloseTo(-1500, 6)
    expect(next.iasKts).toBeCloseTo(248.5, 9)
  })

  it('leaves an aircraft that has nothing to do alone', () => {
    const next = autopilot(base, 1)
    expect(next.hdg).toBe(base.hdg)
    expect(next.altFt).toBe(base.altFt)
    expect(next.iasKts).toBe(base.iasKts)
    expect(next.vsFpm).toBe(0)
  })

  it('honours a non-standard rate', () => {
    const fast = { turnDegPerSec: 6, verticalFpm: 3000, accelKtsPerSec: 3 }
    const a: Aircraft = { ...base, clearedHdg: 180, clearedAltFt: 6000, clearedSpdKts: 200 }
    const next = autopilot(a, 1, fast)
    expect(next.hdg).toBeCloseTo(96, 9)
    expect(next.altFt).toBeCloseTo(8950, 9)
    expect(next.iasKts).toBeCloseTo(217, 9)
  })

  it('reaches every clearance eventually and then stays put', () => {
    let a: Aircraft = {
      ...base,
      clearedHdg: 300,
      clearedAltFt: 4000,
      clearedSpdKts: 180,
    }
    // Comfortably past arrival: stopping on the exact tick that levels off
    // would still report that step's rate.
    for (let i = 0; i < 5000; i += 1) {
      const next = autopilot(a, 0.05)
      a = { ...a, ...next }
    }
    expect(a.hdg).toBeCloseTo(300, 6)
    expect(a.altFt).toBeCloseTo(4000, 6)
    expect(a.iasKts).toBeCloseTo(180, 6)
    expect(a.vsFpm).toBe(0)
  })
})
