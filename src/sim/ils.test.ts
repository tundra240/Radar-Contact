import { describe, expect, it } from 'vitest'
import { TICK_MS } from '../core/loop'
import { advance, angleDelta, bearingDeg, distanceNM } from '../core/geo'
import { applyAll, type ApplyContext } from '../commands/apply'
import { loadAirport, outerLimitNM } from '../data/airport'
import raw from '../data/egll.json'
import { departureOf, enterSector, stepAircraft } from './aircraft'
import { Spawner } from './spawner'
import {
  AIM_LEAD_NM,
  LOC_CAPTURE_NM,
  LOC_RANGE_NM,
  approachGeometry,
  canCapture,
  glidepathAltFt,
  ilsGuidance,
  onApproach,
  trackHeading,
} from './ils'
import type { Aircraft, ApproachClearance } from './types'

/**
 * The ILS.
 *
 * The unit tests pin the geometry and each arm of the capture test on its
 * own; the one that says whether this works is `flying it`, which puts an
 * aircraft where a controller would leave it and asserts it ends up on the
 * numbers.
 */

/** 27R, laid out on the axes to keep the arithmetic checkable by hand. */
const ILS: ApproachClearance = {
  runway: '27R',
  thresholdNM: { x: 0, y: 0 },
  courseTrue: 270,
  thresholdElevationFt: 80,
  glideslopeDeg: 3,
  fafDistNM: 10,
  maxInterceptDeg: 30,
  interceptAltMaxFt: 3000,
}

/** A point on final: `toRunNM` miles out, `offsetNM` right of the course. */
const onFinal = (toRunNM: number, offsetNM = 0) =>
  advance(advance(ILS.thresholdNM, ILS.courseTrue + 180, toRunNM), ILS.courseTrue + 90, offsetNM)

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW178',
    type: 'A320',
    wake: 'M',
    pos: onFinal(12),
    altFt: 3000,
    hdg: ILS.courseTrue,
    iasKts: 180,
    gsKts: 180,
    vsFpm: 0,
    clearedHdg: ILS.courseTrue,
    clearedAltFt: 3000,
    clearedSpdKts: 180,
    navMode: 'LOC_ARMED',
    clearedApproach: ILS,
    hold: null,
    originFix: 'BIG',
    entered: true,
    trail: [],
    trailAt: 0,
    role: 'arrival',
    route: [],
    routeLeg: 0,
    destination: null,
    spawnedAt: 0,
    squawk: '4271',
    emergencyAt: null,
    ...over,
  }
}

const DT = TICK_MS / 1000

describe('approachGeometry', () => {
  it('measures miles to run, positive on the approach side', () => {
    expect(approachGeometry(onFinal(10), ILS).toRunNM).toBeCloseTo(10, 5)
    expect(approachGeometry(ILS.thresholdNM, ILS).toRunNM).toBeCloseTo(0, 6)
  })

  it('goes negative past the threshold, which is how landing is detected', () => {
    expect(approachGeometry(onFinal(-2), ILS).toRunNM).toBeCloseTo(-2, 5)
  })

  it('signs the offset to the right of the inbound course', () => {
    // Landing west, so right of course is north.
    expect(approachGeometry(onFinal(8, 1.5), ILS).offsetNM).toBeCloseTo(1.5, 5)
    expect(approachGeometry(onFinal(8, -1.5), ILS).offsetNM).toBeCloseTo(-1.5, 5)
    expect(approachGeometry(onFinal(8), ILS).offsetNM).toBeCloseTo(0, 6)
  })
})

describe('glidepathAltFt', () => {
  it('rises about 318 feet a mile on three degrees', () => {
    const perNM = glidepathAltFt(ILS, 1) - ILS.thresholdElevationFt
    expect(perNM).toBeGreaterThan(315)
    expect(perNM).toBeLessThan(320)
  })

  it('is the threshold elevation at the threshold, and never below it', () => {
    expect(glidepathAltFt(ILS, 0)).toBe(ILS.thresholdElevationFt)
    expect(glidepathAltFt(ILS, -5)).toBe(ILS.thresholdElevationFt)
  })

  it('puts the platform altitude just inside the final approach fix', () => {
    // 3,000 ft meets a three degree path at about 9.2 NM, which is why the
    // glideslope is armed from outside the fix rather than at it.
    expect(glidepathAltFt(ILS, ILS.fafDistNM)).toBeGreaterThan(3000)
    expect(glidepathAltFt(ILS, 9)).toBeLessThan(3000)
  })
})

