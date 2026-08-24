/**
 * How hard the session is, as one table.
 *
 * Every knob the difficulty turns lives here and nowhere else. That is the
 * whole design: raising the arrival rate, widening the warning buffer or
 * turning the transits off is an edit to this file, and every part of the
 * simulation that cares reads it rather than carrying its own idea of what
 * "hard" means. A setting that had to be changed in two places would be a
 * setting that could disagree with itself.
 *
 * The one thing difficulty does NOT move is the separation minimum. Three
 * miles and a thousand feet is the law of the sky and it is the same law on
 * every setting; see sim/conflict.ts. What changes is how early the display
 * warns you that you are heading for it -- an easy session shouts at four
 * miles, a professional one only tells you once it has happened.
 */

export type DifficultyName = 'easy' | 'normal' | 'hard' | 'pro'

/** In the order they are offered, easiest first. */
export const DIFFICULTY_ORDER: readonly DifficultyName[] = ['easy', 'normal', 'hard', 'pro']

/**
 * How much of the transit traffic a setting lets through.
 *
 * Corridors are classified in the airport file rather than listed here by
 * name -- the point of the classes is that a second airport can say which
 * of its own corridors cross the arrival flow without this module knowing
 * anything about either field.
 */
export type CorridorClass = 'clear' | 'crossing' | 'overhead'

export interface DifficultySettings {
  readonly name: DifficultyName
  readonly label: string
  /** One line, for the menu that offers them. */
  readonly summary: string

  /* ---- traffic ---- */
  readonly arrivalsPerHour: number
  /** Transits per hour. Zero switches them off entirely. */
  readonly transitsPerHour: number
  /**
   * How often somebody declares, per hour.
   *
   * None at all on Easy, for the same reason there are no transits there:
   * the setting exists to teach the shape of the job, and an emergency
   * rewrites the sequence you were in the middle of learning to build. It
   * climbs from there, and on Pro it is often enough that you cannot treat
   * one as an event -- it is part of the shift.
   *
   * A rate rather than a chance, so it reads the same way the arrival and
   * transit rates do and so the interval between them can be worked out the
   * same way. See intervalSecondsFor.
   */
  readonly emergenciesPerHour: number
  /** Which corridors are in use. Empty means none. */
  readonly corridors: readonly CorridorClass[]
  /**
   * How many aircraft may be worked at once.
   *
   * The spawner holds releases back at this figure, so it is the real
   * ceiling on how busy the sector gets however fast the timer runs.
   */
  readonly maxConcurrent: number

  /* ---- environment ---- */
  /** Multiplier on the field's published wind. Zero is a calm day. */
  readonly windStrength: number
  /** How far the wind wanders over an hour, in degrees. */
  readonly windShiftDeg: number
  readonly cellsPerHour: number
  /** Share of cells that develop a red core, 0..1. */
  readonly heavyChance: number
  /** Cells drift at this fraction of the wind. */
  readonly stormDrift: number

  /* ---- what the display gives you ---- */
  /**
   * History dots behind each target.
   *
   * A display decision rather than a physical one: the simulation records
   * the same trail either way and the scope draws as much of it as the
   * setting allows. Nought leaves the speed vector and nothing else, which
   * is a real way of working and a hard one.
   */
  readonly trailDots: number
  /** Warned at this gap, which is wider than the minimum on the easy end. */
  readonly warnNM: number
  readonly warnFt: number

  /* ---- the ATIS ---- */
  readonly atis: AtisBehaviour
  /**
   * Between the ATIS announcing a new direction and it taking effect.
   *
   * Only meaningful when the direction changes at all.
   */
  readonly atisNoticeSeconds: number

  /* ---- what it is worth ---- */
  readonly scoreMultiplier: number
}

/**
 * What makes the runway direction change.
 *
 * - `locked`: it never does. One runway, all session.
 * - `timed`: on a schedule, whatever the weather is doing.
 * - `weather`: when the wind says it should, which is the real rule.
 * - `abrupt`: the same, with barely any warning.
 */
export type AtisBehaviour = 'locked' | 'timed' | 'weather' | 'abrupt'

