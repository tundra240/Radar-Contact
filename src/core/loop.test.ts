import { describe, expect, it } from 'vitest'
import {
  GameLoop,
  SPEEDS,
  TICK_HZ,
  TICK_MS,
  TICK_SECONDS,
  formatClock,
  formatSpeed,
  isSpeed,
  type Speed,
} from './loop'

interface Harness {
  loop: GameLoop
  dts: number[]
  alphas: number[]
  /** Advance real time in frame-sized steps, as a browser would. */
  runFor: (realMs: number, stepMs?: number) => void
  runQueued: () => void
  hasQueued: () => boolean
}

function harness(extra?: {
  speed?: Speed
  maxFrameMs?: number
  maxTicksPerFrame?: number
  startTimeOfDaySeconds?: number
}): Harness {
  let now = 0
  const dts: number[] = []
  const alphas: number[] = []
  let queued: (() => void) | null = null

  const loop = new GameLoop({
    tick: (dt) => dts.push(dt),
    render: (alpha) => alphas.push(alpha),
    now: () => now,
    schedule: (cb) => {
      queued = cb
      return 1
    },
    cancel: () => {
      queued = null
    },
    ...(extra?.speed !== undefined ? { speed: extra.speed } : {}),
    ...(extra?.maxFrameMs !== undefined ? { maxFrameMs: extra.maxFrameMs } : {}),
    ...(extra?.maxTicksPerFrame !== undefined
      ? { maxTicksPerFrame: extra.maxTicksPerFrame }
      : {}),
    ...(extra?.startTimeOfDaySeconds !== undefined
      ? { startTimeOfDaySeconds: extra.startTimeOfDaySeconds }
      : {}),
  })

  loop.start()

  return {
    loop,
    dts,
    alphas,
    runFor(realMs, stepMs = 16) {
      let remaining = realMs
      while (remaining > 0) {
        const step = Math.min(stepMs, remaining)
        now += step
        remaining -= step
        loop.frame()
      }
    },
    runQueued() {
      const q = queued
      queued = null
      q?.()
    },
    hasQueued: () => queued !== null,
  }
}

describe('tick rate', () => {
  it('runs at twenty steps a second', () => {
    expect(TICK_HZ).toBe(20)
    expect(TICK_MS).toBe(50)
    expect(TICK_SECONDS).toBeCloseTo(0.05, 12)
  })

  it('advances one tick per fifty milliseconds of real time at normal speed', () => {
    const h = harness()
    h.runFor(1000)
    expect(h.loop.clock.ticks).toBe(20)
  })

  it('banks partial time rather than losing it', () => {
    const h = harness()
    // Three thirty-millisecond frames is ninety milliseconds: one whole
    // tick, with forty banked towards the next.
    h.runFor(90, 30)
    expect(h.loop.clock.ticks).toBe(1)
    h.runFor(30, 30)
    expect(h.loop.clock.ticks).toBe(2)
  })

  it('never runs a tick for less than a full step', () => {
    const h = harness()
    h.runFor(49, 49)
    expect(h.loop.clock.ticks).toBe(0)
    // Render still happens: the picture must stay live between steps.
    expect(h.alphas.length).toBe(1)
  })
})

describe('speed', () => {
  it('offers exactly the four rates', () => {
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4])
    for (const s of SPEEDS) expect(isSpeed(s)).toBe(true)
    expect(isSpeed(3)).toBe(false)
    expect(isSpeed('2')).toBe(false)
  })

  it('changes how many ticks happen per real second', () => {
    for (const [speed, expected] of [
      [0.5, 10],
      [1, 20],
      [2, 40],
      [4, 80],
    ] as const) {
      const h = harness({ speed })
      h.runFor(1000)
      expect(h.loop.clock.ticks, `at x${speed}`).toBe(expected)
    }
  })

  it('never changes the size of a step', () => {
    // The whole point of a fixed timestep: 4x is more ticks, not bigger
    // ones. Scaling dt instead would make fast-forward a different
    // simulation rather than the same one sooner.
    for (const speed of SPEEDS) {
      const h = harness({ speed })
      h.runFor(1000)
      for (const dt of h.dts) expect(dt, `at x${speed}`).toBe(TICK_SECONDS)
    }
  })

  it('takes effect part way through a run', () => {
    const h = harness()
    h.runFor(1000)
    expect(h.loop.clock.ticks).toBe(20)
    h.loop.setSpeed(4)
    h.runFor(1000)
    expect(h.loop.clock.ticks).toBe(100)
    expect(h.loop.speed).toBe(4)
  })
})

