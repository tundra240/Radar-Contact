import type { Command } from '../commands/types'
import type { Conflict } from '../sim/conflict'
import { holdLeg } from '../sim/hold'
import type { Aircraft } from '../sim/types'
import type { Failure, Goal, TutorialModule, TutorialStep } from './types'

/**
 * The lesson state machine.
 *
 * Pure, and deliberately so: it takes the module, the state and one event,
 * and returns the next state. It touches no DOM, holds no simulation and
 * schedules nothing, which is what makes a sixteen-step lesson testable
 * without a browser or a running clock.
 *
 * The host in session.ts does everything this cannot: it watches the world,
 * turns what it sees into events, and carries out what the new step asks
 * for. The division is worth keeping sharp -- every time a rule about *what
 * counts as progress* has leaked into a UI file in this codebase it has
 * become untestable.
 */

/** What the engine is told about. */
export type TutorialEvent =
  /** The button on the card. */
  | { readonly kind: 'continue' }
  | { readonly kind: 'select'; readonly callsign: string | null }
  /** A clearance that was accepted. Refused ones are not progress. */
  | { readonly kind: 'command'; readonly command: Command }
  | { readonly kind: 'speed'; readonly speed: number }
  /**
   * The player asked to move on without doing this step.
   *
   * Satisfies whatever the step wanted, whole. The session performs the
   * step's actual effect on the world first -- see TutorialSession.skip --
   * so this is only the bookkeeping half.
   */
  | { readonly kind: 'skip' }
  /** The world, as often as the host cares to offer it. */
  | {
      readonly kind: 'tick'
      readonly traffic: readonly Aircraft[]
      readonly conflicts: readonly Conflict[]
    }

export interface EngineState {
  readonly step: number
  /**
   * The leaves satisfied so far on this step, in the order they were.
   *
   * Order is kept because `inOrder` needs it -- "vector it, then hand it
   * back" is a different lesson from "hand it back, then vector it" -- and
   * a set would have thrown away exactly the fact that distinguishes them.
   */
  readonly met: readonly string[]
  /** Scripted refs resolved to the callsigns they were given. */
  readonly refs: Readonly<Record<string, string>>
  /** How many times a step has had to be started again. */
  readonly resets: number
  readonly finished: boolean
}

export interface Outcome {
  readonly state: EngineState
  /** The step index just arrived at, or null if the step did not change. */
  readonly entered: number | null
  /** Why the step was restarted, or null. */
  readonly reset: Failure | null
  /** True on the transition that ends the lesson, once. */
  readonly finished: boolean
}

export function beginLesson(): EngineState {
  return { step: 0, met: [], refs: {}, resets: 0, finished: false }
}

/** The step being shown, or null once the lesson is over. */
export function stepOf(module: TutorialModule, state: EngineState): TutorialStep | null {
  if (state.finished) return null
  return module.steps[state.step] ?? null
}

/* ----------------------------------------------------------- the goals */

/**
 * A leaf goal's identity, for recording that it has been met.
 *
 * The shape itself, serialised. Two leaves that ask for the same thing are
 * the same requirement, which is the behaviour wanted: a step asking for
 * heading 090 twice is asking for it once.
 */
export function leafKey(goal: Goal): string {
  return JSON.stringify(goal)
}

/** Every leaf under a goal, left to right. */
export function leavesOf(goal: Goal): readonly Goal[] {
  if (goal.kind === 'every' || goal.kind === 'inOrder') {
    return goal.of.flatMap((g) => leavesOf(g))
  }
  return [goal]
}

/**
 * Whether the recorded progress satisfies the goal.
 *
 * `inOrder` asks whether its leaves appear in `met` as a subsequence rather
 * than as a block, so an instruction the player carried out with something
 * else in between still counts. Requiring them to be consecutive would fail
 * a player who selected the aircraft between the two halves of the task.
 */
