import { describe, expect, it } from 'vitest'
import { buildSequence, isTight, sequenceOrder } from './sequence'
import { RADAR_MINIMUM_NM, isWakePair, requiredGapNM } from './separation'
import type { Aircraft } from './types'

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW178',
    type: 'A320',
    wake: 'M',
    pos: { x: 10, y: 0 },
    altFt: 7000,
    hdg: 270,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 270,
    clearedAltFt: 7000,
    clearedSpdKts: 220,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    originFix: 'LAM',
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    ...over,
  }
}

describe('requiredGapNM', () => {
  it('falls back to the radar minimum where there is no wake requirement', () => {
    expect(requiredGapNM('M', 'M')).toBe(RADAR_MINIMUM_NM)
    expect(requiredGapNM('M', 'H')).toBe(RADAR_MINIMUM_NM)
    expect(requiredGapNM('H', 'J')).toBe(RADAR_MINIMUM_NM)
  })

  it('opens the gap up behind a heavy', () => {
    expect(requiredGapNM('H', 'H')).toBe(4)
    expect(requiredGapNM('H', 'M')).toBe(5)
    expect(requiredGapNM('H', 'L')).toBe(6)
  })

  it('opens it further behind a super', () => {
    expect(requiredGapNM('J', 'H')).toBe(6)
    expect(requiredGapNM('J', 'M')).toBe(7)
    expect(requiredGapNM('J', 'L')).toBe(8)
  })

  it('protects a light behind a medium', () => {
    expect(requiredGapNM('M', 'L')).toBe(5)
  })

  it('never returns less than the radar minimum, for any pair', () => {
    const cats = ['J', 'H', 'M', 'L'] as const
    for (const leader of cats) {
      for (const follower of cats) {
        expect(requiredGapNM(leader, follower), `${leader}->${follower}`)
          .toBeGreaterThanOrEqual(RADAR_MINIMUM_NM)
      }
    }
  })

  it('knows which pairs are wake pairs and which are just radar', () => {
    expect(isWakePair('H', 'M')).toBe(true)
    expect(isWakePair('J', 'H')).toBe(true)
    expect(isWakePair('M', 'M')).toBe(false)
    expect(isWakePair('M', 'H')).toBe(false)
  })
})

describe('buildSequence', () => {
  it('copes with nothing at all', () => {
    const built = buildSequence([])
    expect(built.sequence).toEqual([])
    expect(built.stack).toEqual([])
    expect(sequenceOrder(built)).toEqual([])
  })

  it('orders by distance to the field and numbers from one', () => {
    const built = buildSequence([
      ac({ callsign: 'FAR', pos: { x: 20, y: 0 } }),
      ac({ callsign: 'NEAR', pos: { x: 5, y: 0 } }),
      ac({ callsign: 'MID', pos: { x: 12, y: 0 } }),
    ])
    expect(built.sequence.map((f) => f.aircraft.callsign)).toEqual(['NEAR', 'MID', 'FAR'])
    expect(built.sequence.map((f) => f.position)).toEqual([1, 2, 3])
    expect(built.sequence[0]?.toFieldNM).toBeCloseTo(5, 6)
  })

  it('gives the aircraft in front no gap to report', () => {
    const built = buildSequence([ac({ pos: { x: 5, y: 0 } })])
    expect(built.sequence[0]?.gapNM).toBe(null)
    expect(built.sequence[0]?.requiredNM).toBe(null)
    expect(isTight(built.sequence[0]!)).toBe(false)
  })

  it('measures the gap as distance to run, not as the range between them', () => {
    // The point of the whole thing. These two are twenty miles apart, on
    // opposite sides of the field, and both ten miles out -- so they are
    // heading for the same slot and the gap is nothing.
    const built = buildSequence([
      ac({ callsign: 'EAST', pos: { x: 10, y: 0 } }),
      ac({ callsign: 'WEST', pos: { x: -10, y: 0 } }),
    ])
    expect(built.sequence[1]?.gapNM).toBeCloseTo(0, 6)
    expect(isTight(built.sequence[1]!)).toBe(true)
  })

  it('takes the requirement from the pair, in sequence order', () => {
    const built = buildSequence([
      ac({ callsign: 'LEADER', wake: 'H', pos: { x: 6, y: 0 } }),
      ac({ callsign: 'FOLLOWER', wake: 'M', pos: { x: 12, y: 0 } }),
    ])
    expect(built.sequence[1]?.requiredNM).toBe(5)
    expect(built.sequence[1]?.gapNM).toBeCloseTo(6, 6)
    expect(isTight(built.sequence[1]!)).toBe(false)
  })

  it('flags a gap that is legal for one pair and not for another', () => {
    const at = (wake: Aircraft['wake'], x: number, callsign: string): Aircraft =>
      ac({ callsign, wake, pos: { x, y: 0 } })

    // Four miles: fine behind a medium, tight behind a heavy.
    const behindMedium = buildSequence([at('M', 6, 'A'), at('M', 10, 'B')])
    expect(isTight(behindMedium.sequence[1]!)).toBe(false)

    const behindHeavy = buildSequence([at('H', 6, 'A'), at('M', 10, 'B')])
    expect(isTight(behindHeavy.sequence[1]!)).toBe(true)
  })

  it('keeps holding traffic out of the sequence entirely', () => {
    const built = buildSequence([
      ac({ callsign: 'HELD', navMode: 'HOLD', pos: { x: 2, y: 0 } }),
      ac({ callsign: 'WORKED', pos: { x: 30, y: 0 } }),
    ])
    expect(built.sequence.map((f) => f.aircraft.callsign)).toEqual(['WORKED'])
    expect(built.stack.map((f) => f.aircraft.callsign)).toEqual(['HELD'])
    // A parked aircraft must not consume a sequence gap.
    expect(built.sequence[0]?.gapNM).toBe(null)
  })

  it('stacks lowest first, because that is what leaves the hold next', () => {
    const built = buildSequence([
      ac({ callsign: 'TOP', navMode: 'HOLD', altFt: 11000 }),
      ac({ callsign: 'BOTTOM', navMode: 'HOLD', altFt: 7000 }),
      ac({ callsign: 'MIDDLE', navMode: 'HOLD', altFt: 9000 }),
    ])
    expect(built.stack.map((f) => f.aircraft.callsign)).toEqual(['BOTTOM', 'MIDDLE', 'TOP'])
  })

  it('breaks a tie on callsign, so the order cannot flicker', () => {
    // Two aircraft the same distance out would otherwise swap places
    // between refreshes depending on the input order.
    const one = buildSequence([ac({ callsign: 'ZZZ9' }), ac({ callsign: 'AAA1' })])
    const other = buildSequence([ac({ callsign: 'AAA1' }), ac({ callsign: 'ZZZ9' })])
    expect(sequenceOrder(one).map((a) => a.callsign)).toEqual(['AAA1', 'ZZZ9'])
    expect(sequenceOrder(other).map((a) => a.callsign)).toEqual(['AAA1', 'ZZZ9'])
  })

  it('lists the sequence first and the stack after it', () => {
    const built = buildSequence([
      ac({ callsign: 'HELD', navMode: 'HOLD', pos: { x: 1, y: 0 } }),
      ac({ callsign: 'WORKED', pos: { x: 40, y: 0 } }),
    ])
    expect(sequenceOrder(built).map((a) => a.callsign)).toEqual(['WORKED', 'HELD'])
  })
})
