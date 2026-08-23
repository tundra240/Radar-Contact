// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Speed } from '../core/loop'
import { loadAirport } from '../data/airport'
import raw from '../data/egll.json'
import type { Aircraft } from '../sim/types'
import type { WeatherCell } from '../sim/weather'
import { BASICS } from './lessons/basics'
import { TutorialSession, type TutorialWorld } from './session'
import type { TutorialModule } from './types'

const airport = loadAirport(raw)

/**
 * A world that records what the lesson does to it.
 *
 * This is the whole reason the session takes callbacks rather than reaching
 * into main.ts: a sixteen-step lesson can be driven to the end here with no
 * canvas, no clock and no render loop.
 */
function stubWorld(): TutorialWorld & {
  readonly state: {
    traffic: readonly Aircraft[]
    weather: readonly WeatherCell[]
    paused: boolean
    speed: Speed
    changes: number
    said: string[]
  }
} {
  const state = {
    traffic: [] as readonly Aircraft[],
    weather: [] as readonly WeatherCell[],
    paused: false,
    speed: 1 as Speed,
    changes: 0,
    said: [] as string[],
  }
  return {
    state,
    airport,
    traffic: () => state.traffic,
    setTraffic: (t) => {
      state.traffic = t
    },
    setWeather: (c) => {
      state.weather = c
    },
    setPaused: (p) => {
      state.paused = p
    },
    setSpeed: (s) => {
      state.speed = s
    },
    elapsedSeconds: () => 0,
    screenOf: (at) => ({ x: 400 + at.x * 8, y: 300 - at.y * 8 }),
    changed: () => {
      state.changes += 1
    },
    announce: (text) => {
      state.said.push(text)
    },
  }
}

function session(module: TutorialModule = BASICS): {
  readonly tutorial: TutorialSession
  readonly world: ReturnType<typeof stubWorld>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const world = stubWorld()
  return { tutorial: new TutorialSession({ module, mount: host, world }), world }
}

/** The callsign a scripted ref ended up with, read off the world. */
function callsignOf(world: ReturnType<typeof stubWorld>, at = 0): string {
  return world.state.traffic[at]?.callsign ?? ''
}

/**
 * Put the scripted arrival into its pattern.
 *
 * Being established is not the same as carrying a hold: an arrival is
 * released already holding, twenty miles out and tracking towards its fix.
 * Moving it onto the fix is what makes it actually established.
 */
