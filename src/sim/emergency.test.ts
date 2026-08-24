import { describe, expect, it } from 'vitest'

import { makeRng } from '../core/rng'
import { applyCommand, type ApplyContext } from '../commands/apply'
import type { Command } from '../commands/types'
import { DIFFICULTIES } from './difficulty'
import {
  canDeclare,
  declareEmergency,
  emergenciesIn,
  emergencyKind,
  EMERGENCY_DEADLINE_SECONDS,
  inEmergency,
  isNordo,
  isOverdue,
  urgencyOf,
} from './emergency'
import { Emergencies } from './emergencyflow'
import { buildSequence } from './sequence'
import {
  allocateSquawk,
  emergencyOf,
  isAssignable,
  isSquawk,
  RESERVED_SQUAWKS,
  SQUAWK_EMERGENCY,
  SQUAWK_RADIO_FAILURE,
} from './squawk'
import { NO_SCORE, pointsFor, scoreDeparture } from './score'
import type { Aircraft, ApproachClearance } from './types'

const clockAt = (elapsedSeconds: number) => ({
  ticks: Math.round(elapsedSeconds * 20),
  elapsedSeconds,
  timeOfDaySeconds: 43200 + elapsedSeconds,
})

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW123',
    type: 'A320',
    wake: 'M',
    role: 'arrival',
    pos: { x: 0, y: -12 },
    altFt: 6000,
    hdg: 360,
    iasKts: 220,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 360,
    clearedAltFt: 6000,
    clearedSpdKts: 220,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    route: [],
    routeLeg: 0,
    originFix: 'BIG',
    destination: null,
    entered: true,
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    squawk: '4271',
    emergencyAt: null,
    ...over,
  }
}

const approach: ApproachClearance = {
  runway: '27L',
  thresholdNM: { x: 0.4, y: 0 },
  courseTrue: 270,
  thresholdElevationFt: 80,
  glideslopeDeg: 3,
  fafDistNM: 10,
  maxInterceptDeg: 30,
  interceptAltMaxFt: 3000,
}

describe('transponder codes', () => {
  it('hands out four octal digits and nothing else', () => {
    const rng = makeRng(4242)
    for (let i = 0; i < 400; i += 1) {
      const code = allocateSquawk(rng)
      expect(isSquawk(code), code).toBe(true)
      expect(code).toMatch(/^[0-7]{4}$/)
    }
  })

  it('never hands out a code that already means something', () => {
    // The three emergency codes and the conspicuity codes. Assigning one to
    // a flight would put a code on the display that says something else.
    const rng = makeRng(7)
    for (let i = 0; i < 2000; i += 1) {
      expect(RESERVED_SQUAWKS.has(allocateSquawk(rng))).toBe(false)
    }
    for (const reserved of RESERVED_SQUAWKS) {
      expect(isAssignable(reserved), reserved).toBe(false)
    }
  })

  it('never repeats one that is already in the air', () => {
    // Two aircraft on one code is a genuine operational problem: the radar
    // cannot tell which return is which flight.
    const rng = makeRng(99)
    const taken = new Set<string>()
    for (let i = 0; i < 300; i += 1) {
      const code = allocateSquawk(rng, taken)
      expect(taken.has(code), `${code} issued twice`).toBe(false)
      taken.add(code)
    }
  })

  it('reads the three codes that mean something', () => {
    expect(emergencyOf('7700')).toBe('general')
    expect(emergencyOf('7600')).toBe('radio')
    // Not modelled, and deliberately: it is not a flying problem and the
    // response to it is not a controller's. See sim/squawk.ts.
    expect(emergencyOf('7500')).toBeNull()
    expect(emergencyOf('4271')).toBeNull()
  })
})

