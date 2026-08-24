import { describe, expect, it } from 'vitest'
import { bearingDeg, distanceNM, type Vec2NM } from '../core/geo'
import { stepAircraft } from './aircraft'
import {
  activeFix,
  anticipationNM,
  legsRemaining,
  rejoinLeg,
  routeComplete,
  routeGuidance,
  routeSteer,
  routeText,
  sequenceRoute,
} from './route'
import type { Aircraft, Route } from './types'

/** A route running due east, ten miles between fixes. */
const EAST: Route = [
  { fix: 'ALPHA', posNM: { x: 0, y: 0 } },
  { fix: 'BRAVO', posNM: { x: 10, y: 0 } },
  { fix: 'CHARL', posNM: { x: 20, y: 0 } },
]

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'EZY42',
    type: 'A320',
    wake: 'M',
    role: 'overflight',
    pos: { x: -10, y: 0 },
    altFt: 12000,
    hdg: 90,
    iasKts: 280,
    gsKts: 280,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 12000,
    clearedSpdKts: 280,
    navMode: 'LNAV',
    clearedApproach: null,
    hold: null,
    route: EAST,
    routeLeg: 0,
    originFix: null,
    destination: 'EGKK',
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    squawk: '4271',
    emergencyAt: null,
    ...over,
  }
}

describe('flying a route', () => {
  it('steers at the fix it is going to', () => {
    // Due north of the first fix, so the only heading that makes the leg
    // good is south.
    const a = ac({ pos: { x: 0, y: 12 }, hdg: 90 })
    expect(routeSteer(a)).toBeCloseTo(180, 0)
  })

  it('holds its heading standing exactly on the fix', () => {
    // The bearing to a point you are on is meaningless, and a NaN heading
    // would put the aircraft somewhere undefined for the rest of the run.
    const a = ac({ pos: { x: 0, y: 0 }, hdg: 77 })
    expect(routeSteer(a)).toBe(77)
  })

  it('has nothing to steer at once the route is finished', () => {
    expect(routeSteer(ac({ routeLeg: 3 }))).toBeNull()
    expect(routeComplete(ac({ routeLeg: 3 }))).toBe(true)
    expect(routeComplete(ac({ routeLeg: 2 }))).toBe(false)
  })
})

describe('sequencing from leg to leg', () => {
  it('starts the turn before the fix rather than over it', () => {
    // A fly-by, which is what a real navigation database does: the turn is
    // begun early so the aircraft rolls out on the next leg, rather than
    // overflying the fix and then swinging back onto track.
    const ninety = anticipationNM(280, 90)
    expect(ninety).toBeGreaterThan(1)
    // A gentler turn starts later than a sharp one.
    expect(anticipationNM(280, 30)).toBeLessThan(ninety)
    // And a faster aeroplane, needing more room, starts earlier.
    expect(anticipationNM(400, 90)).toBeGreaterThan(ninety)
  })

  it('never sequences on distance alone when there is no turn', () => {
    // A leg carrying straight on has no corner to cut, so the fix has to be
    // reached rather than merely approached -- but not exactly, or one
    // missed by a tenth of a mile would never sequence at all.
    const straight = anticipationNM(280, 0)
    expect(straight).toBeGreaterThan(0)
    expect(straight).toBeLessThan(1)
  })

  it('passes a fix it has reached', () => {
    const before = ac({ pos: { x: -2, y: 0 } })
    expect(sequenceRoute(before)).toBe(0)
    const on = ac({ pos: { x: -0.1, y: 0 } })
    expect(sequenceRoute(on)).toBe(1)
  })

  it('passes more than one fix at a time when it has to', () => {
    // A short leg taken fast can fall inside the anticipation distance of
    // the one after it. Stopping at the first would leave the aircraft
    // turning back to a fix it had already gone by.
    const tight: Route = [
      { fix: 'ONE', posNM: { x: 0, y: 0 } },
      { fix: 'TWO', posNM: { x: 0.2, y: 0 } },
      { fix: 'THREE', posNM: { x: 40, y: 0 } },
    ]
    const a = ac({ route: tight, pos: { x: 0, y: 0 }, routeLeg: 0 })
    expect(sequenceRoute(a)).toBe(2)
  })

  it('reports what is left to fly', () => {
    expect(legsRemaining(ac({ routeLeg: 1 })).map((l) => l.fix)).toEqual(['BRAVO', 'CHARL'])
    expect(activeFix(ac({ routeLeg: 1 }))).toBe('BRAVO')
    expect(activeFix(ac({ routeLeg: 3 }))).toBeNull()
    expect(routeText(ac(), 2)).toBe('ALPHA BRAVO..')
    expect(routeText(ac({ routeLeg: 2 }))).toBe('CHARL')
    expect(routeText(ac({ routeLeg: 3 }))).toBe('')
  })
})

