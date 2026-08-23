import { describe, expect, it } from 'vitest'
import { conflictsIn, inConflict, isConflict, SEPARATION_FT, SEPARATION_NM } from './conflict'
import type { Aircraft } from './types'

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW1',
    type: 'A320',
    wake: 'M',
    role: 'arrival',
    pos: { x: 0, y: 0 },
    altFt: 7000,
    hdg: 90,
    iasKts: 220,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 7000,
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

describe('the minima', () => {
  it('are three miles and a thousand feet', () => {
    expect(SEPARATION_NM).toBe(3)
    expect(SEPARATION_FT).toBe(1000)
  })
})

describe('whether a pair is too close', () => {
  it('needs both minima broken at once', () => {
    // The rule that matters. Two aircraft a mile apart on the plan view are
    // perfectly separated if one is a thousand feet above the other, and a
    // check that looked only sideways would call every holding stack a
    // breach.
    const low = ac({ callsign: 'A', altFt: 7000 })
    const high = ac({ callsign: 'B', altFt: 8000, pos: { x: 1, y: 0 } })
    expect(isConflict(low, high)).toBe(false)
  })

  it('is a breach when they are close in both', () => {
    const a = ac({ callsign: 'A', altFt: 7000 })
    const b = ac({ callsign: 'B', altFt: 7400, pos: { x: 2, y: 0 } })
    expect(isConflict(a, b)).toBe(true)
  })

  it('treats exactly a thousand feet as separated', () => {
    // A stack is built in thousand-foot layers, so this is the normal and
    // correct state of two aircraft over one fix rather than a near miss.
    const a = ac({ callsign: 'A', altFt: 7000 })
    const b = ac({ callsign: 'B', altFt: 8000, pos: { x: 0, y: 0 } })
    expect(isConflict(a, b)).toBe(false)
  })

  it('treats exactly three miles as separated', () => {
    const a = ac({ callsign: 'A' })
    const b = ac({ callsign: 'B', pos: { x: 3, y: 0 } })
    expect(isConflict(a, b)).toBe(false)
  })

  it('ignores anything that has landed', () => {
    // On the ground it is not traffic, and two aeroplanes on a runway would
    // otherwise read as the worst breach on the display.
    const down = ac({ callsign: 'A', navMode: 'LANDED', altFt: 83 })
    const over = ac({ callsign: 'B', altFt: 200, pos: { x: 0.2, y: 0 } })
    expect(isConflict(down, over)).toBe(false)
  })

  it('ignores anything that is not the controller’s yet', () => {
    // Traffic outside the area of responsibility can be seen and not
    // touched, so it cannot be a breach the controller caused.
    const outside = ac({ callsign: 'A', entered: false })
    const inside = ac({ callsign: 'B', pos: { x: 1, y: 0 } })
    expect(isConflict(outside, inside)).toBe(false)
  })

  it('still counts a pair on the approach', () => {
    // Deliberately no exclusion for being on a beam: the whole point of
    // sequencing is that the gap survives to the threshold.
    const lead = ac({ callsign: 'A', navMode: 'GS_TRACKING', altFt: 2000 })
    const follow = ac({
      callsign: 'B',
      navMode: 'GS_TRACKING',
      altFt: 2200,
      pos: { x: 2, y: 0 },
    })
    expect(isConflict(lead, follow)).toBe(true)
  })
})

describe('scanning the whole picture', () => {
  it('reports a pair once rather than from each end', () => {
    const found = conflictsIn([
      ac({ callsign: 'BAW1' }),
      ac({ callsign: 'BAW2', pos: { x: 1, y: 0 } }),
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.a).toBe('BAW1')
    expect(found[0]?.b).toBe('BAW2')
  })

  it('names the pair the same way whatever order the traffic is in', () => {
    const one = conflictsIn([
      ac({ callsign: 'ZZZ9' }),
      ac({ callsign: 'AAA1', pos: { x: 1, y: 0 } }),
    ])
    const other = conflictsIn([
      ac({ callsign: 'AAA1', pos: { x: 1, y: 0 } }),
      ac({ callsign: 'ZZZ9' }),
    ])
    expect(one[0]?.a).toBe('AAA1')
    expect(other[0]?.a).toBe('AAA1')
  })

  it('carries how bad it is, not only that it happened', () => {
    const found = conflictsIn([
      ac({ callsign: 'A', altFt: 7000 }),
      ac({ callsign: 'B', altFt: 7300, pos: { x: 1.5, y: 0 } }),
    ])
    expect(found[0]?.distanceNM).toBeCloseTo(1.5, 6)
    expect(found[0]?.verticalFt).toBe(300)
  })

  it('finds nothing in a legal holding stack', () => {
    // Four over one fix, a thousand feet apart. The situation the sector is
    // designed around, and it must never read as three breaches.
    const stack = [7000, 8000, 9000, 10000].map((altFt, i) =>
      ac({ callsign: `BAW${i}`, altFt, pos: { x: 12, y: -9 } }),
    )
    expect(conflictsIn(stack)).toEqual([])
  })

  it('lists everyone involved, for marking them', () => {
    const who = inConflict([
      ac({ callsign: 'A' }),
      ac({ callsign: 'B', pos: { x: 1, y: 0 } }),
      ac({ callsign: 'C', pos: { x: 40, y: 40 } }),
    ])
    expect([...who].sort()).toEqual(['A', 'B'])
  })

  it('finds nothing in an empty sector', () => {
    expect(conflictsIn([])).toEqual([])
    expect(conflictsIn([ac()])).toEqual([])
  })
})