describe('canCapture', () => {
  /** Lined up to capture: in range, in the beam, closing, low enough. */
  const ready = (over: Partial<Aircraft> = {}): Aircraft =>
    ac({ pos: onFinal(10, 1), hdg: ILS.courseTrue - 20, altFt: 3000, ...over })

  it('captures a properly set up intercept', () => {
    expect(canCapture(ready(), ILS)).toBe(true)
  })

  it('refuses from beyond the threshold, so nothing flies it backwards', () => {
    expect(canCapture(ready({ pos: onFinal(-3, 0.2) }), ILS)).toBe(false)
  })

  it('refuses outside localiser coverage', () => {
    expect(canCapture(ready({ pos: onFinal(LOC_RANGE_NM + 2, 0.2) }), ILS)).toBe(false)
    expect(canCapture(ready({ pos: onFinal(LOC_RANGE_NM - 2, 0.2) }), ILS)).toBe(true)
  })

  it('refuses outside the beam', () => {
    expect(canCapture(ready({ pos: onFinal(10, LOC_CAPTURE_NM + 0.2) }), ILS)).toBe(false)
    expect(canCapture(ready({ pos: onFinal(10, LOC_CAPTURE_NM - 0.2) }), ILS)).toBe(true)
  })

  it('refuses a crossing angle wider than the published intercept', () => {
    // The classic bug: an aircraft crossing the localiser at ninety degrees
    // snapping onto final.
    expect(canCapture(ready({ hdg: ILS.courseTrue - 90 }), ILS)).toBe(false)
    expect(canCapture(ready({ hdg: ILS.courseTrue - 31 }), ILS)).toBe(false)
    expect(canCapture(ready({ hdg: ILS.courseTrue - 29 }), ILS)).toBe(true)
  })

  it('refuses above the intercept altitude', () => {
    expect(canCapture(ready({ altFt: ILS.interceptAltMaxFt + 100 }), ILS)).toBe(false)
    expect(canCapture(ready({ altFt: ILS.interceptAltMaxFt }), ILS)).toBe(true)
  })

  it('refuses one inside the beam that is not closing on it', () => {
    // Right of the centreline and pointing further right: diverging. The
    // angle is inside thirty degrees, so nothing else here would catch it.
    expect(canCapture(ready({ pos: onFinal(10, 1), hdg: ILS.courseTrue + 20 }), ILS)).toBe(false)
    // Parallel to it, a mile off, is not closing either.
    expect(canCapture(ready({ pos: onFinal(10, 1), hdg: ILS.courseTrue }), ILS)).toBe(false)
    // And the mirror image converges, so the sign is the right way round.
    expect(canCapture(ready({ pos: onFinal(10, -1), hdg: ILS.courseTrue + 20 }), ILS)).toBe(true)
  })

  it('captures one already on the centreline, whichever way it points', () => {
    for (const off of [-10, 0, 10]) {
      expect(canCapture(ready({ pos: onFinal(10), hdg: ILS.courseTrue + off }), ILS), String(off))
        .toBe(true)
    }
  })
})

describe('trackHeading', () => {
  it('turns toward the course from either side', () => {
    // Right of course, so it has to aim left of it, and the other way about.
    expect(angleDelta(trackHeading(ac({ pos: onFinal(12, 1) }), ILS), ILS.courseTrue))
      .toBeGreaterThan(0)
    expect(angleDelta(trackHeading(ac({ pos: onFinal(12, -1) }), ILS), ILS.courseTrue))
      .toBeLessThan(0)
  })

  it('is the course itself when established on the centreline', () => {
    expect(trackHeading(ac({ pos: onFinal(12) }), ILS)).toBeCloseTo(ILS.courseTrue, 4)
  })

  it('aims a couple of miles ahead rather than at the threshold', () => {
    // Aiming at the threshold from a mile off track gives a shallower and
    // shallower angle the further out you are, and closes far too slowly.
    const far = trackHeading(ac({ pos: onFinal(20, 1) }), ILS)
    const near = trackHeading(ac({ pos: onFinal(AIM_LEAD_NM * 2, 1) }), ILS)
    // The correction is the same size wherever it is applied from, because
    // it is set by the lead distance and not by the range to the runway.
    expect(Math.abs(angleDelta(far, ILS.courseTrue))).toBeCloseTo(
      Math.abs(angleDelta(near, ILS.courseTrue)),
      0,
    )
  })
})