export function isMet(goal: Goal, met: readonly string[]): boolean {
  if (goal.kind === 'every') return goal.of.every((g) => isMet(g, met))
  if (goal.kind === 'inOrder') {
    let at = 0
    for (const leaf of goal.of) {
      const found = met.indexOf(leafKey(leaf), at)
      if (found === -1) return false
      at = found + 1
    }
    return true
  }
  return met.includes(leafKey(goal))
}

/** Progress as a fraction, for a step that asks for more than one thing. */
export function progressOf(goal: Goal, met: readonly string[]): {
  readonly done: number
  readonly total: number
} {
  const leaves = leavesOf(goal)
  return {
    done: leaves.filter((l) => met.includes(leafKey(l))).length,
    total: leaves.length,
  }
}

/* --------------------------------------------------------- the matching */

/** Which aircraft a goal is about, or null when it will take any. */
function wanted(goal: Goal, refs: Readonly<Record<string, string>>): string | null {
  const ref = 'ref' in goal ? goal.ref : undefined
  if (ref === undefined) return null
  return refs[ref] ?? ref
}

/** Whether a callsign is the one this goal is about. */
function isTheOne(goal: Goal, refs: Readonly<Record<string, string>>, callsign: string): boolean {
  const want = wanted(goal, refs)
  return want === null || want === callsign
}

/**
 * Whether this event satisfies this leaf.
 *
 * Commands are matched on what was asked for rather than on what the
 * aircraft then did, because the lesson is teaching the instruction. An
 * aircraft told to descend to 3,000 ft has been descended to 3,000 ft
 * whether or not it has got there yet.
 */
export function satisfies(
  goal: Goal,
  event: TutorialEvent,
  refs: Readonly<Record<string, string>>,
): boolean {
  switch (goal.kind) {
    case 'continue':
      return event.kind === 'continue'

    case 'speed':
      return event.kind === 'speed' && event.speed === goal.to

    case 'select':
      return (
        event.kind === 'select' &&
        event.callsign !== null &&
        isTheOne(goal, refs, event.callsign)
      )

    case 'heading':
      return (
        event.kind === 'command' &&
        event.command.kind === 'heading' &&
        isTheOne(goal, refs, event.command.callsign) &&
        // Rounded, because a heading dragged with the mouse lands on a
        // degree either side of the one being taught and the lesson is
        // about the turn, not about the last digit.
        Math.abs(angleGap(event.command.deg, goal.deg)) <= HEADING_SLOP_DEG
      )

    case 'vector':
      return (
        event.kind === 'command' &&
        event.command.kind === 'heading' &&
        isTheOne(goal, refs, event.command.callsign)
      )

    case 'altitude':
      return (
        event.kind === 'command' &&
        event.command.kind === 'altitude' &&
        isTheOne(goal, refs, event.command.callsign) &&
        event.command.ft === goal.ft
      )

    case 'airspeed':
      return (
        event.kind === 'command' &&
        event.command.kind === 'speed' &&
        isTheOne(goal, refs, event.command.callsign) &&
        event.command.kts === goal.kts
      )

    case 'approach':
      return (
        event.kind === 'command' &&
        event.command.kind === 'approach' &&
        isTheOne(goal, refs, event.command.callsign)
      )

    case 'resumeNav':
      return (
        event.kind === 'command' &&
        event.command.kind === 'resumeNav' &&
        isTheOne(goal, refs, event.command.callsign)
      )

    case 'navMode':
      return (
        event.kind === 'tick' &&
        event.traffic.some(
          (a) => a.navMode === goal.mode && isTheOne(goal, refs, a.callsign),
        )
      )

    case 'holding':
      return (
        event.kind === 'tick' &&
        event.traffic.some(
          (a) =>
            isTheOne(goal, refs, a.callsign) &&
            a.navMode === 'HOLD' &&
            a.hold !== null &&
            // 'joining' is the leg an aircraft is on while it is still on
            // its way to the fix, which is exactly the state this waits out.
            holdLeg(a, a.hold) !== 'joining',
        )
      )

    case 'allLanded': {
      if (event.kind !== 'tick') return false
      const scripted = Object.values(refs)
      if (scripted.length === 0) return false
      // Gone from the display counts as landed here: the world removes an
      // aircraft the moment it touches down, so an arrival that has landed
      // is one that is no longer there to be found.
      return scripted.every((callsign) => {
        const still = event.traffic.find((a) => a.callsign === callsign)
        return still === undefined || still.navMode === 'LANDED'
      })
    }

    // Composites are never matched directly; leavesOf takes them apart.
    case 'every':
    case 'inOrder':
      return false
  }
}