describe('a route being flown, step by step', () => {
  /** Fly for `seconds` at twenty steps a second. */
  function fly(a: Aircraft, seconds: number): Aircraft {
    let x = a
    for (let i = 0; i < seconds * 20; i += 1) x = stepAircraft(x, 0.05, i * 0.05)
    return x
  }

  it('navigates itself from fix to fix with nobody talking to it', () => {
    // The whole premise of a transit: it appears, it flies its plan, and
    // the controller does not have to touch it.
    const flown = fly(ac(), 60 * 8)
    expect(flown.routeLeg).toBe(3)
    expect(routeComplete(flown)).toBe(true)
    // And it went the way the route did, rather than wandering.
    expect(flown.pos.x).toBeGreaterThan(20)
    expect(Math.abs(flown.pos.y)).toBeLessThan(3)
  })

  it('turns a corner and rolls out on the new leg', () => {
    const corner: Route = [
      { fix: 'TURN', posNM: { x: 0, y: 0 } },
      { fix: 'NORTH', posNM: { x: 0, y: 30 } },
    ]
    const flown = fly(ac({ route: corner, pos: { x: -12, y: 0 }, hdg: 90 }), 60 * 5)
    // Tracking north up the second leg.
    expect(flown.hdg).toBeGreaterThan(340 - 360 + 360)
    expect(Math.abs(((flown.hdg - 0 + 540) % 360) - 180)).toBeLessThan(15)
    expect(flown.pos.y).toBeGreaterThan(5)
  })

  it('carries straight on after the last fix rather than stopping or turning', () => {
    // Nothing removes an aircraft here -- the sector boundary does that --
    // so a transit out of route has to keep flying the track it had.
    const done = fly(ac({ routeLeg: 3, clearedHdg: 90 }), 60)
    expect(done.hdg).toBeCloseTo(90, 0)
    expect(done.pos.x).toBeGreaterThan(-10)
  })

  it('is flown by a vector the moment one is given, not by the route', () => {
    // A vector has to win, or the controller could not move the aeroplane.
    const vectored = fly(ac({ navMode: 'VECTOR', clearedHdg: 360 }), 60 * 3)
    // Headings are normalised, so due north reads as zero rather than 360.
    expect(Math.abs(((vectored.hdg + 540) % 360) - 180)).toBeLessThan(1)
    expect(vectored.pos.y).toBeGreaterThan(5)
    // And the route is exactly where it was, waiting to be resumed.
    expect(vectored.routeLeg).toBe(0)
  })
})

describe('rejoining after a vector', () => {
  it('picks up the leg it was on when it was only pushed to one side', () => {
    // Twelve miles short of ALPHA but well off to the north: the fix is
    // still ahead, so it is still the one to fly to.
    const a = ac({ pos: { x: -12, y: 8 }, navMode: 'VECTOR' })
    expect(rejoinLeg(a)).toBe(0)
  })

  it('goes on to the next fix when the vector took it past one', () => {
    // Past ALPHA and most of the way to BRAVO. Rejoining ALPHA would turn
    // the aeroplane round, which is the one thing RESUME NAV must not do.
    const a = ac({ pos: { x: 8, y: 2 }, navMode: 'VECTOR' })
    expect(rejoinLeg(a)).toBe(1)
  })

  it('never goes backwards to a fix already flown', () => {
    // Sitting right on ALPHA but two legs down the route: the earlier fix
    // is nearer, and it is still not the answer.
    const a = ac({ pos: { x: 0, y: 0 }, routeLeg: 2, navMode: 'VECTOR' })
    expect(rejoinLeg(a)).toBeGreaterThanOrEqual(2)
  })

  it('leaves an aircraft with no route alone', () => {
    expect(rejoinLeg(ac({ route: [], routeLeg: 0 }))).toBe(0)
  })
})

describe('what the route asks of the flight model', () => {
  it('asks nothing of an aircraft that is not flying one', () => {
    expect(routeGuidance(ac({ navMode: 'VECTOR' }))).toBeNull()
    expect(routeGuidance(ac({ navMode: 'HOLD' }))).toBeNull()
  })

  it('sequences and steers in the same step', () => {
    // Order matters: an aircraft that has just passed a fix should turn
    // onto the next leg now, not spend a tick flying at one behind it.
    const at = ac({ pos: { x: -0.05, y: 0 } })
    const guidance = routeGuidance(at)
    expect(guidance?.routeLeg).toBe(1)
    const toBravo = bearingDeg(at.pos, { x: 10, y: 0 } as Vec2NM)
    expect(guidance?.clearedHdg).toBeCloseTo(toBravo, 0)
  })

  it('measures the ground it has left to cover', () => {
    // Not used to fly the aeroplane; used to know how long it will be here.
    const a = ac({ pos: { x: -10, y: 0 } })
    const total = legsRemaining(a).reduce(
      (sum, leg, i, all) =>
        sum + distanceNM(i === 0 ? a.pos : (all[i - 1]?.posNM ?? a.pos), leg.posNM),
      0,
    )
    expect(total).toBeCloseTo(30, 5)
  })
})