describe('ilsGuidance', () => {
  it('says nothing about an aircraft that has not been cleared', () => {
    expect(ilsGuidance(ac({ clearedApproach: null, navMode: 'VECTOR' }))).toBeNull()
    expect(ilsGuidance(ac({ navMode: 'VECTOR' }))).toBeNull()
    expect(ilsGuidance(ac({ navMode: 'HOLD' }))).toBeNull()
  })

  it('leaves an armed approach alone until the geometry allows a capture', () => {
    // The vector the controller gave it has to stand, or clearing an
    // approach early would turn the aircraft on its own.
    expect(ilsGuidance(ac({ pos: onFinal(10, 4), hdg: ILS.courseTrue - 20 }))).toBeNull()
  })

  it('establishes on the localiser once it can', () => {
    const lined = ac({ pos: onFinal(10, 1), hdg: ILS.courseTrue - 20 })
    const g = ilsGuidance(lined)
    expect(g?.navMode).toBe('LOC_CAPTURED')
    // And holds the level it was given: the glidepath is still above it.
    expect(g?.clearedAltFt).toBe(lined.clearedAltFt)
  })

  it('picks the glidepath up when it descends onto the aircraft', () => {
    // Level at 3,000 the path arrives at about 9.2 NM, not at the fix.
    expect(ilsGuidance(ac({ pos: onFinal(10), navMode: 'LOC_CAPTURED' }))?.navMode)
      .toBe('LOC_CAPTURED')

    const g = ilsGuidance(ac({ pos: onFinal(9), navMode: 'LOC_CAPTURED' }))
    expect(g?.navMode).toBe('GS_TRACKING')
    expect(g?.clearedAltFt).toBeCloseTo(glidepathAltFt(ILS, 9), 6)
  })

  it('flies the path down once established on it', () => {
    const g = ilsGuidance(ac({ pos: onFinal(5), navMode: 'GS_TRACKING', altFt: 1700 }))
    expect(g?.clearedAltFt).toBeCloseTo(glidepathAltFt(ILS, 5), 6)
    expect(g?.clearedAltFt).toBeLessThan(1700)
  })

  it('lands it at the threshold, on the published elevation', () => {
    const g = ilsGuidance(ac({ pos: onFinal(-0.01), navMode: 'GS_TRACKING', altFt: 90 }))
    expect(g?.navMode).toBe('LANDED')
    expect(g?.clearedAltFt).toBe(ILS.thresholdElevationFt)
  })
})

describe('onApproach', () => {
  it('covers every stage of one and nothing else', () => {
    expect(onApproach('LOC_ARMED')).toBe(true)
    expect(onApproach('LOC_CAPTURED')).toBe(true)
    expect(onApproach('GS_TRACKING')).toBe(true)
    for (const mode of ['HOLD', 'VECTOR', 'GO_AROUND', 'LANDED', 'HANDOFF'] as const) {
      expect(onApproach(mode), mode).toBe(false)
    }
  })
})

