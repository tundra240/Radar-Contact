import { describe, expect, it } from 'vitest'
import { TICK_MS } from '../core/loop'
import { advance, angleDelta, distanceNM } from '../core/geo'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { stepAircraft } from './aircraft'
import { alongTrackNM, holdLeg, holdLegNM, holdSteer, leadHeading } from './hold'
import { statusText, type Aircraft, type HoldClearance } from './types'

/**
 * The holding pattern.
 *
 * The unit tests below pin the geometry, but the one that says whether this
 * works is `flying the pattern`: twenty minutes of the real flight model,
 * asserting the aircraft goes round and round the fix and does not wander
 * off. That is the whole point of a hold.
 */

/** LAM, near enough: north-east of the field, inbound to the south-west. */
const LAM: HoldClearance = {
  fix: 'LAM',
  posNM: { x: 13, y: 9 },
  inboundTrue: 249,
  turns: 'right',
  legMins: 1,
}

const LEFT: HoldClearance = { ...LAM, fix: 'OCK', turns: 'left' }

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW178',
    type: 'A320',
    wake: 'M',
    pos: LAM.posNM,
    altFt: 8000,
    hdg: LAM.inboundTrue,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: null,
    clearedAltFt: 8000,
    clearedSpdKts: 220,
    navMode: 'HOLD',
    clearedApproach: null,
    hold: LAM,
    originFix: 'LAM',
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    ...over,
  }
}

const DT = TICK_MS / 1000

/** Flies the aircraft through the real model and reports what it did. */
function fly(start: Aircraft, minutes: number, pattern = LAM) {
  let a = start
  let turned = 0
  let furthest = 0
  const passes: number[] = []
  let wasNear = false

  const steps = Math.round((minutes * 60) / DT)
  for (let i = 0; i < steps; i += 1) {
    const before = a.hdg
    a = stepAircraft(a, DT, i * DT)
    turned += angleDelta(before, a.hdg)

    const away = distanceNM(a.pos, pattern.posNM)
    furthest = Math.max(furthest, away)
    const near = away < 1
    if (near && !wasNear) passes.push(i * DT)
    wasNear = near
  }
  return { a, turned, furthest, passes }
}

describe('leadHeading', () => {
  it('goes straight to a target that is already the short way round', () => {
    expect(leadHeading(90, 120, 'right')).toBe(120)
    expect(leadHeading(90, 60, 'left')).toBe(60)
  })

  it('never turns a reversal the wrong way', () => {
    // A 180 degree turn has no short way, so the autopilot would pick one
    // arbitrarily. Leading it a quarter-turn round settles it.
    expect(leadHeading(90, 270, 'right')).toBe(180)
    expect(leadHeading(90, 270, 'left')).toBe(0)
  })

  it('takes the long way round when the pattern says so', () => {
    // Thirty degrees to the left, but this is a right-hand pattern, so the
    // aeroplane goes the 330 degrees the other way.
    expect(leadHeading(90, 60, 'right')).toBe(180)
    expect(leadHeading(90, 120, 'left')).toBe(0)
  })

  it('leaves a heading alone when it is already the target', () => {
    // The subtraction underneath this wraps to 360 rather than 0 for a
    // left-hand pattern, which would command a 90 degree turn off a
    // perfectly good heading.
    expect(leadHeading(90, 90, 'right')).toBe(90)
    expect(leadHeading(90, 90, 'left')).toBe(90)
  })
})

describe('alongTrackNM', () => {
  it('is negative on the side the pattern lies, and positive past the fix', () => {
    // Inbound is 249, so the aircraft approaches from 069.
    const before = advance(LAM.posNM, 69, 4)
    const after = advance(LAM.posNM, 249, 4)
    expect(alongTrackNM(before, LAM)).toBeCloseTo(-4, 3)
    expect(alongTrackNM(after, LAM)).toBeCloseTo(4, 3)
  })

  it('is zero at the fix and abeam it', () => {
    expect(alongTrackNM(LAM.posNM, LAM)).toBe(0)
    expect(alongTrackNM(advance(LAM.posNM, 249 + 90, 3), LAM)).toBeCloseTo(0, 6)
  })
})

