import type { Vec2NM } from '../core/geo'
import type { Speed } from '../core/loop'
import type { Airport } from '../data/airport'
import type { Command } from '../commands/types'
import { conflictsIn } from '../sim/conflict'
import type { Aircraft } from '../sim/types'
import type { WeatherCell } from '../sim/weather'
import {
  advance,
  beginLesson,
  stepLabel,
  stepOf,
  withRefs,
  type EngineState,
  type TutorialEvent,
} from './engine'
import { holeAround, holeOfElement, TutorialOverlay, type Hole } from './overlay'
import { buildTraffic, buildWeather, refsOf } from './traffic'
import type { Failure, Spotlight, TutorialModule, TutorialStep } from './types'

/**
 * The lesson, running.
 *
 * Everything the engine cannot do, which is everything involving the world:
 * setting up the situation a step asks for, watching what the player does,
 * turning that into events, and putting the step back when it goes wrong.
 *
 * The host talks to the session through a handful of callbacks rather than
 * reaching into it. That is what keeps the change to main.ts small -- a
 * construction, five one-line observations and a suppression check -- and
 * it is also what makes it possible to run a whole lesson in a test with
 * nothing but a stub world.
 */

export interface TutorialWorld {
  readonly airport: Airport
  readonly traffic: () => readonly Aircraft[]
  readonly setTraffic: (traffic: readonly Aircraft[]) => void
  readonly setWeather: (cells: readonly WeatherCell[]) => void
  readonly setPaused: (paused: boolean) => void
  readonly setSpeed: (speed: Speed) => void
  readonly elapsedSeconds: () => number
  /** World position to viewport pixels, for spotlighting a target or a fix. */
  readonly screenOf: (at: Vec2NM) => { readonly x: number; readonly y: number }
  /** Redraw and re-sync the strips: the situation has changed underneath. */
  readonly changed: () => void
  readonly announce: (text: string, kind: 'note' | 'reject' | 'readback') => void
}

export interface TutorialSessionOptions {
  readonly module: TutorialModule
  readonly mount: HTMLElement
  readonly world: TutorialWorld
  /** Told when the lesson starts or stops, so the host can repaint a button. */
  readonly onRunning?: (running: boolean) => void
}

/** How big a hole a target gets: the symbol and its data block. */
const TARGET_HOLE_PX = 96
/** And a fix, which is a symbol and a name. */
const FIX_HOLE_PX = 72

export class TutorialSession {
  private readonly module: TutorialModule
  private readonly world: TutorialWorld
  private readonly overlay: TutorialOverlay
  private readonly onRunning: (running: boolean) => void
  private state: EngineState = beginLesson()
  private active = false
  /**
   * The traffic as it was when the step began.
   *
   * This is the whole of the reset: the aircraft are immutable values in an
   * array, so putting the situation back is putting the array back. No
   * separate snapshot format, and nothing that can drift out of step with
   * what an aircraft actually is.
   */
  private opening: readonly Aircraft[] = []
  private openingWeather: readonly WeatherCell[] = []

  constructor(opts: TutorialSessionOptions) {
    this.module = opts.module
    this.world = opts.world
    this.onRunning = opts.onRunning ?? ((): void => {})
    this.overlay = new TutorialOverlay({
      mount: opts.mount,
      onContinue: () => this.observe({ kind: 'continue' }),
      onExit: () => this.stop(),
    })
  }

  get running(): boolean {
    return this.active
  }

  /**
   * Whether the automatic traffic flows should be held back.
   *
   * A lesson puts a known situation in front of the player, and a spawner
   * releasing an unrelated arrival into the middle of it would break both
   * the instruction and the checkride's separation rule.
   */
  get suppressesTraffic(): boolean {
    return this.active
  }

  /** Visible for tests. */
  get element(): HTMLElement {
    return this.overlay.element
  }

  get stepIndex(): number {
    return this.state.step
  }

  get resets(): number {
    return this.state.resets
  }

  start(): void {
    this.active = true
    this.state = beginLesson()
    this.onRunning(true)
    this.enter(0)
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.overlay.hide()
    this.world.setWeather([])
    this.world.setPaused(true)
    this.onRunning(false)
    this.world.changed()
  }

  /* ------------------------------------------------------- observations */

  observeCommand(command: Command): void {
    this.observe({ kind: 'command', command })
  }

  observeSelect(callsign: string | null): void {
    this.observe({ kind: 'select', callsign })
  }

  observeSpeed(speed: number): void {
    this.observe({ kind: 'speed', speed })
  }

  /**
   * The world, once a sweep rather than once a tick.
   *
   * Twenty times a second is more often than any goal here can change and
   * would run the conflict scan twenty times a second with it.
   */
  observeTick(): void {
    if (!this.active) return
    const traffic = this.world.traffic()
    this.observe({ kind: 'tick', traffic, conflicts: conflictsIn(traffic) })
  }

