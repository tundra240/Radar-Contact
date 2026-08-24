/**
 * Aircraft in trouble, and what the controller owes them.
 *
 * Two kinds, and they are almost opposites. One of them talks to you and
 * cannot wait; the other can wait all day and cannot hear a word you say.
 *
 * **7700, general emergency.** Something is wrong on board -- an engine, a
 * fire, someone ill -- and the crew have told you so. They still take
 * clearances, they still fly what you give them, and they are going to land
 * here whatever the sequence said five minutes ago. What they need from a
 * controller is the shortest path to a runway and everybody else moved out
 * of the way. The pressure is the clock: the longer one is airborne after
 * declaring, the worse the day is going.
 *
 * **7600, radio failure.** The aeroplane is fine. It simply cannot hear
 * you, and nothing you say will change that -- which makes it the more
 * interesting problem of the two, because the entire job becomes moving
 * everyone else. A crew that has lost the radio flies the procedure they
 * are expected to fly: they continue to the approach for the runway in use
 * and they land. So that is what this does. It is the one aircraft on the
 * display that is not yours to steer.
 *
 * There is no 7500 here. See sim/squawk.ts.
 */

import { onApproach } from './ils'
import { emergencyOf, squawkFor, type EmergencyKind } from './squawk'
import type { Aircraft, ApproachClearance } from './types'

/**
 * How long a general emergency has before it counts as mishandled.
 *
 * Twelve minutes from declaring to touching down. Long enough that a
 * controller who reacts has time to break the sequence, turn it in and land
 * it; short enough that carrying on as though nothing had happened does
 * not work. It is not a fuel model -- there is no fuel here -- it is the
 * pressure that makes priority mean something.
 */
export const EMERGENCY_DEADLINE_SECONDS = 12 * 60

/** Whether this aircraft is squawking something that needs an answer. */
export function emergencyKind(a: Aircraft): EmergencyKind | null {
  return emergencyOf(a.squawk)
}

/** Whether an emergency of any kind is running. */
export function inEmergency(a: Aircraft): boolean {
  return emergencyKind(a) !== null
}

/** Aircraft that cannot hear you, and therefore take no clearances. */
export function isNordo(a: Aircraft): boolean {
  return emergencyKind(a) === 'radio'
}

/** How long this one has been in trouble, or null if it is not. */
export function emergencySeconds(a: Aircraft, nowSeconds: number): number | null {
  if (a.emergencyAt === null) return null
  return Math.max(0, nowSeconds - a.emergencyAt)
}

/**
 * How much of the deadline is left, from one down to zero.
 *
 * Only meaningful for a general emergency: a radio failure is not on a
 * clock, it is on its own procedure, and putting a countdown on it would
 * invent urgency the situation does not have.
 */
export function urgencyOf(a: Aircraft, nowSeconds: number): number | null {
  if (emergencyKind(a) !== 'general') return null
  const running = emergencySeconds(a, nowSeconds)
  if (running === null) return null
  return Math.max(0, 1 - running / EMERGENCY_DEADLINE_SECONDS)
}

/** Whether a general emergency has been airborne longer than it should. */
export function isOverdue(a: Aircraft, nowSeconds: number): boolean {
  return urgencyOf(a, nowSeconds) === 0
}

/**
 * Whether this aircraft could declare one.
 *
 * On frequency, still flying, and not already in trouble. A transit can
 * declare as readily as an arrival -- an engine does not care whose sector
 * it is over, and a transit that declares becomes yours, which is the point
 * of it happening to one.
 */
export function canDeclare(a: Aircraft): boolean {
  if (!a.entered) return false
  if (a.navMode === 'LANDED' || a.navMode === 'HANDOFF') return false
  return !inEmergency(a)
}

/**
 * Put an aircraft into trouble.
 *
 * `approach` is the approach it would be cleared for at the runway in use,
 * and it is only used by a radio failure -- which is the one case where the
 * aeroplane does something the controller did not tell it to do. Pass null
 * where there is no approach to give it, and it will carry on with what it
 * has, which is also what a real one would do until it worked out where it
 * was.
 */
export function declareEmergency(
  a: Aircraft,
  kind: EmergencyKind,
  nowSeconds: number,
  approach: ApproachClearance | null = null,
): Aircraft {
  const declared: Aircraft = {
    ...a,
    squawk: squawkFor(kind),
    emergencyAt: nowSeconds,
  }

  if (kind !== 'radio') return declared
  // A crew with no radio flies what it is expected to fly, so it takes
  // itself off whatever vector it was on and joins the approach. It is
  // already established on one if the controller got there first, in which
  // case there is nothing to change -- and it will now finish it whatever
  // anybody says.
  if (approach === null || onApproach(declared.navMode)) return declared
  if (declared.role === 'overflight') return declared

  return {
    ...declared,
    navMode: 'LOC_ARMED',
    clearedApproach: approach,
    // Off the hold, or it would fly a racetrack nobody can break it out of.
    hold: null,
    // Down to the intercept altitude, which is where the approach expects
    // to find it. The autopilot does the rest.
    clearedAltFt: Math.min(declared.clearedAltFt, approach.interceptAltMaxFt),
  }
}

/**
 * The emergencies among some traffic, worst first.
 *
 * "Worst" is the one that has been waiting longest, which is also the order
 * they should be landed in. A radio failure sorts after a general emergency
 * however long it has been going: it is not on a clock, and an aeroplane
 * with a problem on board outranks one that merely cannot talk.
 */
export function emergenciesIn(traffic: readonly Aircraft[]): readonly Aircraft[] {
  return traffic
    .filter(inEmergency)
    .sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (x.emergencyAt ?? 0) - (y.emergencyAt ?? 0) ||
        x.callsign.localeCompare(y.callsign),
    )
}

function rank(a: Aircraft): number {
  return emergencyKind(a) === 'general' ? 0 : 1
}
