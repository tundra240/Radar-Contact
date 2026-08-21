import { distanceNM, type Vec2NM } from '../core/geo'
import { requiredGapNM } from './separation'
import type { Aircraft } from './types'

/**
 * The arrival sequence.
 *
 * The radar picture says where every aircraft is. What it does not say is
 * what order they are going to land in, or whether the gaps between them
 * are legal -- and that is the whole job. So the strip bay is built on
 * this rather than on a second copy of the data block.
 *
 * Two groups, because that is how the traffic divides:
 *
 * - the **sequence**: everything being worked, nearest the field first.
 * - the **stack**: everything holding, lowest first, since the bottom of a
 *   hold is what comes out of it next.
 * - the **inbound**: traffic still outside the boundary, which can be seen
 *   and not touched. Furthest first, so the next one to arrive is at the
 *   bottom of the list, nearest the traffic it is about to join.
 */

const FIELD: Vec2NM = { x: 0, y: 0 }

export interface SequencedFlight {
  readonly aircraft: Aircraft
  /** Position in the sequence, counting from one. */
  readonly position: number
  /** Straight-line miles to the field. */
  readonly toFieldNM: number
  /**
   * Gap to the aircraft ahead, in miles of sequence -- the difference in
   * distance to run, not the slant range between the two.
   *
   * That is the number that matters for sequencing: two aircraft on
   * opposite base legs can be twenty miles apart and still be about to
   * arrive at the same point at the same time, and a gap of nothing is
   * exactly what should be shown for that. Null for the aircraft in front,
   * which has nobody to follow.
   */
  readonly gapNM: number | null
  /** What that pair needs, from the wake categories. Null for the leader. */
  readonly requiredNM: number | null
}

/** Holding traffic. Not in the sequence yet, so it has no position. */
export interface StackedFlight {
  readonly aircraft: Aircraft
  readonly toFieldNM: number
}

export interface ArrivalSequence {
  readonly sequence: readonly SequencedFlight[]
  /** Holding traffic, lowest first: a hold is a vertical queue. */
  readonly stack: readonly StackedFlight[]
  /** Not in the sector yet, so not the controller's to sequence. */
  readonly inbound: readonly StackedFlight[]
}

/** True once the gap to the aircraft ahead is below what the pair needs. */
export function isTight(flight: SequencedFlight): boolean {
  return flight.gapNM !== null && flight.requiredNM !== null && flight.gapNM < flight.requiredNM
}

export function buildSequence(
  traffic: readonly Aircraft[],
  field: Vec2NM = FIELD,
): ArrivalSequence {
  // `entered` rather than a distance: the bay must not need to know where
  // the boundary is, and the flag is already the answer to this question.
  const arriving = traffic.filter((a) => !a.entered)
  const mine = traffic.filter((a) => a.entered)
  const holding = mine.filter((a) => a.navMode === 'HOLD')
  const working = mine.filter((a) => a.navMode !== 'HOLD')

  const byDistance = working
    .map((a) => ({ a, toFieldNM: distanceNM(a.pos, field) }))
    // Callsign breaks a tie, so the order cannot flicker between two
    // aircraft the same distance out.
    .sort((x, y) => x.toFieldNM - y.toFieldNM || x.a.callsign.localeCompare(y.a.callsign))

  const sequence: SequencedFlight[] = byDistance.map((entry, i) => {
    const ahead = byDistance[i - 1]
    return {
      aircraft: entry.a,
      position: i + 1,
      toFieldNM: entry.toFieldNM,
      gapNM: ahead === undefined ? null : entry.toFieldNM - ahead.toFieldNM,
      requiredNM: ahead === undefined ? null : requiredGapNM(ahead.a.wake, entry.a.wake),
    }
  })

  const stack = [...holding]
    .sort((a, b) => a.altFt - b.altFt || a.callsign.localeCompare(b.callsign))
    .map((a) => ({ aircraft: a, toFieldNM: distanceNM(a.pos, field) }))

  const inbound = [...arriving]
    .map((a) => ({ aircraft: a, toFieldNM: distanceNM(a.pos, field) }))
    .sort((x, y) => y.toFieldNM - x.toFieldNM || x.aircraft.callsign.localeCompare(y.aircraft.callsign))

  return { sequence, stack, inbound }
}

/** Everything the bay shows, in the order it shows it. */
export function sequenceOrder(built: ArrivalSequence): readonly Aircraft[] {
  return [...built.sequence, ...built.stack, ...built.inbound].map((f) => f.aircraft)
}