describe('declaring', () => {
  it('puts the code on the aeroplane and notes the time', () => {
    const a = declareEmergency(ac(), 'general', 400)
    expect(a.squawk).toBe(SQUAWK_EMERGENCY)
    expect(a.emergencyAt).toBe(400)
    expect(emergencyKind(a)).toBe('general')
  })

  it('keeps the code and the clock in step, always', () => {
    // The invariant the two fields exist under: the time is set exactly
    // when the squawk is an emergency code. Either one alone would let the
    // display say one thing and the simulation another.
    for (const a of [
      ac(),
      declareEmergency(ac(), 'general', 10),
      declareEmergency(ac(), 'radio', 10, approach),
    ]) {
      expect(a.emergencyAt === null, a.squawk).toBe(emergencyOf(a.squawk) === null)
    }
  })

  it('will not let one declare twice', () => {
    const a = declareEmergency(ac(), 'general', 10)
    expect(canDeclare(a)).toBe(false)
    // Nor anything that has finished with the sector, or is not yet yours.
    expect(canDeclare(ac({ navMode: 'LANDED' }))).toBe(false)
    expect(canDeclare(ac({ entered: false }))).toBe(false)
    expect(canDeclare(ac())).toBe(true)
  })

  it('sends a radio failure onto the approach on its own', () => {
    // The whole mechanic. A crew that cannot hear you flies the procedure
    // they are expected to fly, so the aeroplane takes itself off the
    // vector and joins the approach -- and the job becomes moving everybody
    // else out of its way.
    const a = declareEmergency(ac({ navMode: 'VECTOR' }), 'radio', 10, approach)
    expect(a.squawk).toBe(SQUAWK_RADIO_FAILURE)
    expect(a.navMode).toBe('LOC_ARMED')
    expect(a.clearedApproach?.runway).toBe('27L')
    // Down to where the approach expects to find it, and out of any hold,
    // which nobody could now break it out of.
    expect(a.clearedAltFt).toBeLessThanOrEqual(approach.interceptAltMaxFt)
    expect(a.hold).toBeNull()
  })

  it('leaves a general emergency flying what it was given', () => {
    // It can still hear you. Taking it off its vector would be the
    // simulation flying the aeroplane instead of the controller.
    const a = declareEmergency(ac({ navMode: 'VECTOR', clearedHdg: 90 }), 'general', 10, approach)
    expect(a.navMode).toBe('VECTOR')
    expect(a.clearedHdg).toBe(90)
    expect(a.clearedApproach).toBeNull()
  })

  it('does not put a transit onto an approach it never wanted', () => {
    // A transit that loses its radio is going somewhere else, and pointing
    // it at this field would be inventing a diversion nobody filed.
    const a = declareEmergency(
      ac({ role: 'overflight', destination: 'EGKK', navMode: 'LNAV' }),
      'radio',
      10,
      approach,
    )
    expect(a.navMode).toBe('LNAV')
    expect(a.clearedApproach).toBeNull()
  })
})

describe('a radio failure takes no clearances', () => {
  const ctx: ApplyContext = {
    floorFt: 1000,
    ceilingFt: 19500,
    speedLimitKts: 250,
    speedLimitBelowFt: 10000,
    envelopeFor: () => ({ minSpeedKts: 130, maxSpeedKts: 350 }),
    holdFor: () => null,
    approachFor: () => approach,
    controlZone: null,
  }

  it('refuses every instruction, including the helpful ones', () => {
    const nordo = declareEmergency(ac(), 'radio', 10, approach)
    expect(isNordo(nordo)).toBe(true)
    const commands: readonly Command[] = [
      { kind: 'heading', callsign: nordo.callsign, deg: 270 },
      { kind: 'altitude', callsign: nordo.callsign, ft: 4000 },
      { kind: 'speed', callsign: nordo.callsign, kts: 180 },
      { kind: 'approach', callsign: nordo.callsign, runway: '27L' },
      { kind: 'resumeNav', callsign: nordo.callsign },
    ]
    for (const command of commands) {
      const outcome = applyCommand(command, nordo, ctx)
      expect(outcome.ok, command.kind).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain('7600')
    }
  })

  it('still talks to a general emergency', () => {
    // It has a problem, not a broken radio, and refusing its clearances
    // would take away the only thing that can help it.
    const declared = declareEmergency(ac(), 'general', 10)
    const outcome = applyCommand({ kind: 'heading', callsign: declared.callsign, deg: 270 }, declared, ctx)
    expect(outcome.ok).toBe(true)
  })
})

describe('priority', () => {
  it('puts an emergency first in the sequence however far out it is', () => {
    // What priority means, in the one place a controller reads the landing
    // order off. Thirty miles behind two aircraft on final and still
    // number one.
    const close = ac({ callsign: 'CLOSE', pos: { x: 0, y: -4 } })
    const middle = ac({ callsign: 'MIDDLE', pos: { x: 0, y: -12 } })
    const far = declareEmergency(
      ac({ callsign: 'MAYDAY', pos: { x: 0, y: -30 } }),
      'general',
      10,
    )
    const built = buildSequence([close, middle, far])
    expect(built.sequence.map((f) => f.aircraft.callsign)).toEqual([
      'MAYDAY',
      'CLOSE',
      'MIDDLE',
    ])
  })

  it('puts the one with a problem on board ahead of the one that cannot talk', () => {
    const nordo = declareEmergency(ac({ callsign: 'NORDO1' }), 'radio', 10, approach)
    const mayday = declareEmergency(ac({ callsign: 'MAYDAY' }), 'general', 20)
    expect(emergenciesIn([nordo, mayday]).map((a) => a.callsign)).toEqual([
      'MAYDAY',
      'NORDO1',
    ])
  })

  it('leaves an ordinary sequence alone', () => {
    const near = ac({ callsign: 'NEAR', pos: { x: 0, y: -4 } })
    const away = ac({ callsign: 'AWAY', pos: { x: 0, y: -20 } })
    expect(buildSequence([away, near]).sequence.map((f) => f.aircraft.callsign)).toEqual([
      'NEAR',
      'AWAY',
    ])
  })
})

