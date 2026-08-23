import { describe, expect, it } from 'vitest'
import { applyCommand, type ApplyContext } from '../commands/apply'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import { stepAircraft } from '../sim/aircraft'
import type { Aircraft } from '../sim/types'
import { leavesOf } from './engine'
import { BASICS } from './lessons/basics'
import { buildTraffic } from './traffic'
import type { Goal } from './types'

/**
 * Can the lesson actually be flown?
 *
 * Every other test here checks that the engine advances when told the right
 * thing happened. None of them check the thing the lesson asks for is
 * possible -- and that is the failure a player meets. A step can be
 * perfectly wired, with a reachable menu and a matching goal, and still be
 * a dead end because the numbers in it do not fly.
 *
 * So this takes the headings, levels and speeds out of the lesson data,
 * gives them to the real flight model in the real order, and insists the
 * aeroplane lands. Change a heading in basics.ts and this re-checks it.
 */

const airport = loadAirport(raw)
const rwy = airport.runways.find((r) => r.id === '27R')

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
  approachFor: () =>
    rwy === undefined || !rwy.ils.available
      ? null
      : {
          runway: rwy.id,
          thresholdNM: rwy.thresholdNM,
          courseTrue: rwy.bearingTrue,
          thresholdElevationFt: rwy.thresholdElevationFt,
          glideslopeDeg: rwy.ils.glideslopeDeg,
          fafDistNM: rwy.ils.fafDistNM,
          maxInterceptDeg: rwy.ils.minInterceptDeg,
          interceptAltMaxFt: airport.sector.interceptAltMaxFt,
        },
  controlZone: airport.controlZone,
}

const tick = (a: Aircraft, t: number): Aircraft => ({
  ...stepAircraft(a, 0.05, t),
  entered: true,
})

/** Fly for `seconds` of simulated time from `from`. */
function fly(a: Aircraft, seconds: number, from: number): Aircraft {
  let x = a
  for (let i = 0; i < seconds * 20; i += 1) x = tick(x, from + i * 0.05)
  return x
}

/** The single leaf of a given kind in a step's goal, by step id. */
function goalIn(id: string, kind: Goal['kind']): Goal {
  const step = BASICS.steps.find((s) => s.id === id)
  if (step === undefined) throw new Error(`no step ${id}`)
  const leaf = leavesOf(step.goal).find((g) => g.kind === kind)
  if (leaf === undefined) throw new Error(`step ${id} has no ${kind} goal`)
  return leaf
}

function issue(a: Aircraft, command: Parameters<typeof applyCommand>[0]): Aircraft {
  const out = applyCommand(command, a, ctx)
  if (!out.ok) throw new Error(`refused: ${out.reason}`)
  return out.aircraft
}

describe('the lesson can actually be flown', () => {
  /** The scripted inbound, established in the BIG hold and levelled off. */
  function inTheHold(): { aircraft: Aircraft; at: number } {
    const spec = BASICS.steps.find((s) => s.id === 'inbound')?.scene?.traffic ?? []
    const [built] = buildTraffic(airport, spec, 0)
    expect(built).toBeDefined()

    // Long enough to reach BIG and settle onto the racetrack.
    let a = fly(built as Aircraft, 20 * 60, 0)
    expect(a.navMode).toBe('HOLD')

    const altitude = goalIn('descend', 'altitude')
    const airspeed = goalIn('descend', 'airspeed')
    if (altitude.kind !== 'altitude' || airspeed.kind !== 'airspeed') throw new Error('shape')
    a = issue(a, { kind: 'altitude', callsign: a.callsign, ft: altitude.ft })
    a = issue(a, { kind: 'speed', callsign: a.callsign, kts: airspeed.kts })

    // Orbiting while the player reads, coming down to the platform.
    a = fly(a, 5 * 60, 1200)
    expect(a.altFt).toBe(altitude.ft)
    return { aircraft: a, at: 1500 }
  }

  it('lands the arrival using the headings the lesson gives', () => {
    // The whole of phase four, out of the data rather than written here.
    const turnIn = goalIn('turn-in', 'heading')
    const intercept = goalIn('intercept', 'heading')
    if (turnIn.kind !== 'heading' || intercept.kind !== 'heading') throw new Error('shape')

    let { aircraft: a, at } = inTheHold()
    a = issue(a, { kind: 'heading', callsign: a.callsign, deg: turnIn.deg })
    // The turn-in step stops the clock, so the intercept follows with the
    // picture frozen -- which is the whole reason it does.
    a = issue(a, { kind: 'heading', callsign: a.callsign, deg: intercept.deg })
    a = issue(a, { kind: 'approach', callsign: a.callsign, runway: '27R' })

    let landed = false
    for (let i = 0; i < 30 * 60 * 20 && !landed; i += 1) {
      a = tick(a, at + i * 0.05)
      landed = a.navMode === 'LANDED'
    }
    expect(landed, `never landed -- ended in ${a.navMode}`).toBe(true)
  })

  it('still lands if the player takes a while over the intercept', () => {
    // The clock is stopped at that point, so in the lesson there is no time
    // pressure at all. This checks the margin anyway: a minute of running
    // clock between the two turns must not make the step impossible.
    const turnIn = goalIn('turn-in', 'heading')
    const intercept = goalIn('intercept', 'heading')
    if (turnIn.kind !== 'heading' || intercept.kind !== 'heading') throw new Error('shape')

    let { aircraft: a, at } = inTheHold()
    a = issue(a, { kind: 'heading', callsign: a.callsign, deg: turnIn.deg })
    a = fly(a, 60, at)
    a = issue(a, { kind: 'heading', callsign: a.callsign, deg: intercept.deg })
    a = issue(a, { kind: 'approach', callsign: a.callsign, runway: '27R' })

    let landed = false
    for (let i = 0; i < 30 * 60 * 20 && !landed; i += 1) {
      a = tick(a, at + 60 + i * 0.05)
      landed = a.navMode === 'LANDED'
    }
    expect(landed, `never landed -- ended in ${a.navMode}`).toBe(true)
  })

  it('would not land on the turn-in heading alone', () => {
    // Which is why there are two steps rather than one, and what the
    // intercept step exists to explain: ten miles to one side of the beam,
    // the runway heading runs parallel to it for ever.
    const turnIn = goalIn('turn-in', 'heading')
    if (turnIn.kind !== 'heading') throw new Error('shape')

    let { aircraft: a, at } = inTheHold()
    a = issue(a, { kind: 'heading', callsign: a.callsign, deg: turnIn.deg })
    a = issue(a, { kind: 'approach', callsign: a.callsign, runway: '27R' })

    let landed = false
    for (let i = 0; i < 20 * 60 * 20 && !landed; i += 1) {
      a = tick(a, at + i * 0.05)
      landed = a.navMode === 'LANDED'
    }
    expect(landed).toBe(false)
  })

  it('places the checkride traffic where none of it overlaps', () => {
    // Two arrivals were being put on the same fix at the same point,
    // differing only in level -- one blip with two data blocks on it, which
    // reads as a broken display rather than as two aeroplanes.
    const spec = BASICS.steps.find((s) => s.id === 'checkride')?.scene?.traffic ?? []
    const built = buildTraffic(airport, spec, 0)
    expect(built.length).toBe(spec.length)

    for (let i = 0; i < built.length; i += 1) {
      for (let j = i + 1; j < built.length; j += 1) {
        const a = built[i] as Aircraft
        const b = built[j] as Aircraft
        const apart = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)
        expect(apart, `${a.callsign} and ${b.callsign} are on top of each other`).toBeGreaterThan(
          4,
        )
      }
    }
  })
})