export const DIFFICULTIES: Record<DifficultyName, DifficultySettings> = {
  easy: {
    name: 'easy',
    label: 'Easy',
    summary: 'One or two at a time, calm air, and a warning long before you need it.',
    arrivalsPerHour: 9,
    transitsPerHour: 0,
    emergenciesPerHour: 0,
    corridors: [],
    maxConcurrent: 6,
    windStrength: 0,
    windShiftDeg: 0,
    cellsPerHour: 0,
    heavyChance: 0,
    stormDrift: 0,
    trailDots: 5,
    warnNM: 4,
    warnFt: 1200,
    atis: 'locked',
    atisNoticeSeconds: 0,
    scoreMultiplier: 1,
  },

  normal: {
    name: 'normal',
    label: 'Normal',
    summary: 'A steady stream, a little wind, and transits crossing clear of the approach.',
    arrivalsPerHour: 16,
    transitsPerHour: 4,
    emergenciesPerHour: 0.8,
    corridors: ['clear'],
    maxConcurrent: 10,
    windStrength: 0.6,
    windShiftDeg: 20,
    cellsPerHour: 1,
    heavyChance: 0.05,
    stormDrift: 0.6,
    trailDots: 3,
    warnNM: 3.5,
    warnFt: 1100,
    atis: 'timed',
    atisNoticeSeconds: 600,
    scoreMultiplier: 1.5,
  },

  hard: {
    name: 'hard',
    label: 'Hard',
    summary: 'Four fixes feeding at once, storms near the holds, and transits through the flow.',
    arrivalsPerHour: 24,
    transitsPerHour: 8,
    emergenciesPerHour: 1.6,
    corridors: ['clear', 'crossing'],
    maxConcurrent: 14,
    windStrength: 1,
    windShiftDeg: 60,
    cellsPerHour: 4,
    heavyChance: 0.2,
    stormDrift: 0.9,
    trailDots: 1,
    warnNM: 3,
    warnFt: 1000,
    atis: 'weather',
    atisNoticeSeconds: 300,
    scoreMultiplier: 2,
  },

  pro: {
    name: 'pro',
    label: 'Pro',
    summary: 'Peak Heathrow. No history dots, no early warning, and the runway can turn on you.',
    arrivalsPerHour: 34,
    transitsPerHour: 12,
    emergenciesPerHour: 2.5,
    corridors: ['clear', 'crossing', 'overhead'],
    maxConcurrent: 20,
    windStrength: 1.4,
    windShiftDeg: 120,
    cellsPerHour: 7,
    heavyChance: 0.4,
    stormDrift: 1.2,
    // Nothing behind the target but the vector line: where it will be in a
    // minute, and nothing at all about where it has been.
    trailDots: 0,
    warnNM: 3,
    warnFt: 1000,
    atis: 'abrupt',
    atisNoticeSeconds: 120,
    scoreMultiplier: 3,
  },
}

export const DEFAULT_DIFFICULTY: DifficultyName = 'normal'

/**
 * Individual switches over a preset, for a sandbox session.
 *
 * The preset is the baseline and these turn parts of it off -- the brief's
 * own example is peak traffic with the weather switched off, which is a
 * perfectly reasonable thing to want to practise and not a difficulty
 * anybody would sensibly name.
 *
 * Switches rather than sliders: every one of them is a thing that is either
 * happening to you or not, and a half-strength thunderstorm is not a
 * clearer idea than no thunderstorm.
 */
export interface DifficultyOverrides {
  readonly weather: boolean
  readonly transits: boolean
}

/** Everything the preset says, unmodified. */
export const NO_OVERRIDES: DifficultyOverrides = { weather: true, transits: true }

/**
 * A preset with the switches applied.
 *
 * Only ever subtracts. An override can turn part of a setting off; it
 * cannot turn Easy into Pro by the back door, because then the name on the
 * session would be telling you something untrue about what you flew.
 */
export function withOverrides(
  settings: DifficultySettings,
  overrides: DifficultyOverrides,
): DifficultySettings {
  return {
    ...settings,
    ...(overrides.weather
      ? {}
      : { cellsPerHour: 0, heavyChance: 0, windStrength: 0, windShiftDeg: 0 }),
    ...(overrides.transits ? {} : { transitsPerHour: 0, corridors: [] }),
  }
}

/** The settings for a name, falling back to the default for an unknown one. */
export function difficultyOf(name: string): DifficultySettings {
  return DIFFICULTIES[name as DifficultyName] ?? DIFFICULTIES[DEFAULT_DIFFICULTY]
}

/* ------------------------------------------------------- derived figures */

/**
 * The gap between arrivals, in seconds, for a rate per hour.
 *
 * The rate is what a controller talks about -- "twenty-six an hour" -- and
 * the interval is what the spawner needs, so the conversion belongs here
 * rather than being written out at the call site in either unit.
 */
export function intervalSecondsFor(perHour: number): number {
  if (perHour <= 0) return Number.POSITIVE_INFINITY
  return 3600 / perHour
}

/**
 * Where the flow starts before the ramp brings it up to rate.
 *
 * Every setting opens quieter than it finishes: dropping a controller
 * straight into the peak gives them no time to build a picture, and the
 * ramp is what the arrival spawner already does with the published figures.
 */
export function openingIntervalSecondsFor(perHour: number): number {
  return intervalSecondsFor(perHour) * 2
}

/** Whether this setting has transits at all. */
export function hasTransits(settings: DifficultySettings): boolean {
  return settings.transitsPerHour > 0 && settings.corridors.length > 0
}

/**
 * Whether a corridor of this class flies on this setting.
 *
 * An unclassified corridor counts as crossing: the cautious reading, since
 * a corridor nobody has thought about should not turn up on Normal.
 */
export function allowsCorridor(
  settings: DifficultySettings,
  corridorClass: CorridorClass | null,
): boolean {
  return settings.corridors.includes(corridorClass ?? 'crossing')
}

/**
 * What a landing is worth on this setting.
 *
 * Rounded, because a score with a decimal point in it reads as a
 * measurement rather than as a tally.
 */
export function scaledPoints(points: number, settings: DifficultySettings): number {
  return Math.round(points * settings.scoreMultiplier)
}