describe('flying it', () => {
  /**
   * An aircraft as a controller would have left it: on a heading, at a
   * level, with both of those actually cleared. Setting `hdg` alone would
   * have the autopilot turn it back onto whatever the fixture's cleared
   * heading happened to be, which is not a vector at all.
   */
  const vectored = (toRunNM: number, offsetNM: number, hdg: number, altFt = 3000): Aircraft =>
    ac({
      pos: onFinal(toRunNM, offsetNM),
      hdg,
      clearedHdg: hdg,
      altFt,
      clearedAltFt: altFt,
    })

  /** Runs the real flight model until it lands or gives up. */
  function fly(start: Aircraft, minutes = 15) {
    let a = start
    let worstOffset = 0
    const seen: string[] = [a.navMode]
    const steps = Math.round((minutes * 60) / DT)

    for (let i = 0; i < steps; i += 1) {
      a = stepAircraft(a, DT, i * DT)
      if (a.navMode === 'LOC_CAPTURED' || a.navMode === 'GS_TRACKING') {
        worstOffset = Math.max(worstOffset, Math.abs(approachGeometry(a.pos, ILS).offsetNM))
      }
      if (seen[seen.length - 1] !== a.navMode) seen.push(a.navMode)
      if (a.navMode === 'LANDED') break
    }
    return { a, seen, worstOffset, geometry: approachGeometry(a.pos, ILS) }
  }

  it('goes from a set-up intercept to the numbers', () => {
    // Where a controller would leave it: twelve miles out, two miles off
    // the centreline, at the platform altitude, on a thirty degree
    // intercept.
    const r = fly(vectored(12, 2, ILS.courseTrue - 30))

    expect(r.seen).toEqual(['LOC_ARMED', 'LOC_CAPTURED', 'GS_TRACKING', 'LANDED'])
    expect(r.a.altFt).toBe(ILS.thresholdElevationFt)
    // On the threshold, on the centreline.
    expect(Math.abs(r.geometry.toRunNM)).toBeLessThan(0.2)
    expect(Math.abs(r.geometry.offsetNM)).toBeLessThan(0.1)
  })

  it('closes the offset without ever overshooting the centreline', () => {
    // A proportional correction on the offset weaves about the beam. The
    // worst offset after capture must be the capture itself.
    const r = fly(vectored(12, 2, ILS.courseTrue - 30))
    expect(r.worstOffset).toBeLessThanOrEqual(LOC_CAPTURE_NM + 0.01)
  })

  it('descends on the path rather than diving for the runway', () => {
    let a = vectored(12, 0.2, ILS.courseTrue - 10)
    // Twelve miles at 180 kt is four minutes, so give it six.
    for (let i = 0; i < 20 * 360; i += 1) {
      a = stepAircraft(a, DT, i * DT)
      if (a.navMode === 'GS_TRACKING') {
        const g = approachGeometry(a.pos, ILS)
        if (g.toRunNM > 1) {
          // Within a hundred feet of the published path the whole way down.
          expect(Math.abs(a.altFt - glidepathAltFt(ILS, g.toRunNM))).toBeLessThan(100)
        }
      }
      if (a.navMode === 'LANDED') break
    }
    expect(a.navMode).toBe('LANDED')
  })

  it('flies straight through a localiser it was never lined up for', () => {
    // Cleared for the approach while crossing at ninety degrees: it should
    // carry on and need taking round again, not snap onto final.
    const r = fly(vectored(10, 6, ILS.courseTrue - 90), 4)
    expect(r.seen).toEqual(['LOC_ARMED'])
    expect(r.a.navMode).toBe('LOC_ARMED')
    // It has crossed the centreline and kept going.
    expect(approachGeometry(r.a.pos, ILS).offsetNM).toBeLessThan(0)
  })

  it('will not fly the approach backwards from beyond the runway', () => {
    const r = fly(vectored(-4, 0, ILS.courseTrue), 4)
    expect(r.seen).toEqual(['LOC_ARMED'])
    expect(distanceNM(r.a.pos, ILS.thresholdNM)).toBeGreaterThan(4)
  })

  it('needs descending before it can capture', () => {
    // Above the platform altitude, perfectly lined up, and still refused --
    // which is the whole point of the altitude arm of the test.
    const high = fly(vectored(14, 0.2, ILS.courseTrue, 5000), 4)
    expect(high.seen).toEqual(['LOC_ARMED'])

    const low = fly(vectored(14, 0.2, ILS.courseTrue))
    expect(low.seen).toContain('LANDED')
  })
})

