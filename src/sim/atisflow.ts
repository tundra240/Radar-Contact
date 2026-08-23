import type { Wind } from './weather'
import type { AtisBehaviour, DifficultySettings } from './difficulty'
import {
  bestDirection,
  configurationsFor,
  directionsOf,
  shouldFlip,
  type Atis,
  type RunwayFace,
} from './atis'

/**
 * What makes the runway direction change, and when.
 *
 * The ATIS has always known how to flip -- atis.ts works out which
 * direction the wind favours and what the configuration should be -- but
 * nothing ever asked it to. The board was whatever it was set to at logon
 * and stayed there.
 *
 * This is the thing that asks. It is a small state machine rather than a
 * line in the tick loop because the interesting part is not the flip, it is
 * the notice: a change announced two minutes before it happens is a
 * different problem from one announced ten minutes before, and that gap is
 * what separates the hardest setting from the middle one.
 *
 * Simulated time throughout, so it follows the rate control and stops when
 * the clock does.
 */

/** Where the flow is in the cycle of announcing and then doing. */
export interface AtisFlowState {
  /** Seconds until the next review of the wind. */
  readonly untilReview: number
  /**
   * A change announced and not yet in force, with the seconds left on it.
   *
   * Null when nothing is pending, which is nearly always.
   */
  readonly pending: PendingChange | null
  /** How many times the field has turned round this session. */
  readonly flips: number
}

export interface PendingChange {
  readonly arrivals: readonly string[]
  readonly departures: readonly string[]
  readonly inSeconds: number
}

/** What the flow wants done, this step. */
export interface AtisFlowOutcome {
  readonly state: AtisFlowState
  /** Announce that the field is about to turn round. */
  readonly announce: PendingChange | null
  /** Put a previously announced change into force now. */
  readonly apply: PendingChange | null
}

/**
 * How often the wind is looked at.
 *
 * Not every tick: a runway direction that changed the instant the wind
 * wandered over the limit would flap, and a real unit reviews it rather
 * than tracking it continuously.
 */
const REVIEW_SECONDS = 240

export function beginAtisFlow(): AtisFlowState {
  return {
    // The first review is a full period away, so a session never opens by
    // immediately announcing a change to a field nobody has worked yet.
    untilReview: REVIEW_SECONDS,
    pending: null,
    flips: 0,
  }
}

/**
 * Whether this setting ever turns the field round.
 *
 * Locked is the gentlest: one runway for the session, so a new controller
 * learns one picture rather than two.
 */
export function everFlips(behaviour: AtisBehaviour): boolean {
  return behaviour !== 'locked'
}

/**
 * One step of the flow.
 *
 * `wind` is what the weather is doing now, which on the harder settings
 * wanders as the session runs -- so the review has something to find.
 */
export function stepAtisFlow(
  state: AtisFlowState,
  dtSeconds: number,
  atis: Atis,
  runways: readonly RunwayFace[],
  wind: Wind,
  settings: DifficultySettings,
): AtisFlowOutcome {
  const still: AtisFlowOutcome = { state, announce: null, apply: null }
  if (!everFlips(settings.atis)) return still

  const dt = Math.max(0, dtSeconds)

  // A change already announced: count it down and put it in when it is due.
  if (state.pending !== null) {
    const left = state.pending.inSeconds - dt
    if (left > 0) {
      return {
        state: { ...state, pending: { ...state.pending, inSeconds: left } },
        announce: null,
        apply: null,
      }
    }
    return {
      state: { untilReview: REVIEW_SECONDS, pending: null, flips: state.flips + 1 },
      announce: null,
      apply: state.pending,
    }
  }

  const untilReview = state.untilReview - dt
  if (untilReview > 0) return { state: { ...state, untilReview }, announce: null, apply: null }

  const wanted = nextConfiguration(atis, runways, wind, settings.atis)
  if (wanted === null) {
    return { state: { ...state, untilReview: REVIEW_SECONDS }, announce: null, apply: null }
  }

  const pending: PendingChange = { ...wanted, inSeconds: Math.max(0, settings.atisNoticeSeconds) }
  return {
    state: { ...state, untilReview: REVIEW_SECONDS, pending },
    announce: pending,
    apply: null,
  }
}

/**
 * The configuration this review wants, or null to leave it alone.
 *
 * `timed` turns the field round on the clock whether the wind justifies it
 * or not -- which is not what a real unit does, and is exactly why it is
 * the middle setting: it teaches that the runway can change from under you
 * before it teaches you to see it coming in the wind.
 */
function nextConfiguration(
  atis: Atis,
  runways: readonly RunwayFace[],
  wind: Wind,
  behaviour: AtisBehaviour,
): { readonly arrivals: readonly string[]; readonly departures: readonly string[] } | null {
  if (runways.length === 0) return null

  if (behaviour === 'timed') {
    // Straight to the other direction, whatever the wind says.
    const other = otherDirection(atis, runways)
    if (other === null) return null
    const wanted = configurationsFor(other)[0]
    if (wanted === undefined || sameAs(atis, wanted)) return null
    return wanted
  }

  // Weather-driven, which is the real rule: only once the wind has gone
  // round far enough to put a tailwind on the runway in use.
  if (!shouldFlip(atis, runways, wind)) return null
  const bestIds = bestDirection(runways, wind)
  const faces = runways.filter((r) => bestIds.includes(r.id))
  if (faces.length === 0) return null
  const wanted = configurationsFor(faces)[0]
  if (wanted === undefined || sameAs(atis, wanted)) return null
  return wanted
}

/**
 * The group of runways facing the other way, for the timed behaviour.
 *
 * Grouped by bearing rather than by name, which is how atis.ts thinks about
 * a "direction": 27L and 27R are one, 09L and 09R are the other.
 */
function otherDirection(atis: Atis, runways: readonly RunwayFace[]): RunwayFace[] | null {
  const groups = directionsOf(runways)
  if (groups.length < 2) return null
  const active = groups.findIndex((g) => g.some((r) => atis.arrivals.includes(r.id)))
  if (active === -1) return groups[0] ?? null
  return groups[(active + 1) % groups.length] ?? null
}

function sameAs(
  atis: Atis,
  wanted: { readonly arrivals: readonly string[]; readonly departures: readonly string[] },
): boolean {
  return (
    atis.arrivals.length === wanted.arrivals.length &&
    atis.arrivals.every((r, i) => r === wanted.arrivals[i]) &&
    atis.departures.length === wanted.departures.length &&
    atis.departures.every((r, i) => r === wanted.departures[i])
  )
}