describe('pausing', () => {
  it('stops the simulation but keeps drawing', () => {
    const h = harness()
    h.runFor(500)
    const ticks = h.loop.clock.ticks
    const frames = h.alphas.length

    h.loop.setPaused(true)
    h.runFor(1000)

    expect(h.loop.clock.ticks).toBe(ticks)
    expect(h.alphas.length).toBeGreaterThan(frames)
  })

  it('does not simulate the pause away on resuming', () => {
    // Banked time is discarded, or a long pause would be followed by a
    // burst of catch-up ticks.
    const h = harness()
    h.runFor(1000)
    h.loop.setPaused(true)
    h.runFor(60_000)
    h.loop.setPaused(false)
    h.runFor(50, 50)
    expect(h.loop.clock.ticks).toBe(21)
  })

  it('toggles', () => {
    const h = harness()
    expect(h.loop.togglePaused()).toBe(true)
    expect(h.loop.paused).toBe(true)
    expect(h.loop.togglePaused()).toBe(false)
  })
})

describe('the clock', () => {
  it('measures simulated time in ticks, not wall clock', () => {
    const h = harness({ speed: 4 })
    h.runFor(1000)
    // Eighty ticks of fifty milliseconds is four simulated seconds from one
    // real second, which is what 4x means.
    expect(h.loop.clock.ticks).toBe(80)
    expect(h.loop.clock.elapsedSeconds).toBeCloseTo(4, 9)
  })

  it('starts at midday by default and advances', () => {
    const h = harness()
    expect(formatClock(h.loop.clock.timeOfDaySeconds)).toBe('12:00:00')
    h.runFor(2000)
    expect(formatClock(h.loop.clock.timeOfDaySeconds)).toBe('12:00:02')
  })

  it('starts wherever it is told to', () => {
    const h = harness({ startTimeOfDaySeconds: 6 * 3600 + 29 * 60 + 55 })
    expect(formatClock(h.loop.clock.timeOfDaySeconds)).toBe('06:29:55')
    h.runFor(10_000)
    expect(formatClock(h.loop.clock.timeOfDaySeconds)).toBe('06:30:05')
  })

  it('wraps at midnight', () => {
    const h = harness({ startTimeOfDaySeconds: 86_395 })
    h.runFor(10_000)
    expect(formatClock(h.loop.clock.timeOfDaySeconds)).toBe('00:00:05')
  })

  it('formats out-of-range values rather than producing nonsense', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(-1)).toBe('23:59:59')
    expect(formatClock(86_400)).toBe('00:00:00')
  })
})

describe('robustness', () => {
  it('clamps a huge gap instead of trying to simulate all of it', () => {
    // A backgrounded tab returns with minutes of elapsed time. Simulating
    // it in one frame stalls, and the next frame is further behind still,
    // which is the classic spiral.
    const h = harness({ maxFrameMs: 250 })
    h.runFor(600_000, 600_000)
    expect(h.loop.clock.ticks).toBe(5)
  })

  it('abandons a backlog it cannot clear rather than carrying it forward', () => {
    const h = harness({ speed: 4, maxFrameMs: 1000, maxTicksPerFrame: 10 })
    h.runFor(1000, 1000)
    expect(h.loop.clock.ticks).toBe(10)
    expect(h.loop.droppedTicks).toBeGreaterThan(0)
  })

  it('reports interpolation as a fraction of a step', () => {
    const h = harness()
    h.runFor(1000)
    for (const a of h.alphas) {
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(1)
    }
  })

  it('ignores time running backwards', () => {
    const h = harness()
    h.runFor(500)
    const ticks = h.loop.clock.ticks
    // A repeated frame with no elapsed time must not rewind the
    // accumulator or run a step.
    h.loop.frame()
    expect(h.loop.clock.ticks).toBe(ticks)
  })
})

describe('start and stop', () => {
  it('schedules itself while running', () => {
    const h = harness()
    expect(h.loop.running).toBe(true)
    expect(h.hasQueued()).toBe(true)
    h.runQueued()
    expect(h.hasQueued()).toBe(true)
  })

  it('stops scheduling once stopped', () => {
    const h = harness()
    h.loop.stop()
    expect(h.loop.running).toBe(false)
    expect(h.hasQueued()).toBe(false)
  })

  it('does nothing if started twice', () => {
    const h = harness()
    h.runFor(500)
    const ticks = h.loop.clock.ticks
    h.loop.start()
    expect(h.loop.clock.ticks).toBe(ticks)
  })
})

describe('formatSpeed', () => {
  it('reads as a rate', () => {
    expect(formatSpeed(0.5)).toBe('x0.5')
    expect(formatSpeed(1)).toBe('x1')
    expect(formatSpeed(4)).toBe('x4')
  })
})