describe('a whole session', () => {
  /**
   * Everything at once, on the real config: the spawner releasing into the
   * stacks, a crude controller vectoring each arrival to a gate and
   * clearing it for the approach, the gate in commands/apply.ts validating
   * every instruction, and sim/ils.ts flying them to the numbers.
   *
   * This is the test that says the game can be played.
   */
  it('lands traffic through the real command path', () => {
    const airport = loadAirport(raw)
/** Hoisted: it walks every vertex of the airspace, and never changes. */
const OUTER_LIMIT_NM = outerLimitNM(airport)
    const rwy = airport.arrivalRunways.find((r) => r.id === '27R')
    if (!rwy) throw new Error('no 27R in the config')

    const app: ApproachClearance = {
      runway: rwy.id,
      thresholdNM: rwy.thresholdNM,
      courseTrue: rwy.bearingTrue,
      thresholdElevationFt: rwy.thresholdElevationFt,
      glideslopeDeg: rwy.ils.glideslopeDeg,
      fafDistNM: rwy.ils.fafDistNM,
      maxInterceptDeg: rwy.ils.minInterceptDeg,
      interceptAltMaxFt: airport.sector.interceptAltMaxFt,
    }

    const ctx: ApplyContext = {
      floorFt: airport.sector.floorFt,
      ceilingFt: airport.sector.ceilingFt,
      speedLimitKts: airport.sector.speedLimitKts,
      speedLimitBelowFt: airport.sector.speedLimitBelowFt,
      envelopeFor: (type) => {
        const t = airport.aircraftTypes.find((x) => x.type === type)
        return t === undefined ? null : { minSpeedKts: t.approachKts, maxSpeedKts: t.cruiseKts }
      },
      holdFor: () => null,
      approachFor: (id) => (id === '27R' ? app : null),
      controlZone: airport.controlZone,
    }

    const spawner = new Spawner({ airport, seed: 4242 })
    const clock = { ticks: 0, elapsedSeconds: 0, timeOfDaySeconds: 43200 }
    let traffic: readonly Aircraft[] = []
    let landed = 0
    const worked = new Map<string, string>()

    const command = (a: Aircraft, cmds: Parameters<typeof applyAll>[0]): Aircraft => {
      const out = applyAll(cmds, a, ctx)
      // A refusal here is a real failure: the controller below only issues
      // things that should be legal.
      if (!out.ok) throw new Error(`${a.callsign} refused: ${out.reason}`)
      return out.aircraft
    }

    for (let i = 0; i < 20 * 1800; i += 1) {
      clock.ticks += 1
      clock.elapsedSeconds = clock.ticks * DT

      let world: Aircraft[] = []
      for (const a of traffic.map((x) => stepAircraft(x, DT, clock.elapsedSeconds))) {
        // The same three rules main.ts applies, rather than copies of them.
        const flown = enterSector(a, airport.controlZone)
        const departure = departureOf(flown, airport.controlZone, OUTER_LIMIT_NM)
        if (departure === 'landed') landed += 1
        if (departure === null) world.push(flown)
      }

      // Once a second, work one thing per aircraft, as a controller would.
      if (i % 20 === 0) {
        world = world.map((a) => {
          // Traffic outside the boundary takes no instructions, so there is
          // nothing to do with it but watch it come in.
          if (!a.entered) return a
          const geom = approachGeometry(a.pos, app)
          const side = geom.offsetNM >= 0 ? 1 : -1
          // A gate thirteen miles out and two and a half to one side: the
          // shape of a base leg turning onto final.
          const gate = advance(
            advance(app.thresholdNM, app.courseTrue + 180, 13),
            app.courseTrue + 90 * side,
            2.5,
          )
          const stage = worked.get(a.callsign) ?? 'new'

          if (stage === 'new') {
            worked.set(a.callsign, 'toGate')
            return command(a, [
              { kind: 'altitude', callsign: a.callsign, ft: 3000 },
              { kind: 'speed', callsign: a.callsign, kts: 180 },
              { kind: 'heading', callsign: a.callsign, deg: Math.round(bearingDeg(a.pos, gate)) },
            ])
          }

          if (stage === 'toGate') {
            if (distanceNM(a.pos, gate) > 2) {
              return command(a, [
                { kind: 'heading', callsign: a.callsign, deg: Math.round(bearingDeg(a.pos, gate)) },
              ])
            }
            worked.set(a.callsign, 'intercept')
            return command(a, [
              { kind: 'heading', callsign: a.callsign, deg: Math.round(app.courseTrue - 30 * side) },
              { kind: 'approach', callsign: a.callsign, runway: '27R' },
            ])
          }
          return a
        })
      }

      traffic = [...world, ...spawner.update(DT, clock, world)]
    }

    // Half an hour of it, so this is a rate rather than a fluke.
    expect(landed).toBeGreaterThan(10)
    // And the flow keeps up, which it can only do because landings free the
    // stacks the spawner is waiting on.
    expect(spawner.spawned).toBeGreaterThan(airport.traffic.maxConcurrent)
  })
})