  private observe(event: TutorialEvent): void {
    if (!this.active) return

    const before = this.state.step
    const outcome = advance(this.module, this.state, event)
    this.state = outcome.state

    if (outcome.reset !== null) {
      this.restart(outcome.reset)
      return
    }

    if (outcome.finished) {
      this.overlay.hide()
      this.active = false
      this.onRunning(false)
      this.world.announce(`${this.module.title}: complete`, 'readback')
      this.world.changed()
      return
    }

    if (outcome.entered !== null && outcome.entered !== before) {
      // Stop the clock on the way out of a step that asked for it. Before
      // the next step is set up rather than after, so a step that declares
      // its own clock state still wins -- the more specific instruction
      // should be the one that holds.
      if (this.module.steps[before]?.pauseOnGoal === true) this.world.setPaused(true)
      this.enter(outcome.entered)
      return
    }

    // The goal may be part met, and the counter is unchanged, but the card
    // still repaints: a step showing progress needs to say so.
    this.repaint()
  }

  /* ------------------------------------------------------------- steps */

  /** Arrive at a step: set the situation up, then say what to do. */
  private enter(index: number): void {
    const step = this.module.steps[index]
    if (step === undefined) return

    this.applyScene(step)
    this.opening = this.world.traffic()
    this.repaint()
    this.world.changed()

    // A step whose goal is already true on arrival -- one asking for a
    // state the world is in -- would otherwise sit there until something
    // unrelated happened. Nudging it with the world as it stands settles
    // that on the same frame.
    if (
      step.goal.kind === 'navMode' ||
      step.goal.kind === 'holding' ||
      step.goal.kind === 'allLanded'
    ) {
      this.observeTick()
    }
  }

  private applyScene(step: TutorialStep): void {
    const scene = step.scene
    if (scene === undefined) return
    const at = this.world.elapsedSeconds()

    if (scene.traffic !== undefined) {
      const built = buildTraffic(this.world.airport, scene.traffic, at)
      this.world.setTraffic(built)
      this.state = withRefs(this.state, refsOf(scene.traffic, built))
    }
    if (scene.weather !== undefined) {
      const cells = buildWeather(this.world.airport, scene.weather, at)
      this.openingWeather = cells
      this.world.setWeather(cells)
    }
    if (scene.speed !== undefined) this.world.setSpeed(scene.speed as Speed)
    if (scene.paused !== undefined) this.world.setPaused(scene.paused)
  }

  /**
   * Put the step back.
   *
   * The traffic as it was when the step opened, the weather likewise, and
   * the clock stopped -- because whatever went wrong happened while it was
   * running, and dropping the player straight back into the moving version
   * of the situation that just beat them is not a second chance.
   */
  private restart(why: Failure): void {
    this.world.setTraffic(this.opening)
    this.world.setWeather(this.openingWeather)
    this.world.setPaused(true)
    this.repaint()
    this.overlay.toast(
      why === 'conflict'
        ? 'Step reset -- separation lost. The situation has been put back.'
        : 'Step reset -- the approach was missed. The situation has been put back.',
    )
    this.world.announce(
      why === 'conflict' ? 'step reset: separation lost' : 'step reset: missed approach',
      'reject',
    )
    this.world.changed()
  }

  private repaint(): void {
    const step = stepOf(this.module, this.state)
    if (step === null) return
    this.overlay.show({
      title: step.title,
      counter: stepLabel(this.module, this.state),
      text: step.text,
      button: step.button ?? null,
    })
  }

  /* --------------------------------------------------------- the holes */

  /**
   * Where the mask's holes go, this frame.
   *
   * Called from the render loop rather than kept up to date by events,
   * because two of the four kinds of spotlight follow something that moves:
   * an aircraft flies and the camera pans, and either one puts a hole in
   * the wrong place the instant it is not recomputed.
   */
  layout(): void {
    if (!this.active) return
    const step = stepOf(this.module, this.state)
    if (step === null) return
    this.overlay.place(this.holesFor(step.spotlight))
  }

  private holesFor(spotlight: Spotlight): readonly Hole[] {
    switch (spotlight.kind) {
      case 'none':
        return []

      case 'scope': {
        // The picture itself, which is a hole the size of the canvas: the
        // display is what is being talked about, so nothing is dimmed.
        const hole = holeOfElement('canvas')
        return hole === null ? [] : [hole]
      }

      case 'element': {
        const hole = holeOfElement(spotlight.selector)
        return hole === null ? [] : [hole]
      }

      case 'elements':
        return spotlight.selectors
          .map((s) => holeOfElement(s))
          .filter((h): h is Hole => h !== null)

      case 'aircraft': {
        const callsign = this.state.refs[spotlight.ref] ?? spotlight.ref
        const aircraft = this.world.traffic().find((a) => a.callsign === callsign)
        if (aircraft === undefined) return []
        return [holeAround(this.world.screenOf(aircraft.pos), TARGET_HOLE_PX)]
      }

      case 'fix': {
        const navaid = this.world.airport.navaids.find((n) => n.name === spotlight.name)
        if (navaid === undefined) return []
        return [holeAround(this.world.screenOf(navaid.posNM), FIX_HOLE_PX)]
      }
    }
  }
}