describe('the clock on a general emergency', () => {
  it('runs down from one to nothing', () => {
    const a = declareEmergency(ac(), 'general', 0)
    expect(urgencyOf(a, 0)).toBe(1)
    expect(urgencyOf(a, EMERGENCY_DEADLINE_SECONDS / 2)).toBeCloseTo(0.5, 5)
    expect(urgencyOf(a, EMERGENCY_DEADLINE_SECONDS)).toBe(0)
    expect(isOverdue(a, EMERGENCY_DEADLINE_SECONDS + 1)).toBe(true)
    expect(isOverdue(a, EMERGENCY_DEADLINE_SECONDS - 1)).toBe(false)
  })

  it('does not run one on a radio failure', () => {
    // It is not on a clock. It is on its own procedure, and a countdown
    // would invent urgency the situation does not have.
    const a = declareEmergency(ac(), 'radio', 0, approach)
    expect(urgencyOf(a, 9999)).toBeNull()
    expect(isOverdue(a, 9999)).toBe(false)
  })
})

describe('what it is worth', () => {
  it('pays double for landing one and charges four times for losing one', () => {
    expect(pointsFor('landed', DIFFICULTIES.easy, { emergency: true })).toBe(200)
    expect(pointsFor('landed', DIFFICULTIES.easy)).toBe(100)
    expect(pointsFor('left', DIFFICULTIES.easy, { emergency: true })).toBe(-200)
    expect(pointsFor('left', DIFFICULTIES.easy)).toBe(-50)
  })

  it('counts the emergencies landed separately, because that is the headline', () => {
    let score = NO_SCORE
    score = scoreDeparture(score, 'landed', DIFFICULTIES.easy, { emergency: true })
    score = scoreDeparture(score, 'landed', DIFFICULTIES.easy)
    expect(score.emergencies).toBe(1)
    expect(score.landed).toBe(2)
    expect(score.points).toBe(300)
  })

  it('scales with the difficulty, in both directions', () => {
    const hard = pointsFor('landed', DIFFICULTIES.hard, { emergency: true })
    const easy = pointsFor('landed', DIFFICULTIES.easy, { emergency: true })
    expect(hard).toBeGreaterThan(easy)
    // And the penalty scales too, or a hard setting would be easier to
    // score well on by being careless.
    expect(pointsFor('left', DIFFICULTIES.hard, { emergency: true })).toBeLessThan(
      pointsFor('left', DIFFICULTIES.easy, { emergency: true }),
    )
  })
})

describe('when one happens', () => {
  /** Run the scheduler over some traffic for a while. */
  function run(difficulty = DIFFICULTIES.hard, minutes = 90): readonly Aircraft[] {
    const flow = new Emergencies({ seed: 5150, difficulty })
    let traffic: readonly Aircraft[] = Array.from({ length: 6 }, (_, i) =>
      ac({ callsign: `BAW${100 + i}`, pos: { x: i * 3, y: -10 } }),
    )
    for (let t = 0; t < minutes * 60; t += 1) {
      traffic = flow.update(1, clockAt(t), traffic, () => approach)
    }
    return traffic
  }

  it('gives one of the aircraft already there a bad day', () => {
    // Not a new aeroplane. That is the whole point: an emergency is
    // something that happens to one you were halfway through sequencing.
    const after = run()
    expect(after).toHaveLength(6)
    expect(after.filter(inEmergency).length).toBeGreaterThan(0)
  })

  it('never gives the same one two emergencies', () => {
    for (const a of run()) {
      expect(a.emergencyAt === null).toBe(emergencyOf(a.squawk) === null)
    }
  })

  it('leaves the gentlest setting alone entirely', () => {
    // Easy has none, for the same reason it has no transits: the setting
    // exists to teach the shape of the job, and an emergency rewrites the
    // sequence you are in the middle of learning to build.
    expect(DIFFICULTIES.easy.emergenciesPerHour).toBe(0)
    expect(run(DIFFICULTIES.easy).some(inEmergency)).toBe(false)
  })

  it('does not declare in the opening minutes', () => {
    // An emergency with no traffic around it is a straight-in approach with
    // a red border: all of the interruption and none of the problem.
    expect(run(DIFFICULTIES.pro, 5).some(inEmergency)).toBe(false)
  })

  it('resumes rather than dealing again after a save and load', () => {
    const before = new Emergencies({ seed: 4242, difficulty: DIFFICULTIES.pro })
    let traffic: readonly Aircraft[] = [ac()]
    for (let t = 0; t < 1200; t += 1) {
      traffic = before.update(1, clockAt(t), traffic, () => approach)
    }
    const after = new Emergencies({ seed: 1, difficulty: DIFFICULTIES.pro })
    after.restore(before.snapshot())
    expect(after.snapshot()).toEqual(before.snapshot())
  })
})
