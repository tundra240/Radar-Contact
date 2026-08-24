import { describe, expect, it } from 'vitest'
import type { Aircraft } from '../sim/types'
import {
  advance,
  beginLesson,
  isMet,
  leafKey,
  leavesOf,
  progressOf,
  stepLabel,
  stepOf,
  withRefs,
  type EngineState,
  type TutorialEvent,
} from './engine'
import type { Goal, TutorialModule, TutorialStep } from './types'

function step(over: Partial<TutorialStep> = {}): TutorialStep {
  return {
    id: 'x',
    title: 'A step',
    text: 'Do the thing.',
    spotlight: { kind: 'none' },
    goal: { kind: 'continue' },
    button: 'Continue',
    ...over,
  }
}

function lesson(...steps: readonly TutorialStep[]): TutorialModule {
  return { id: 'test', airport: 'EGLL', title: 'Test lesson', summary: 'For testing.', steps }
}

function ac(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW1',
    type: 'A320',
    wake: 'M',
    role: 'arrival',
    pos: { x: 0, y: 0 },
    altFt: 7000,
    hdg: 90,
    iasKts: 220,
    gsKts: 220,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 7000,
    clearedSpdKts: 220,
    navMode: 'VECTOR',
    clearedApproach: null,
    hold: null,
    route: [],
    routeLeg: 0,
    originFix: null,
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

const tick = (traffic: readonly Aircraft[], conflicts: never[] = []): TutorialEvent => ({
  kind: 'tick',
  traffic,
  conflicts,
})

/** Feed a run of events and return where it ended up. */
function run(
  module: TutorialModule,
  events: readonly TutorialEvent[],
  from: EngineState = beginLesson(),
): EngineState {
  let state = from
  for (const event of events) state = advance(module, state, event).state
  return state
}

describe('taking a goal apart', () => {
  it('finds the leaves under a composite', () => {
    const goal: Goal = {
      kind: 'every',
      of: [
        { kind: 'altitude', ft: 3000 },
        { kind: 'inOrder', of: [{ kind: 'heading', deg: 360 }, { kind: 'heading', deg: 240 }] },
      ],
    }
    expect(leavesOf(goal).map((l) => l.kind)).toEqual(['altitude', 'heading', 'heading'])
  })

  it('treats two leaves asking the same thing as one requirement', () => {
    expect(leafKey({ kind: 'heading', deg: 90 })).toBe(leafKey({ kind: 'heading', deg: 90 }))
    expect(leafKey({ kind: 'heading', deg: 90 })).not.toBe(leafKey({ kind: 'heading', deg: 91 }))
  })

  it('counts progress through a step that asks for more than one thing', () => {
    const goal: Goal = {
      kind: 'every',
      of: [
        { kind: 'altitude', ft: 3000 },
        { kind: 'airspeed', kts: 180 },
      ],
    }
    expect(progressOf(goal, [])).toEqual({ done: 0, total: 2 })
    expect(progressOf(goal, [leafKey({ kind: 'altitude', ft: 3000 })])).toEqual({
      done: 1,
      total: 2,
    })
  })
})

describe('advancing on what the player does', () => {
  it('moves on when the button is pressed', () => {
    const module = lesson(step(), step({ id: 'y' }))
    const out = advance(module, beginLesson(), { kind: 'continue' })
    expect(out.state.step).toBe(1)
    expect(out.entered).toBe(1)
    expect(out.finished).toBe(false)
  })

  it('ignores an event the step is not waiting for', () => {
    const module = lesson(step({ goal: { kind: 'speed', to: 4 } }), step({ id: 'y' }))
    const out = advance(module, beginLesson(), { kind: 'continue' })
    expect(out.state.step).toBe(0)
    expect(out.entered).toBeNull()
  })

  it('matches a rate change only at the rate asked for', () => {
    const module = lesson(step({ goal: { kind: 'speed', to: 4 } }), step({ id: 'y' }))
    expect(advance(module, beginLesson(), { kind: 'speed', speed: 2 }).state.step).toBe(0)
    expect(advance(module, beginLesson(), { kind: 'speed', speed: 4 }).state.step).toBe(1)
  })

  it('matches selecting the aircraft the step is about', () => {
    const module = lesson(
      step({ goal: { kind: 'select', ref: 'inbound' } }),
      step({ id: 'y' }),
    )
    const named = withRefs(beginLesson(), { inbound: 'BAW214' })
    expect(advance(module, named, { kind: 'select', callsign: 'EZY9' }).state.step).toBe(0)
    expect(advance(module, named, { kind: 'select', callsign: 'BAW214' }).state.step).toBe(1)
  })

  it('does not count letting go of a target as selecting one', () => {
    const module = lesson(step({ goal: { kind: 'select' } }), step({ id: 'y' }))
    expect(advance(module, beginLesson(), { kind: 'select', callsign: null }).state.step).toBe(0)
  })

  it('matches a clearance on what was asked for', () => {
    const module = lesson(
      step({ goal: { kind: 'altitude', ft: 3000, ref: 'a' } }),
      step({ id: 'y' }),
    )
    const named = withRefs(beginLesson(), { a: 'BAW1' })
    // Right aircraft, wrong level.
    expect(
      advance(module, named, {
        kind: 'command',
        command: { kind: 'altitude', callsign: 'BAW1', ft: 5000 },
      }).state.step,
    ).toBe(0)
    // Right level, wrong aircraft.
    expect(
      advance(module, named, {
        kind: 'command',
        command: { kind: 'altitude', callsign: 'EZY9', ft: 3000 },
      }).state.step,
    ).toBe(1 - 1)
    // Both right.
    expect(
      advance(module, named, {
        kind: 'command',
        command: { kind: 'altitude', callsign: 'BAW1', ft: 3000 },
      }).state.step,
    ).toBe(1)
  })

  it('forgives a heading dragged a degree or two off', () => {
    // A vector pulled with the mouse lands near the number being taught,
    // and the lesson is about the turn rather than the last digit.
    const module = lesson(step({ goal: { kind: 'heading', deg: 90 } }), step({ id: 'y' }))
    expect(
      advance(module, beginLesson(), {
        kind: 'command',
        command: { kind: 'heading', callsign: 'BAW1', deg: 92 },
      }).state.step,
    ).toBe(1)
    expect(
      advance(module, beginLesson(), {
        kind: 'command',
        command: { kind: 'heading', callsign: 'BAW1', deg: 120 },
      }).state.step,
    ).toBe(0)
  })

  it('reads 360 and 0 as the same heading', () => {
    // They are the same direction, and a lesson that taught 360 and then
    // refused 0 would be teaching about the input box.
    const module = lesson(step({ goal: { kind: 'heading', deg: 360 } }), step({ id: 'y' }))
    expect(
      advance(module, beginLesson(), {
        kind: 'command',
        command: { kind: 'heading', callsign: 'BAW1', deg: 0 },
      }).state.step,
    ).toBe(1)
  })

  it('takes any heading for a step that just says vector it', () => {
    const module = lesson(step({ goal: { kind: 'vector' } }), step({ id: 'y' }))
    expect(
      advance(module, beginLesson(), {
        kind: 'command',
        command: { kind: 'heading', callsign: 'BAW1', deg: 275 },
      }).state.step,
    ).toBe(1)
  })
})

describe('goals the simulation reaches on its own', () => {
  it('advances when the aircraft enters the hold', () => {
    // Nobody presses anything. The aeroplane arrives at its fix and the
    // lesson notices, which is what the hold step is for.
    const module = lesson(
      step({ goal: { kind: 'navMode', mode: 'HOLD', ref: 'a' } }),
      step({ id: 'y' }),
    )
    const named = withRefs(beginLesson(), { a: 'BAW1' })
    expect(advance(module, named, tick([ac({ navMode: 'VECTOR' })])).state.step).toBe(0)
    expect(advance(module, named, tick([ac({ navMode: 'HOLD' })])).state.step).toBe(1)
  })

  it('finishes the checkride when every scripted aircraft has landed', () => {
    const module = lesson(step({ goal: { kind: 'allLanded' } }))
    const named = withRefs(beginLesson(), { one: 'A', two: 'B' })

    const half = advance(module, named, tick([ac({ callsign: 'A', navMode: 'LANDED' }), ac({ callsign: 'B' })]))
    expect(half.finished).toBe(false)

    const both = advance(
      module,
      named,
      tick([ac({ callsign: 'A', navMode: 'LANDED' }), ac({ callsign: 'B', navMode: 'LANDED' })]),
    )
    expect(both.finished).toBe(true)
  })

  it('counts an aircraft already gone from the display as landed', () => {
    // The world removes one the moment it touches down, so a landed arrival
    // is one that is no longer there to be found.
    const module = lesson(step({ goal: { kind: 'allLanded' } }))
    const named = withRefs(beginLesson(), { one: 'A' })
    expect(advance(module, named, tick([])).finished).toBe(true)
  })

  it('does not call an empty checkride complete', () => {
    // No scripted traffic means the step was never set up, and passing it
    // for that reason would be the worst kind of pass.
    const module = lesson(step({ goal: { kind: 'allLanded' } }))
    expect(advance(module, beginLesson(), tick([])).finished).toBe(false)
  })
})

describe('a step that asks for several things', () => {
  it('takes them in any order when the goal says every', () => {
    const goal: Goal = {
      kind: 'every',
      of: [
        { kind: 'altitude', ft: 3000, ref: 'a' },
        { kind: 'airspeed', kts: 180, ref: 'a' },
      ],
    }
    const module = lesson(step({ goal }), step({ id: 'y' }))
    const named = withRefs(beginLesson(), { a: 'BAW1' })

    const speedFirst = run(module, [
      { kind: 'command', command: { kind: 'speed', callsign: 'BAW1', kts: 180 } },
      { kind: 'command', command: { kind: 'altitude', callsign: 'BAW1', ft: 3000 } },
    ], named)
    expect(speedFirst.step).toBe(1)
  })

  it('holds the step until both halves are done', () => {
    const goal: Goal = {
      kind: 'every',
      of: [
        { kind: 'altitude', ft: 3000, ref: 'a' },
        { kind: 'airspeed', kts: 180, ref: 'a' },
      ],
    }
    const module = lesson(step({ goal }), step({ id: 'y' }))
    const named = withRefs(beginLesson(), { a: 'BAW1' })
    const half = advance(module, named, {
      kind: 'command',
      command: { kind: 'altitude', callsign: 'BAW1', ft: 3000 },
    })
    expect(half.state.step).toBe(0)
    // But the progress is recorded, so the card can say so.
    expect(progressOf(goal, half.state.met)).toEqual({ done: 1, total: 2 })
  })

  it('insists on the order when the goal says inOrder', () => {
    const goal: Goal = {
      kind: 'inOrder',
      of: [
        { kind: 'vector', ref: 'a' },
        { kind: 'resumeNav', ref: 'a' },
      ],
    }
    const module = lesson(step({ goal }), step({ id: 'y' }))
    const named = withRefs(beginLesson(), { a: 'EZY63' })

    // Backwards: handing navigation back before taking it away is not the
    // lesson, and it does not pass.
    const wrong = run(module, [
      { kind: 'command', command: { kind: 'resumeNav', callsign: 'EZY63' } },
    ], named)
    expect(wrong.step).toBe(0)

    const right = run(module, [
      { kind: 'command', command: { kind: 'heading', callsign: 'EZY63', deg: 200 } },
      { kind: 'command', command: { kind: 'resumeNav', callsign: 'EZY63' } },
    ], named)
    expect(right.step).toBe(1)
  })

  it('allows something unrelated in between an ordered pair', () => {
    // Selecting the aircraft between the two halves of a task is normal,
    // and requiring the steps be consecutive would fail it.
    const goal: Goal = {
      kind: 'inOrder',
      of: [
        { kind: 'heading', deg: 360, ref: 'a' },
        { kind: 'heading', deg: 240, ref: 'a' },
      ],
    }
    const module = lesson(step({ goal }), step({ id: 'y' }))
    const named = withRefs(beginLesson(), { a: 'BAW1' })
    const out = run(module, [
      { kind: 'command', command: { kind: 'heading', callsign: 'BAW1', deg: 360 } },
      { kind: 'select', callsign: 'BAW1' },
      { kind: 'command', command: { kind: 'speed', callsign: 'BAW1', kts: 200 } },
      { kind: 'command', command: { kind: 'heading', callsign: 'BAW1', deg: 240 } },
    ], named)
    expect(out.step).toBe(1)
  })
})

describe('when it goes wrong', () => {
  const goal: Goal = { kind: 'allLanded' }

  it('restarts the step on a separation breach', () => {
    const module = lesson(step({ goal, resetOn: ['conflict'] }), step({ id: 'y' }))
    const named = withRefs(beginLesson(), { a: 'A' })
    const out = advance(module, named, {
      kind: 'tick',
      traffic: [ac()],
      conflicts: [{ a: 'A', b: 'B', distanceNM: 1, verticalFt: 200 }],
    })
    expect(out.reset).toBe('conflict')
    expect(out.state.step).toBe(0)
    expect(out.state.resets).toBe(1)
  })

  it('restarts the step on a missed approach', () => {
    const module = lesson(step({ goal, resetOn: ['goAround'] }), step({ id: 'y' }))
    const out = advance(module, beginLesson(), tick([ac({ navMode: 'GO_AROUND' })]))
    expect(out.reset).toBe('goAround')
  })

  it('throws away the progress made on the step it restarts', () => {
    // The situation is being put back, so progress through it that depended
    // on that situation goes with it.
    const both: Goal = {
      kind: 'every',
      of: [{ kind: 'altitude', ft: 3000 }, { kind: 'allLanded' }],
    }
    const module = lesson(step({ goal: both, resetOn: ['conflict'] }), step({ id: 'y' }))
    const part = advance(module, beginLesson(), {
      kind: 'command',
      command: { kind: 'altitude', callsign: 'BAW1', ft: 3000 },
    }).state
    expect(part.met).toHaveLength(1)

    const after = advance(module, part, {
      kind: 'tick',
      traffic: [ac()],
      conflicts: [{ a: 'A', b: 'B', distanceNM: 1, verticalFt: 0 }],
    })
    expect(after.state.met).toEqual([])
  })

  it('prefers the failure when a step both fails and passes on one tick', () => {
    // Rewarding a breach because the aeroplane happened to land afterwards
    // would teach precisely the wrong thing.
    const module = lesson(step({ goal, resetOn: ['conflict'] }))
    const named = withRefs(beginLesson(), { a: 'A' })
    const out = advance(module, named, {
      kind: 'tick',
      traffic: [ac({ callsign: 'A', navMode: 'LANDED' })],
      conflicts: [{ a: 'A', b: 'B', distanceNM: 0.5, verticalFt: 0 }],
    })
    expect(out.reset).toBe('conflict')
    expect(out.finished).toBe(false)
  })

  it('leaves a step alone that does not watch for that failure', () => {
    // The early steps have one aeroplane on the scope and a lesson that
    // could reset itself while the player was reading would be worse than
    // one that could not.
    const module = lesson(step({ goal }), step({ id: 'y' }))
    const out = advance(module, beginLesson(), {
      kind: 'tick',
      traffic: [ac()],
      conflicts: [{ a: 'A', b: 'B', distanceNM: 0.1, verticalFt: 0 }],
    })
    expect(out.reset).toBeNull()
  })
})

describe('the end of the lesson', () => {
  it('finishes on the last step rather than walking off the end', () => {
    const module = lesson(step(), step({ id: 'y' }))
    const out = run(module, [{ kind: 'continue' }, { kind: 'continue' }])
    expect(out.finished).toBe(true)
    expect(stepOf(module, out)).toBeNull()
  })

  it('ignores everything after it has finished', () => {
    const module = lesson(step())
    const done = advance(module, beginLesson(), { kind: 'continue' }).state
    const after = advance(module, done, { kind: 'continue' })
    expect(after.entered).toBeNull()
    expect(after.finished).toBe(false)
  })

  it('says where the player is', () => {
    const module = lesson(step(), step({ id: 'y' }), step({ id: 'z' }))
    expect(stepLabel(module, beginLesson())).toBe('Step 1 of 3')
    const on = run(module, [{ kind: 'continue' }])
    expect(stepLabel(module, on)).toBe('Step 2 of 3')
  })
})

describe('what counts as met', () => {
  it('is the whole of a composite, not any part of it', () => {
    const goal: Goal = {
      kind: 'every',
      of: [{ kind: 'continue' }, { kind: 'speed', to: 4 }],
    }
    expect(isMet(goal, [leafKey({ kind: 'continue' })])).toBe(false)
    expect(
      isMet(goal, [leafKey({ kind: 'continue' }), leafKey({ kind: 'speed', to: 4 })]),
    ).toBe(true)
  })
})
