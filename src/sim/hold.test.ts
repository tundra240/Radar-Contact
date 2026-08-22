import { describe, expect, it } from 'vitest'
import { TICK_MS } from '../core/loop'
import { advance, angleDelta, distanceNM } from '../core/geo'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { stepAircraft } from './aircraft'
import { Spawner } from './spawner'
import { isControlled, isWithinFootprint } from './airspace'
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
    iasKts: 220,
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
    expect(holdLeg(ac({ pos: at, hdg: 69, iasKts: 220, gsKts: 220 }), LAM)).toBe('outbound')
    // 180 kt makes the leg 3 NM, so the same spot is now the far end.
    expect(holdLeg(ac({ pos: at, hdg: 69, iasKts: 180, gsKts: 180 }), LAM)).toBe('turningInbound')
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
    const fast = fly(ac({ iasKts: 250, gsKts: 250, clearedSpdKts: 250 }), 20)
    const slow = fly(ac({ iasKts: 180, gsKts: 180, clearedSpdKts: 180 }), 20)
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

describe('holding inside the real airspace', () => {
  /**
   * The regression behind the hold refit in the loader.
   *
   * Bovingdon sits under two miles inside the edge of the London TMA, and a
   * hold derived to point at the field laid its racetrack radially outward:
   * 54% of every circuit outside controlled airspace, and every aircraft
   * sent there lost for nothing. The nominal check lives in
   * data/airport.test.ts; this one flies the pattern and asks the airspace.
   */
  const airport = loadAirport(raw)

  it('keeps every published hold inside controlled airspace, all the way round', () => {
    const fixes = airport.navaids.filter((n) => n.hold !== null && n.entry !== null)
    expect(fixes).toHaveLength(4)

    for (const navaid of fixes) {
      const pattern = navaid.hold
      const band = navaid.entry
      if (pattern === null || band === null) throw new Error('filtered above')
      const clearance: HoldClearance = {
        fix: navaid.name,
        posNM: navaid.posNM,
        inboundTrue: pattern.inboundTrue,
        turns: pattern.turns,
        legMins: pattern.legMins,
      }

      // At the top of the stack and at holding speed, which is the widest
      // the pattern ever gets.
      let a = ac({
        pos: navaid.posNM,
        hdg: pattern.inboundTrue,
        altFt: band.maxAltFt,
        clearedAltFt: band.maxAltFt,
        iasKts: 240,
        gsKts: 240,
        clearedSpdKts: 240,
        hold: clearance,
        originFix: navaid.name,
      })

      let outside = 0
      const steps = Math.round((12 * 60) / DT)
      for (let i = 0; i < steps; i += 1) {
        a = stepAircraft(a, DT, i * DT)
        if (!isControlled(airport.controlZone, a.pos, a.altFt)) outside += 1
      }
      expect(outside, `${navaid.name} left controlled airspace`).toBe(0)
    }
  })
})

describe('joining a pattern from outside it', () => {
  /**
   * BNN, near enough: the one Heathrow hold whose inbound leg is turned to
   * fit the airspace rather than pointed at the field, so an arrival comes
   * down a radial that crosses the pattern at ninety degrees.
   */
  const BNN: HoldClearance = {
    fix: 'BNN',
    posNM: { x: -3.35, y: 15.32 },
    inboundTrue: 75,
    turns: 'right',
    legMins: 1,
  }

  /** Released up the radial, pointed at the fix, as the spawner does it. */
  const arriving = (distNM: number) =>
    ac({
      pos: advance(BNN.posNM, 348, distNM),
      hdg: 168,
      hold: BNN,
      navMode: 'HOLD',
    })

  it('calls an aircraft well short of the fix joining, not on a leg', () => {
    expect(holdLeg(arriving(10), BNN)).toBe('joining')
  })

  it('flies it straight at the fix rather than turning away', () => {
    // The bug this exists for: the leg used to be read off a heading that
    // has nothing to do with the racetrack, so an arrival ten miles out was
    // told it was on the outbound leg and turned ninety degrees away from
    // its own fix before coming back.
    const steer = holdSteer(arriving(10))
    expect(steer).not.toBeNull()
    expect(Math.abs(angleDelta(steer as number, 168))).toBeLessThan(5)
  })

  it('closes on the fix the whole way in', () => {
    let a = arriving(10)
    let last = distanceNM(a.pos, BNN.posNM)
    for (let s = 0; s < 120; s += 1) {
      a = stepAircraft(a, 1, s)
      const now = distanceNM(a.pos, BNN.posNM)
      // Never further off than it started, and never going backwards.
      expect(now).toBeLessThanOrEqual(last + 0.01)
      expect(now).toBeLessThanOrEqual(10.01)
      last = now
    }
  })

  it('reaches the fix, and in the time the run in should take', () => {
    // Ten miles at 220 kt is under three minutes. The looping version took
    // five and a half.
    let a = arriving(10)
    let arrived = -1
    for (let s = 1; s <= 400 && arrived < 0; s += 1) {
      a = stepAircraft(a, 1, s)
      if (distanceNM(a.pos, BNN.posNM) < 0.6) arrived = s
    }
    expect(arrived).toBeGreaterThan(0)
    expect(arrived).toBeLessThan(200)
  })

  it('hands over to the racetrack once it gets there', () => {
    // And does not simply fly through: within a couple of circuits it is
    // going round rather than heading off.
    let a = arriving(10)
    for (let s = 1; s <= 900; s += 1) a = stepAircraft(a, 1, s)
    expect(distanceNM(a.pos, BNN.posNM)).toBeLessThan(8)
    expect(a.navMode).toBe('HOLD')
  })

  it('does not steal the inbound leg from an aircraft on it', () => {
    // Pointed at the fix and on a heading the pattern does account for: it
    // belongs to the pattern, and is called what it is.
    const inbound = ac({ pos: advance(LAM.posNM, 69, 3), hdg: 249 })
    expect(holdLeg(inbound, LAM)).toBe('inbound')
  })

  it('does not call an aircraft flying the outbound leg joining', () => {
    // A leg out and two radii across is still inside the pattern's reach,
    // or the racetrack would collapse into a beeline every circuit.
    const out = ac({ pos: advance(LAM.posNM, 249 - 180, 3.5), hdg: 69 })
    expect(holdLeg(out, LAM)).not.toBe('joining')
  })
})