describe('holdLegNM', () => {
  it('is a minute of flying, so a slower aircraft flies a smaller pattern', () => {
    expect(holdLegNM(LAM, 220)).toBeCloseTo(3.667, 3)
    expect(holdLegNM(LAM, 180)).toBeCloseTo(3, 3)
  })

  it('never collapses to nothing for an aircraft that has stopped', () => {
    expect(holdLegNM(LAM, 0)).toBeGreaterThan(0)
  })
})

describe('holdLeg', () => {
  it('reads the leg off the aircraft rather than remembering it', () => {
    const inbound = ac({ pos: advance(LAM.posNM, 69, 3), hdg: 249 })
    expect(holdLeg(inbound, LAM)).toBe('inbound')

    // Same heading, but the fix is behind: time to turn.
    const past = ac({ pos: advance(LAM.posNM, 249, 0.5), hdg: 249 })
    expect(holdLeg(past, LAM)).toBe('turningOutbound')

    // Pointing back up the track, still inside a leg's run.
    const outbound = ac({ pos: advance(LAM.posNM, 69, 2), hdg: 69 })
    expect(holdLeg(outbound, LAM)).toBe('outbound')

    // A full leg run off the fix: turn back.
    const end = ac({ pos: advance(LAM.posNM, 69, 5), hdg: 69 })
    expect(holdLeg(end, LAM)).toBe('turningInbound')
  })

  it('shortens the outbound leg for a slower aircraft', () => {
    const at = advance(LAM.posNM, 69, 3.2)
    expect(holdLeg(ac({ pos: at, hdg: 69, gsKts: 220 }), LAM)).toBe('outbound')
    // 180 kt makes the leg 3 NM, so the same spot is now the far end.
    expect(holdLeg(ac({ pos: at, hdg: 69, gsKts: 180 }), LAM)).toBe('turningInbound')
  })
})

describe('holdSteer', () => {
  it('says nothing about an aircraft that is not holding', () => {
    expect(holdSteer(ac({ navMode: 'VECTOR' }))).toBe(null)
    expect(holdSteer(ac({ hold: null }))).toBe(null)
  })

  it('steers at the fix on the inbound leg', () => {
    // Cutting in at the fix rather than tracking the inbound leg exactly is
    // deliberate: coming off the far turn the aircraft is offset.
    const a = ac({ pos: advance(LAM.posNM, 69, 4), hdg: 240 })
    expect(holdSteer(a)).toBeCloseTo(249, 0)
  })

  it('reverses the published way round at the fix', () => {
    const a = ac({ pos: advance(LAM.posNM, 249, 0.2), hdg: 249 })
    // Right-hand pattern: led round to the right, not the left.
    expect(holdSteer(a)).toBeCloseTo(339, 0)
    expect(holdSteer({ ...a, hold: LEFT })).toBeCloseTo(159, 0)
  })
})

