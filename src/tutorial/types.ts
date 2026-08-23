import type { NavMode } from '../sim/types'

/**
 * What a lesson is made of.
 *
 * The whole point of this file is that a lesson is *data*. A new module --
 * position handoffs, a runway flip, a busy-period checkride -- is a list of
 * steps in a config file and nothing else: no new engine code, no new
 * simulation code, no new components. Everything a step can ask for is
 * enumerated here, and the engine in engine.ts and the host in session.ts
 * between them know how to do all of it.
 *
 * That constraint is what keeps the system honest. If a lesson needs a
 * capability, the capability goes here as a case and every lesson gets it,
 * rather than one lesson growing a bespoke hook that nothing else can use.
 */

/* ------------------------------------------------------------ spotlight */

/**
 * What the mask cuts a hole around.
 *
 * Four kinds, because the things a lesson needs to point at are of four
 * different sorts and only the first is a DOM node. An aircraft moves every
 * tick and a fix is a position in world space, so the hole for those has to
 * be computed against the camera rather than read off an element.
 */
export type Spotlight =
  | { readonly kind: 'none' }
  /** A control, by CSS selector. */
  | { readonly kind: 'element'; readonly selector: string }
  /** More than one control at once, e.g. an aircraft and the rate button. */
  | { readonly kind: 'elements'; readonly selectors: readonly string[] }
  /** A scripted aircraft, by the ref the step gave it. */
  | { readonly kind: 'aircraft'; readonly ref: string }
  /** A published navaid, by name. */
  | { readonly kind: 'fix'; readonly name: string }
  /** The whole picture, which is a hole with nothing dark in it. */
  | { readonly kind: 'scope' }

/* ---------------------------------------------------------------- goals */

/**
 * What the player has to do to move on.
 *
 * Leaves are the things that can actually happen; `every` and `inOrder`
 * combine them. Splitting composition out like this is what lets the engine
 * track partial progress -- "you have set the altitude, now the speed" --
 * without every goal kind having to know how.
 *
 * `ref` names a scripted aircraft where it matters. Omitted, the goal is
 * satisfied by any aircraft, which is what a general instruction wants.
 */
export type Goal =
  /** The button. Nothing to do but read it. */
  | { readonly kind: 'continue' }
  | { readonly kind: 'speed'; readonly to: number }
  | { readonly kind: 'select'; readonly ref?: string }
  | { readonly kind: 'heading'; readonly deg: number; readonly ref?: string }
  /** Any heading at all: "vector it off track", direction unimportant. */
  | { readonly kind: 'vector'; readonly ref?: string }
  | { readonly kind: 'altitude'; readonly ft: number; readonly ref?: string }
  | { readonly kind: 'airspeed'; readonly kts: number; readonly ref?: string }
  | { readonly kind: 'approach'; readonly ref?: string }
  | { readonly kind: 'resumeNav'; readonly ref?: string }
  /** A state the simulation reaches on its own. */
  | { readonly kind: 'navMode'; readonly mode: NavMode; readonly ref?: string }
  /**
   * Established in the pattern, which is not the same as carrying one.
   *
   * An arrival is released already holding -- `navMode` is HOLD from the
   * moment it appears, while it is still twenty miles from its fix tracking
   * towards it. A lesson step that waited on the mode would therefore be
   * satisfied before the aeroplane had gone anywhere, and the racetrack the
   * step exists to show would never be seen. This waits for the aircraft to
   * actually be flying a leg of it.
   */
  | { readonly kind: 'holding'; readonly ref?: string }
  /** Every scripted aircraft on this step landed. */
  | { readonly kind: 'allLanded' }
  /** All of these, in any order. */
  | { readonly kind: 'every'; readonly of: readonly Goal[] }
  /** All of these, in this order. */
  | { readonly kind: 'inOrder'; readonly of: readonly Goal[] }

/* ---------------------------------------------------------------- scene */

/**
 * An aircraft a step puts on the scope.
 *
 * Placed relative to a published fix rather than at a coordinate, so a
 * lesson never carries a position that would have to be maintained
 * alongside the airport data.
 */
export interface ScriptedAircraft {
  /** How goals and spotlights in this lesson refer to it. */
  readonly ref: string
  readonly kind: 'arrival' | 'overflight'
  /** The fix it arrives over, for an arrival. */
  readonly fix?: string
  /** The corridor it crosses on, for a transit. */
  readonly corridor?: string
  readonly altFt: number
  readonly iasKts: number
  /** How far before the fix it appears. The spawner's own figure by default. */
  readonly beforeNM?: number
  /** Fixed, so a lesson reads the same every time it is taken. */
  readonly callsign?: string
  readonly type?: string
}

/** A storm a step puts on the scope, over a named fix. */
export interface ScriptedStorm {
  readonly overFix: string
  readonly radiusNM: number
  /** 0..1. Above two thirds is a red core. */
  readonly peak: number
  readonly lifeMinutes: number
}

/**
 * The world a step wants to find in front of it.
 *
 * Every field is optional and an absent one means "leave it alone", so a
 * step that only changes the instruction text says nothing about traffic
 * and inherits whatever the previous step left flying.
 */
export interface Scene {
  /** Replaces the traffic. An empty array clears the scope. */
  readonly traffic?: readonly ScriptedAircraft[]
  /** Replaces the hand-placed weather. An empty array clears it. */
  readonly weather?: readonly ScriptedStorm[]
  readonly paused?: boolean
  readonly speed?: number
}

/* ---------------------------------------------------------------- steps */

/** What can go wrong badly enough to be worth starting the step again. */
export type Failure = 'conflict' | 'goAround'

export interface TutorialStep {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly spotlight: Spotlight
  readonly goal: Goal
  /** The button's words, or null for a step with no button. */
  readonly button?: string | null
  /** What to set up on arriving at this step. */
  readonly scene?: Scene
  /** Stop the clock the moment the goal is met, before moving on. */
  readonly pauseOnGoal?: boolean
  /**
   * What restarts the step.
   *
   * Empty for the early steps: losing separation is impossible with one
   * aircraft on the scope, and a lesson that could reset itself while the
   * player was reading would be worse than one that could not.
   */
  readonly resetOn?: readonly Failure[]
}

export interface TutorialModule {
  readonly id: string
  readonly title: string
  /** One line, for a menu of lessons. */
  readonly summary: string
  readonly steps: readonly TutorialStep[]
}