/** How far apart two headings are, signed, shortest way round. */
function angleGap(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

/** A dragged vector lands a degree or two off the one being taught. */
export const HEADING_SLOP_DEG = 5

/* --------------------------------------------------------- the machine */

/**
 * One event, one step forward.
 *
 * The order here is the rule: a failure is looked at before progress is,
 * so a step that both loses separation and meets its goal on the same tick
 * restarts rather than passes. Rewarding a breach because the aeroplane
 * happened to land afterwards would teach precisely the wrong thing.
 */
export function advance(
  module: TutorialModule,
  state: EngineState,
  event: TutorialEvent,
): Outcome {
  const still = { state, entered: null, reset: null, finished: false } as const
  if (state.finished) return still

  const step = module.steps[state.step]
  if (step === undefined) return still

  const failure = failureIn(step, event)
  if (failure !== null) {
    return {
      // Back to the start of this step: progress on it is discarded along
      // with the situation that produced it.
      state: { ...state, met: [], resets: state.resets + 1 },
      entered: state.step,
      reset: failure,
      finished: false,
    }
  }

  const met = record(step.goal, state, event)
  if (met === state.met) return still

  const next = { ...state, met }
  if (!isMet(step.goal, met)) {
    return { state: next, entered: null, reset: null, finished: false }
  }

  const index = state.step + 1
  if (index >= module.steps.length) {
    return {
      state: { ...next, finished: true },
      entered: null,
      reset: null,
      finished: true,
    }
  }
  return {
    // A new step starts with nothing met and the refs it inherits, which
    // the host replaces if the step brings its own traffic.
    state: { ...next, step: index, met: [] },
    entered: index,
    reset: null,
    finished: false,
  }
}

/** The leaves this event newly satisfies, appended. */
function record(
  goal: Goal,
  state: EngineState,
  event: TutorialEvent,
): readonly string[] {
  // A skip meets everything at once, in order, so an inOrder goal is
  // satisfied rather than half-done.
  if (event.kind === 'skip') return leavesOf(goal).map((leaf) => leafKey(leaf))

  let met = state.met
  for (const leaf of leavesOf(goal)) {
    const key = leafKey(leaf)
    if (met.includes(key)) continue
    if (!satisfies(leaf, event, state.refs)) continue
    met = [...met, key]
  }
  return met
}

/** Whether this event is the sort of thing that restarts the step. */
function failureIn(step: TutorialStep, event: TutorialEvent): Failure | null {
  const watched = step.resetOn ?? []
  if (watched.length === 0 || event.kind !== 'tick') return null

  if (watched.includes('conflict') && event.conflicts.length > 0) return 'conflict'
  if (watched.includes('goAround') && event.traffic.some((a) => a.navMode === 'GO_AROUND')) {
    return 'goAround'
  }
  return null
}

/** Names the scripted aircraft of the step just entered. */
export function withRefs(
  state: EngineState,
  refs: Readonly<Record<string, string>>,
): EngineState {
  return { ...state, refs }
}

/** "Step 4 of 16", which is most of what tells a player where they are. */
export function stepLabel(module: TutorialModule, state: EngineState): string {
  const shown = Math.min(state.step + 1, module.steps.length)
  return `Step ${shown} of ${module.steps.length}`
}