describe('flying the pattern', () => {
  it('goes round and round the fix, the published way, on time', () => {
    const r = fly(ac(), 20)

    // Five complete right-hand circuits in twenty minutes. A left turn
    // anywhere would eat into this, and a pattern that unwound would not
    // reach it at all.
    expect(r.turned).toBeGreaterThan(1750)
    expect(r.turned).toBeLessThan(1850)

    // A minute inbound, a minute round, a minute outbound, a minute round.
    // The first circuit is short, because this aircraft starts on the fix
    // rather than at the beginning of an inbound leg.
    const gaps = r.passes.slice(1).map((t, i) => t - (r.passes[i] as number))
    expect(gaps.length).toBeGreaterThanOrEqual(4)
    for (const gap of gaps.slice(1)) expect(gap).toBeCloseTo(240, 0)
    expect(gaps[0] as number).toBeLessThanOrEqual(240)

    // And it stays in the pattern: a 3.7 NM leg plus the turn either end.
    expect(r.furthest).toBeLessThan(6)
    expect(r.a.navMode).toBe('HOLD')
  })

  it('turns the other way for a left-hand pattern', () => {
    const r = fly(ac({ hold: LEFT }), 20, LEFT)
    expect(r.turned).toBeLessThan(-1750)
    expect(r.furthest).toBeLessThan(6)
  })

  it('never drifts away, however long it is left there', () => {
    // The failure this guards against is a pattern that creeps: a small
    // error each circuit is invisible over one and a sector exit over ten.
    const r = fly(ac(), 90)
    expect(r.furthest).toBeLessThan(6)
    expect(distanceNM(r.a.pos, LAM.posNM)).toBeLessThan(6)
  })

  it('joins from anywhere, with no entry procedure to choose', () => {
    // Being told to hold from twenty miles out on any heading has to work,
    // because that is how the instruction is actually given.
    for (const hdg of [0, 90, 180, 270]) {
      for (const from of [30, 150, 250]) {
        const start = ac({ pos: advance(LAM.posNM, from, 20), hdg })
        const r = fly(start, 25)
        const away = distanceNM(r.a.pos, LAM.posNM)
        expect(away, `from ${from} heading ${hdg}`).toBeLessThan(6)
        // And it is circling by the end, not just passing through.
        expect(Math.abs(r.turned), `from ${from} heading ${hdg}`).toBeGreaterThan(1000)
      }
    }
  })

  it('still takes a descent while it is holding', () => {
    // Stacking traffic down in the hold is most of what a hold is for.
    const r = fly(ac({ altFt: 12000, clearedAltFt: 7000 }), 10)
    expect(r.a.altFt).toBe(7000)
    expect(r.a.navMode).toBe('HOLD')
    expect(r.furthest).toBeLessThan(7)
  })

  it('flies a smaller pattern when it is slowed down', () => {
    const fast = fly(ac({ gsKts: 250, clearedSpdKts: 250 }), 20)
    const slow = fly(ac({ gsKts: 180, clearedSpdKts: 180 }), 20)
    expect(slow.furthest).toBeLessThan(fast.furthest)
  })

  it('leaves the hold the moment it is vectored', () => {
    // navMode is what decides, not the leftover pattern -- so an aircraft
    // taken out of the hold flies the vector even if the clearance is
    // still on the record.
    const vectored = ac({ navMode: 'VECTOR', clearedHdg: 69 })
    const r = fly(vectored, 10)
    expect(r.a.hdg).toBeCloseTo(69, 0)
    expect(distanceNM(r.a.pos, LAM.posNM)).toBeGreaterThan(30)
  })
})

describe('the published EGLL holds', () => {
  /**
   * Against the real config rather than the approximation above, because
   * the inbound legs are derived from the geometry and a data change could
   * quietly produce a hold that cannot be flown.
   */
  const airport = loadAirport(raw)

  it('flies all four, from wherever the aircraft happens to be', () => {
    const fixes = airport.navaids.filter((n) => n.hold !== null)
    expect(fixes).toHaveLength(4)

    for (const navaid of fixes) {
      const pattern = navaid.hold
      if (pattern === null) throw new Error('filtered above')
      const clearance: HoldClearance = {
        fix: navaid.name,
        posNM: navaid.posNM,
        inboundTrue: pattern.inboundTrue,
        turns: pattern.turns,
        legMins: pattern.legMins,
      }

      // Start well outside the pattern, on a heading that has nothing to do
      // with it -- which is how the instruction actually arrives.
      const start = ac({
        pos: advance(navaid.posNM, 100, 22),
        hdg: 20,
        hold: clearance,
        originFix: navaid.name,
      })

      // Half an hour to get established, then measure only what it does
      // after that. Anything measured earlier is the transit, not the hold.
      const settling = fly(start, 30, clearance)
      const settled = fly(settling.a, 15, clearance)

      expect(settled.furthest, navaid.name).toBeLessThan(8)
      // Roughly a circuit every four minutes, and all of them the same way.
      expect(Math.abs(settled.turned), navaid.name).toBeGreaterThan(1100)
      expect(Math.sign(settled.turned), navaid.name).toBe(pattern.turns === 'right' ? 1 : -1)
      expect(statusText(settled.a)).toBe(`HOLDING ${navaid.name}`)
    }
  })
})