function establish(world: ReturnType<typeof stubWorld>): void {
  world.setTraffic(
    world.state.traffic.map((a) =>
      a.hold === null ? a : { ...a, pos: a.hold.posNM, hdg: a.hold.inboundTrue },
    ),
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('starting and stopping', () => {
  it('is not running until it is started', () => {
    const { tutorial } = session()
    expect(tutorial.running).toBe(false)
    expect(tutorial.suppressesTraffic).toBe(false)
  })

  it('sets the first step up on starting', () => {
    const { tutorial, world } = session()
    tutorial.start()
    expect(tutorial.running).toBe(true)
    // The lesson opens on a clear, stopped scope: dropped into whatever
    // traffic the session had accumulated it would be a different lesson
    // every time.
    expect(world.state.paused).toBe(true)
    expect(world.state.traffic).toEqual([])
    expect(world.state.weather).toEqual([])
  })

  it('holds the automatic traffic back while it runs', () => {
    // The one thing that would break every scripted step at once.
    const { tutorial } = session()
    tutorial.start()
    expect(tutorial.suppressesTraffic).toBe(true)
    tutorial.stop()
    expect(tutorial.suppressesTraffic).toBe(false)
  })

  it('takes its weather away again on stopping', () => {
    // The session's own weather is a function of its seed and is untouched;
    // the lesson's storm is not allowed to outlive the lesson.
    const { tutorial, world } = session()
    tutorial.start()
    world.setWeather([{ originNM: { x: 0, y: 0 } } as WeatherCell])
    tutorial.stop()
    expect(world.state.weather).toEqual([])
  })

  it('shows the card while it runs and takes it away after', () => {
    const { tutorial } = session()
    tutorial.start()
    expect(tutorial.element.hidden).toBe(false)
    expect(tutorial.element.querySelector('.tutorial-counter')?.textContent).toBe(
      `Step 1 of ${BASICS.steps.length}`,
    )
    tutorial.stop()
    expect(tutorial.element.hidden).toBe(true)
  })
})

describe('working through the lesson', () => {
  it('advances on the button and counts up', () => {
    const { tutorial } = session()
    tutorial.start()
    tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    expect(tutorial.stepIndex).toBe(1)
    expect(tutorial.element.querySelector('.tutorial-counter')?.textContent).toBe(
      `Step 2 of ${BASICS.steps.length}`,
    )
  })

  it('puts the inbound on the scope when its step arrives', () => {
    const { tutorial, world } = session()
    tutorial.start()
    // Two buttons: welcome, then the time controls.
    const press = (): void =>
      void tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    press()
    press()
    expect(world.state.traffic).toHaveLength(1)
    expect(callsignOf(world)).toBe('BAW214')
    expect(world.state.traffic[0]?.navMode).toBe('HOLD')
    // And the clock is running, since the step asks for it to be wound on.
    expect(world.state.paused).toBe(false)
  })

  it('advances the rate step only at 4x', () => {
    const { tutorial } = session()
    tutorial.start()
    const press = (): void =>
      void tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    press()
    press()
    const at = tutorial.stepIndex
    tutorial.observeSpeed(2)
    expect(tutorial.stepIndex).toBe(at)
    tutorial.observeSpeed(4)
    expect(tutorial.stepIndex).toBe(at + 1)
  })

  it('stops the clock when the aircraft reaches the hold', () => {
    // The step asks for it, so the pattern can be looked at rather than
    // flown past while the instruction is being read.
    const { tutorial, world } = session()
    tutorial.start()
    const press = (): void =>
      void tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    press()
    press()
    tutorial.observeSpeed(4)
    // Not yet: it is carrying a hold but is still miles from its fix, which
    // is the distinction the step is waiting on.
    tutorial.observeTick()
    expect(world.state.paused).toBe(false)
    // Established, and now it stops.
    establish(world)
    tutorial.observeTick()
    expect(world.state.paused).toBe(true)
  })

  it('runs the whole lesson to the end', () => {
    // The point of the whole thing: sixteen steps, every goal reachable,
    // and it finishes rather than sticking. A step that could never be
    // satisfied would hang here rather than in front of a player.
    const { tutorial, world } = session()
    tutorial.start()

    const press = (): void =>
      void tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()

    let guard = 0
    while (tutorial.running && guard < 200) {
      guard += 1
      const step = BASICS.steps[tutorial.stepIndex]
      if (step === undefined) break
      const target = callsignOf(world)

      switch (step.goal.kind) {
        case 'continue':
          press()
          break
        case 'speed':
          tutorial.observeSpeed(step.goal.to)
          break
        case 'select':
          tutorial.observeSelect(target)
          break
        case 'navMode':
          tutorial.observeTick()
          break
        case 'holding':
          establish(world)
          tutorial.observeTick()
          break
        case 'every':
          // Descent and speed, in either order.
          tutorial.observeCommand({ kind: 'altitude', callsign: target, ft: 3000 })
          tutorial.observeCommand({ kind: 'speed', callsign: target, kts: 180 })
          break
        case 'inOrder':
          for (const leaf of step.goal.of) {
            if (leaf.kind === 'heading') {
              tutorial.observeCommand({ kind: 'heading', callsign: target, deg: leaf.deg })
            } else if (leaf.kind === 'vector') {
              tutorial.observeCommand({ kind: 'heading', callsign: target, deg: 200 })
            } else if (leaf.kind === 'resumeNav') {
              tutorial.observeCommand({ kind: 'resumeNav', callsign: target })
            }
          }
          break
        case 'heading':
          tutorial.observeCommand({ kind: 'heading', callsign: target, deg: step.goal.deg })
          break
        case 'approach':
          tutorial.observeCommand({ kind: 'approach', callsign: target, runway: '27R' })
          break
        case 'allLanded':
          // Land them all: the world removes an aircraft as it touches down.
          world.setTraffic([])
          tutorial.observeTick()
          break
        default:
          throw new Error(`nothing in the test drives a ${step.goal.kind} goal`)
      }
    }

    expect(guard).toBeLessThan(200)
    expect(tutorial.running).toBe(false)
    expect(world.state.said.some((s) => s.includes('complete'))).toBe(true)
  })
})

describe('when a step goes wrong', () => {
  /** Straight to the checkride, which is the step that watches for a breach. */
  function atCheckride(): ReturnType<typeof session> {
    const it = session()
    it.tutorial.start()
    const press = (): void =>
      void it.tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    let guard = 0
    while (BASICS.steps[it.tutorial.stepIndex]?.id !== 'checkride' && guard < 100) {
      guard += 1
      const step = BASICS.steps[it.tutorial.stepIndex]
      if (step === undefined) break
      const target = callsignOf(it.world)
      switch (step.goal.kind) {
        case 'continue':
          press()
          break
        case 'speed':
          it.tutorial.observeSpeed(step.goal.to)
          break
        case 'select':
          it.tutorial.observeSelect(target)
          break
        case 'navMode':
          it.tutorial.observeTick()
          break
        case 'holding':
          establish(it.world)
          it.tutorial.observeTick()
          break
        case 'every':
          it.tutorial.observeCommand({ kind: 'altitude', callsign: target, ft: 3000 })
          it.tutorial.observeCommand({ kind: 'speed', callsign: target, kts: 180 })
          break
        case 'inOrder':
          for (const leaf of step.goal.of) {
            if (leaf.kind === 'heading') {
              it.tutorial.observeCommand({ kind: 'heading', callsign: target, deg: leaf.deg })
            } else if (leaf.kind === 'vector') {
              it.tutorial.observeCommand({ kind: 'heading', callsign: target, deg: 200 })
            } else if (leaf.kind === 'resumeNav') {
              it.tutorial.observeCommand({ kind: 'resumeNav', callsign: target })
            }
          }
          break
        case 'heading':
          it.tutorial.observeCommand({ kind: 'heading', callsign: target, deg: step.goal.deg })
          break
        case 'approach':
          it.tutorial.observeCommand({ kind: 'approach', callsign: target, runway: '27R' })
          break
        default:
          throw new Error(`stuck on ${step.id}`)
      }
    }
    return it
  }

  it('puts the traffic back where the step began', () => {
    const { tutorial, world } = atCheckride()
    expect(BASICS.steps[tutorial.stepIndex]?.id).toBe('checkride')
    const opened = world.state.traffic
    expect(opened).toHaveLength(3)

    // Fly them into each other, then let the lesson look at the world.
    const [a, b, c] = opened
    world.setTraffic([
      { ...(a as Aircraft), entered: true, pos: { x: 0, y: 0 }, altFt: 7000 },
      { ...(b as Aircraft), entered: true, pos: { x: 1, y: 0 }, altFt: 7200 },
      c as Aircraft,
    ])
    tutorial.observeTick()

    expect(tutorial.resets).toBe(1)
    // Back to the situation the step opened with, aeroplane for aeroplane.
    expect(world.state.traffic).toEqual(opened)
    // And stopped, because whatever went wrong happened while it was
    // running: dropping the player back into the moving version of the
    // situation that just beat them is not a second chance.
    expect(world.state.paused).toBe(true)
  })

  it('says so, subtly and without needing dismissing', () => {
    const { tutorial, world } = atCheckride()
    const opened = world.state.traffic
    const [a, b] = opened
    world.setTraffic([
      { ...(a as Aircraft), entered: true, pos: { x: 0, y: 0 }, altFt: 7000 },
      { ...(b as Aircraft), entered: true, pos: { x: 1, y: 0 }, altFt: 7200 },
    ])
    tutorial.observeTick()

    const toast = tutorial.element.querySelector<HTMLElement>('.tutorial-toast')
    expect(toast?.hidden).toBe(false)
    expect(toast?.textContent).toContain('Step reset')
    expect(world.state.said.some((s) => s.includes('separation lost'))).toBe(true)
  })

  it('stays on the step rather than failing the lesson', () => {
    const { tutorial, world } = atCheckride()
    const at = tutorial.stepIndex
    const [a, b] = world.state.traffic
    world.setTraffic([
      { ...(a as Aircraft), entered: true, pos: { x: 0, y: 0 }, altFt: 7000 },
      { ...(b as Aircraft), entered: true, pos: { x: 1, y: 0 }, altFt: 7200 },
    ])
    tutorial.observeTick()
    expect(tutorial.stepIndex).toBe(at)
    expect(tutorial.running).toBe(true)
  })
})

describe('the spotlight', () => {
  it('cuts a hole over the canvas on the first step', () => {
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = (): DOMRect =>
      ({ x: 0, y: 0, width: 800, height: 600 }) as DOMRect
    document.body.appendChild(canvas)

    const { tutorial } = session()
    tutorial.start()
    tutorial.layout()
    expect(tutorial.element.querySelectorAll('.tutorial-ring')).toHaveLength(1)
  })

  it('follows the aircraft it is pointing at', () => {
    const { tutorial, world } = session()
    tutorial.start()
    const press = (): void =>
      void tutorial.element.querySelector<HTMLButtonElement>('.tutorial-continue')?.click()
    press()
    press()
    tutorial.observeSpeed(4)
    // On the hold step, which spotlights the aircraft.
    tutorial.layout()
    const first = tutorial.element.querySelector('.tutorial-ring')?.getAttribute('x')

    const [a] = world.state.traffic
    world.setTraffic([{ ...(a as Aircraft), pos: { x: 30, y: 30 } }])
    tutorial.layout()
    const moved = tutorial.element.querySelector('.tutorial-ring')?.getAttribute('x')
    expect(moved).not.toBe(first)
  })

  it('does nothing at all when no lesson is running', () => {
    const { tutorial } = session()
    tutorial.layout()
    expect(tutorial.element.querySelectorAll('.tutorial-ring')).toHaveLength(0)
  })
})