describe('the real holds stay in the airspace', () => {
  // The bug this guards. Bovingdon sits two miles inside the edge of the
  // TMA, so its hold has to be turned to fit -- and the test deciding which
  // way to turn it sampled a rectangle from the fix outwards on the turn
  // side only. That is not the shape an aeroplane flies: it overshoots the
  // fix reversing and swings to the far side joining, and both of those went
  // unchecked. The orientation chosen was one whose flown path left
  // controlled airspace.
  //
  // Flown through the spawner rather than from a hand-placed aircraft,
  // because the join is the part that was wrong and only the real arrival
  // flow reproduces it faithfully.
  const egll = loadAirport(raw)

  function holdFor(fixName: string): { outside: number; inbound: number } {
    const spawner = new Spawner({ airport: egll, seed: 7 })
    let traffic: readonly Aircraft[] = []
    let outside = 0
    let established = false
    let passes = 0
    let awayFromFix = true
    const fix = egll.holdingFixes.find((f) => f.name === fixName)
    if (!fix?.hold) throw new Error(`no hold at ${fixName}`)

    const steps = Math.round((25 * 60) / DT)
    for (let i = 0; i < steps; i += 1) {
      const clock = { ticks: i, elapsedSeconds: i * DT, timeOfDaySeconds: i * DT }
      traffic = traffic.map((a) => stepAircraft(a, DT, clock.elapsedSeconds))
      const born = spawner.update(DT, clock, traffic)
      if (born.length > 0) traffic = [...traffic, ...born]

      const mine = traffic.find((a) => a.hold?.fix === fixName)
      if (!mine) continue
      // The transit in from the gate is outside by design -- an arrival is
      // handed over before it becomes the controller's. Only the pattern
      // itself is being judged, so the clock starts on the SECOND pass over
      // the fix: the first one is the arrival, and the turn it makes there
      // to get on to the pattern is the join, which can legitimately reach
      // over the edge at a fix as tight as Bovingdon. An aircraft doing that
      // is not lost -- departureOf excuses one flying the hold it was
      // cleared to -- but it is not the settled pattern either.
      const nearFix = distanceNM(mine.pos, fix.posNM) < 2
      if (nearFix && awayFromFix) {
        passes += 1
        awayFromFix = false
      }
      if (!nearFix && distanceNM(mine.pos, fix.posNM) > 3) awayFromFix = true
      if (passes >= 2) established = true
      if (!established || mine.navMode !== 'HOLD') continue
      if (!isWithinFootprint(egll.controlZone, mine.pos)) outside += DT
    }
    return { outside, inbound: fix.hold.inboundTrue }
  }

  for (const name of ['LAM', 'BIG', 'BNN', 'OCK']) {
    it(`keeps an arrival holding at ${name} inside`, () => {
      const { outside, inbound } = holdFor(name)
      expect(outside, `${name} inbound ${inbound.toFixed(0)} spent ${outside.toFixed(1)}s outside`)
        .toBe(0)
    })
  }
})
