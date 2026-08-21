/**
 * The game clock and the fixed-timestep loop.
 *
 * The simulation advances in fixed steps and rendering is decoupled from
 * it. That is the single decision this file exists to enforce, and it buys
 * three things: physics that behave identically regardless of frame rate,
 * a simulation that can be paused or run at a different rate without any
 * module knowing, and a deterministic replay -- the same tick count with
 * the same seed produces the same world.
 *
 * Changing speed changes HOW MANY ticks happen per real second, never the
 * size of a tick. A tick is always 50 ms of simulated time. Anything that
 * scaled the step instead would make 4x a different simulation rather than
 * a faster one. See ARCHITECTURE.md section 3, decision 1.
 */

/** Simulation rate. Twenty steps a second, so a tick is 50 ms. */
export const TICK_HZ = 20
export const TICK_MS = 1000 / TICK_HZ
export const TICK_SECONDS = TICK_MS / 1000

export const SPEEDS = [0.5, 1, 2, 4] as const
export type Speed = (typeof SPEEDS)[number]

export function isSpeed(value: unknown): value is Speed {
  return typeof value === 'number' && (SPEEDS as readonly number[]).includes(value)
}

export interface Clock {
  /** Fixed steps completed. The authoritative measure of simulated time. */
  readonly ticks: number
  /** Simulated seconds elapsed: exactly ticks x 50 ms, never wall clock. */
  readonly elapsedSeconds: number
  /** Simulated time of day in seconds, for the zulu readout. */
  readonly timeOfDaySeconds: number
}

export interface GameLoopOptions {
  /** One fixed simulation step. dt is always TICK_SECONDS. */
  readonly tick: (dtSeconds: number, clock: Clock) => void
  /**
   * Draw a frame. `alpha` is the fraction of a tick already accumulated,
   * for interpolating positions between steps once there is anything to
   * interpolate.
   */
  readonly render: (alpha: number, clock: Clock) => void
  /** Injected so tests can drive time by hand rather than by waiting. */
  readonly now?: () => number
  readonly schedule?: (callback: () => void) => number
  readonly cancel?: (handle: number) => void
  /** Wall-clock time the session starts at, default 12:00:00. */
  readonly startTimeOfDaySeconds?: number
  readonly speed?: Speed
  /**
   * Ceiling on real time consumed by one frame. Without it, a tab left in
   * the background returns with minutes of elapsed time and the loop tries
   * to simulate all of it in one frame, which stalls and then falls further
   * behind -- the classic spiral.
   */
  readonly maxFrameMs?: number
  readonly maxTicksPerFrame?: number
}

const SECONDS_PER_DAY = 86400

export class GameLoop {
  private readonly opts: GameLoopOptions
  private readonly nowMs: () => number
  private readonly schedule: (callback: () => void) => number
  private readonly cancelScheduled: (handle: number) => void
  private readonly startOfDay: number
  private readonly maxFrameMs: number
  private readonly maxTicks: number

  private accumulatorMs = 0
  private lastNowMs = 0
  private simTicks = 0
  private currentSpeed: Speed
  private isRunning = false
  private isPaused = false
  private handle: number | null = null
  /** Ticks abandoned because a frame hit its ceiling. Diagnostics only. */
  private dropped = 0

  constructor(opts: GameLoopOptions) {
    this.opts = opts
    this.nowMs = opts.now ?? ((): number => performance.now())
    this.schedule = opts.schedule ?? ((cb): number => requestAnimationFrame(cb))
    this.cancelScheduled = opts.cancel ?? ((h): void => cancelAnimationFrame(h))
    this.startOfDay = opts.startTimeOfDaySeconds ?? 12 * 3600
    this.maxFrameMs = opts.maxFrameMs ?? 250
    this.maxTicks = opts.maxTicksPerFrame ?? 25
    this.currentSpeed = opts.speed ?? 1
  }

  get clock(): Clock {
    const elapsedSeconds = this.simTicks * TICK_SECONDS
    return {
      ticks: this.simTicks,
      elapsedSeconds,
      timeOfDaySeconds: (this.startOfDay + elapsedSeconds) % SECONDS_PER_DAY,
    }
  }

  get running(): boolean {
    return this.isRunning
  }

  get paused(): boolean {
    return this.isPaused
  }

  get speed(): Speed {
    return this.currentSpeed
  }

  get droppedTicks(): number {
    return this.dropped
  }

  setSpeed(speed: Speed): void {
    this.currentSpeed = speed
  }

  setPaused(paused: boolean): void {
    // Any time banked while running is discarded, so unpausing does not
    // immediately simulate the pause away.
    if (paused && !this.isPaused) this.accumulatorMs = 0
    this.isPaused = paused
  }

  togglePaused(): boolean {
    this.setPaused(!this.isPaused)
    return this.isPaused
  }

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.lastNowMs = this.nowMs()
    this.accumulatorMs = 0
    this.queue()
  }

  stop(): void {
    this.isRunning = false
    if (this.handle !== null) {
      this.cancelScheduled(this.handle)
      this.handle = null
    }
  }

  private queue(): void {
    this.handle = this.schedule(() => {
      this.handle = null
      if (!this.isRunning) return
      this.frame()
      this.queue()
    })
  }

  /**
   * One frame: bank the real time that has passed, spend it in whole ticks,
   * then draw. Exposed so tests can step the loop without a scheduler.
   */
  frame(): void {
    const now = this.nowMs()
    const realMs = Math.min(Math.max(0, now - this.lastNowMs), this.maxFrameMs)
    this.lastNowMs = now

    if (!this.isPaused) this.accumulatorMs += realMs * this.currentSpeed

    let ticksThisFrame = 0
    while (this.accumulatorMs >= TICK_MS && ticksThisFrame < this.maxTicks) {
      this.accumulatorMs -= TICK_MS
      this.simTicks += 1
      ticksThisFrame += 1
      this.opts.tick(TICK_SECONDS, this.clock)
    }

    if (this.accumulatorMs >= TICK_MS) {
      // Hit the ceiling. Abandon the backlog rather than carrying it into
      // the next frame, where it would only grow.
      this.dropped += Math.floor(this.accumulatorMs / TICK_MS)
      this.accumulatorMs %= TICK_MS
    }

    this.opts.render(this.accumulatorMs / TICK_MS, this.clock)
  }
}

/** Zulu readout, HH:MM:SS. */
export function formatClock(timeOfDaySeconds: number): string {
  const t = Math.floor(((timeOfDaySeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Speed as it appears on a button. */
export function formatSpeed(speed: Speed): string {
  return speed === 1 ? 'x1' : `x${speed}`
}
