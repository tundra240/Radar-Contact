import type { Clock } from '../core/loop'
import type { Vec2NM } from '../core/geo'
import type { Atis } from './atis'
import type { Score } from './score'
import type { EmergencyFlowState } from './emergencyflow'
import type { OverflightState } from './overflight'
import type { SpawnerState } from './spawner'
import type { DifficultyName } from './difficulty'
import type { SessionMode } from '../ui/logon'
import { isSquawk } from './squawk'
import { ROLES } from './types'
import type {
  Aircraft,
  ApproachClearance,
  HoldClearance,
  NavMode,
  RouteLeg,
} from './types'
import type { WakeCategory } from '../data/airport'

/**
 * Saving and loading a session.
 *
 * A snapshot rather than a replay. The seeded generator means a session
 * *could* be rebuilt from its seed and a log of every command, and that is
 * a lovely property to have -- but loading would then mean replaying the
 * whole shift, and a single behaviour change would invalidate every save
 * ever written. A snapshot loads in constant time and says exactly what it
 * means.
 *
 * What goes in is everything that cannot be worked out again: the traffic,
 * the clock, the score, who is on position, and the spawner's cadence and
 * random stream. What stays out is everything derived from the airport
 * config -- the airspace, the holds, the runways. A save that carried those
 * could quietly disagree with the config it was loaded into; one that omits
 * them is refused outright if it was flown somewhere else.
 *
 * Reading one is treated as reading anything else from outside: validated
 * field by field, and refused with a reason rather than trusted. A corrupt
 * save should not be able to put an aeroplane at a NaN.
 */

/**
 * Bumped whenever the shape changes. An older save is refused rather than
 * guessed at -- there is no migration path worth the bugs it would carry.
 */
export const SAVE_VERSION = 7

export interface SavedController {
  readonly initials: string
  readonly position: string
  /**
   * Whether that session was flown with the area of responsibility
   * enforced. Part of who is on position rather than a separate setting,
   * because it is a rule for the shift and it was chosen at logon with the
   * initials.
   */
  readonly enforceAirspace: boolean
  /**
   * The setting the session was flown on.
   *
   * Part of who is on position for the same reason the airspace rule is: it
   * was chosen at logon and it is a rule for the shift. It also has to
   * survive a save, or a career run resumed tomorrow would come back at
   * whatever the menu happened to be showing -- which for a career run is
   * the difference between finishing it and cheating at it.
   */
  readonly difficulty: DifficultyName
  readonly mode: SessionMode
}

export interface SavedGame {
  readonly version: number
  /** Which airport this was flown at. A save does not travel. */
  readonly airport: string
  /** ISO timestamp, for telling two saves apart. */
  readonly savedAt: string
  readonly clock: Clock
  readonly score: Score
  /**
   * What the field was doing: the runways in use, the wind and the letter.
   *
   * Saved because it is a decision the controller made, not something
   * derivable. Reload a session flown on 09s and getting 27s back -- with
   * every aircraft positioned for the other end -- would be a different
   * session from the one that was saved.
   */
  readonly atis: Atis
  readonly controller: SavedController | null
  readonly selected: string | null
  readonly traffic: readonly Aircraft[]
  readonly spawner: SpawnerState
  /**
   * The transit flow, or null for a save taken at a field with no
   * corridors. Null rather than absent so a reader can tell "this airport
   * has none" from "this save predates them", which version 5 also does.
   */
  readonly overflights: OverflightState | null
  /**
   * Where the emergency scheduler had got to.
   *
   * Nullable, like the transit state, so a save written before it existed
   * still loads -- and so a session restored from one simply starts its
   * clock again rather than refusing to open. The emergencies themselves are
   * on the aircraft, in the squawk, so a reload never forgets one that has
   * already happened.
   */
  readonly emergencies: EmergencyFlowState | null
}

export type LoadResult =
  | { readonly ok: true; readonly game: SavedGame }
  | { readonly ok: false; readonly reason: string }

const NAV_MODES: readonly NavMode[] = [
  'LNAV',
  'HOLD',
  'VECTOR',
  'LOC_ARMED',
  'LOC_CAPTURED',
  'GS_TRACKING',
  'GO_AROUND',
  'LANDED',
  'HANDOFF',
]

const WAKES: readonly WakeCategory[] = ['J', 'H', 'M', 'L']

/* ------------------------------------------------------------- validation

   The same shape as the airport loader's: small helpers that throw with the
   path that failed, wrapped once at the top so the caller gets a reason
   instead of an exception.                                              */

class Invalid extends Error {}

const fail = (path: string, what: string): never => {
  throw new Invalid(`${path} ${what}`)
}

const obj = (v: unknown, path: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : (fail(path, 'is not an object') as never)

const arr = (v: unknown, path: string): unknown[] =>
  Array.isArray(v) ? v : (fail(path, 'is not an array') as never)

const num = (v: unknown, path: string): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : (fail(path, 'is not a number') as never)

const str = (v: unknown, path: string): string =>
  typeof v === 'string' ? v : (fail(path, 'is not a string') as never)

const bool = (v: unknown, path: string): boolean =>
  typeof v === 'boolean' ? v : (fail(path, 'is not a boolean') as never)

const nullableNum = (v: unknown, path: string): number | null =>
  v === null ? null : num(v, path)

const nullableStr = (v: unknown, path: string): string | null =>
  v === null ? null : str(v, path)

const oneOf = <T extends string>(v: unknown, path: string, allowed: readonly T[]): T => {
  const s = str(v, path)
  return (allowed as readonly string[]).includes(s)
    ? (s as T)
    : (fail(path, `is not one of ${allowed.join(', ')}`) as never)
}

const vec = (v: unknown, path: string): Vec2NM => {
  const o = obj(v, path)
  return { x: num(o['x'], `${path}.x`), y: num(o['y'], `${path}.y`) }
}

function parseHold(v: unknown, path: string): HoldClearance | null {
  if (v === null) return null
  const o = obj(v, path)
  return {
    fix: str(o['fix'], `${path}.fix`),
    posNM: vec(o['posNM'], `${path}.posNM`),
    inboundTrue: num(o['inboundTrue'], `${path}.inboundTrue`),
    turns: oneOf(o['turns'], `${path}.turns`, ['left', 'right'] as const),
    legMins: num(o['legMins'], `${path}.legMins`),
  }
}

function parseApproach(v: unknown, path: string): ApproachClearance | null {
  if (v === null) return null
  const o = obj(v, path)
  return {
    runway: str(o['runway'], `${path}.runway`),
    thresholdNM: vec(o['thresholdNM'], `${path}.thresholdNM`),
    courseTrue: num(o['courseTrue'], `${path}.courseTrue`),
    thresholdElevationFt: num(o['thresholdElevationFt'], `${path}.thresholdElevationFt`),
    glideslopeDeg: num(o['glideslopeDeg'], `${path}.glideslopeDeg`),
    fafDistNM: num(o['fafDistNM'], `${path}.fafDistNM`),
    maxInterceptDeg: num(o['maxInterceptDeg'], `${path}.maxInterceptDeg`),
    interceptAltMaxFt: num(o['interceptAltMaxFt'], `${path}.interceptAltMaxFt`),
  }
}

/** One fix on a saved route: the name, and where it is. */
function parseRouteLeg(v: unknown, path: string): RouteLeg {
  const o = obj(v, path)
  return {
    fix: str(o['fix'], `${path}.fix`),
    posNM: vec(o['posNM'], `${path}.posNM`),
  }
}

function parseAircraft(v: unknown, path: string): Aircraft {
  const o = obj(v, path)
  return {
    callsign: str(o['callsign'], `${path}.callsign`),
    type: str(o['type'], `${path}.type`),
    wake: oneOf(o['wake'], `${path}.wake`, WAKES),
    role: oneOf(o['role'], `${path}.role`, ROLES),
    pos: vec(o['pos'], `${path}.pos`),
    altFt: num(o['altFt'], `${path}.altFt`),
    hdg: num(o['hdg'], `${path}.hdg`),
    iasKts: num(o['iasKts'], `${path}.iasKts`),
    gsKts: num(o['gsKts'], `${path}.gsKts`),
    vsFpm: num(o['vsFpm'], `${path}.vsFpm`),
    clearedHdg: nullableNum(o['clearedHdg'], `${path}.clearedHdg`),
    clearedAltFt: num(o['clearedAltFt'], `${path}.clearedAltFt`),
    clearedSpdKts: num(o['clearedSpdKts'], `${path}.clearedSpdKts`),
    navMode: oneOf(o['navMode'], `${path}.navMode`, NAV_MODES),
    clearedApproach: parseApproach(o['clearedApproach'], `${path}.clearedApproach`),
    hold: parseHold(o['hold'], `${path}.hold`),
    route: arr(o['route'], `${path}.route`).map((l, i) =>
      parseRouteLeg(l, `${path}.route[${i}]`),
    ),
    routeLeg: num(o['routeLeg'], `${path}.routeLeg`),
    originFix: nullableStr(o['originFix'], `${path}.originFix`),
    destination: nullableStr(o['destination'], `${path}.destination`),
    entered: bool(o['entered'], `${path}.entered`),
    trail: arr(o['trail'], `${path}.trail`).map((p, i) => vec(p, `${path}.trail[${i}]`)),
    trailAt: num(o['trailAt'], `${path}.trailAt`),
    spawnedAt: num(o['spawnedAt'], `${path}.spawnedAt`),
    squawk: squawk(o['squawk'], `${path}.squawk`),
    emergencyAt: nullableNum(o['emergencyAt'], `${path}.emergencyAt`),
  }
}

/**
 * A transponder code, checked rather than taken on trust.
 *
 * Four octal digits is a shape a typo cannot survive, and a save that has
 * been edited by hand into "7A00" or "88" should be refused at the door
 * rather than drawn on a data block.
 */
function squawk(v: unknown, path: string): string {
  const code = str(v, path)
  if (!isSquawk(code)) fail(path, `is not a transponder code: "${code}"`)
  return code
}

function parseAtis(v: unknown, path: string): Atis {
  const o = obj(v, path)
  const wind = obj(o['wind'], `${path}.wind`)
  return {
    letterIndex: num(o['letterIndex'], `${path}.letterIndex`),
    arrivals: arr(o['arrivals'], `${path}.arrivals`).map((r, i) =>
      str(r, `${path}.arrivals[${i}]`),
    ),
    departures: arr(o['departures'], `${path}.departures`).map((r, i) =>
      str(r, `${path}.departures[${i}]`),
    ),
    wind: {
      fromDeg: num(wind['fromDeg'], `${path}.wind.fromDeg`),
      speedKts: num(wind['speedKts'], `${path}.wind.speedKts`),
    },
  }
}

/** Every difficulty name, for the save file's validator. */
const DIFFICULTY_NAMES = ['easy', 'normal', 'hard', 'pro'] as const
const SESSION_MODES = ['career', 'sandbox'] as const

function parseController(v: unknown): SavedController | null {
  if (v === null) return null
  const o = obj(v, 'save.controller')
  return {
    initials: str(o['initials'], 'save.controller.initials'),
    position: str(o['position'], 'save.controller.position'),
    enforceAirspace: bool(o['enforceAirspace'], 'save.controller.enforceAirspace'),
    difficulty: oneOf(o['difficulty'], 'save.controller.difficulty', DIFFICULTY_NAMES),
    mode: oneOf(o['mode'], 'save.controller.mode', SESSION_MODES),
  }
}

function parseEmergencies(v: unknown, path: string): EmergencyFlowState | null {
  if (v === null || v === undefined) return null
  const o = obj(v, path)
  return {
    seed: num(o['seed'], `${path}.seed`),
    draws: num(o['draws'], `${path}.draws`),
    sinceLast: num(o['sinceLast'], `${path}.sinceLast`),
    waitSeconds: num(o['waitSeconds'], `${path}.waitSeconds`),
    declared: num(o['declared'], `${path}.declared`),
  }
}

function parseOverflights(v: unknown, path: string): OverflightState | null {
  if (v === null || v === undefined) return null
  const o = obj(v, path)
  return {
    seed: num(o['seed'], `${path}.seed`),
    draws: num(o['draws'], `${path}.draws`),
    sinceLastSpawn: num(o['sinceLastSpawn'], `${path}.sinceLastSpawn`),
    waitSeconds: num(o['waitSeconds'], `${path}.waitSeconds`),
    spawned: num(o['spawned'], `${path}.spawned`),
    lastUsedAt: arr(o['lastUsedAt'], `${path}.lastUsedAt`).map((pair, i) => {
      const p = `${path}.lastUsedAt[${i}]`
      if (!Array.isArray(pair) || pair.length !== 2) {
        return fail(p, 'must be a pair [id, seconds]') as never
      }
      return [str(pair[0], `${p}[0]`), num(pair[1], `${p}[1]`)] as const
    }),
  }
}

function parseSpawner(v: unknown, path: string): SpawnerState {
  const o = obj(v, path)
  return {
    seed: num(o['seed'], `${path}.seed`),
    draws: num(o['draws'], `${path}.draws`),
    sinceLastSpawn: num(o['sinceLastSpawn'], `${path}.sinceLastSpawn`),
    waitSeconds: num(o['waitSeconds'], `${path}.waitSeconds`),
    spawned: num(o['spawned'], `${path}.spawned`),
    deferred: num(o['deferred'], `${path}.deferred`),
    lastUsedAt: arr(o['lastUsedAt'], `${path}.lastUsedAt`).map((pair, i) => {
      const p = arr(pair, `${path}.lastUsedAt[${i}]`)
      return [str(p[0], `${path}.lastUsedAt[${i}][0]`), num(p[1], `${path}.lastUsedAt[${i}][1]`)] as const
    }),
    flights: {
      issued: arr(obj(o['flights'], `${path}.flights`)['issued'], `${path}.flights.issued`).map(
        (c, i) => str(c, `${path}.flights.issued[${i}]`),
      ),
      fallbackSequence: num(
        obj(o['flights'], `${path}.flights`)['fallbackSequence'],
        `${path}.flights.fallbackSequence`,
      ),
    },
  }
}

/** The whole of a session, as text. */
export function serialise(game: SavedGame): string {
  return JSON.stringify(game)
}

/**
 * Reads a saved session, or says why it will not.
 *
 * Refuses a save from another airport and a save from another version of
 * the format: both would load into a world that does not match, and a
 * refusal with a reason beats an aeroplane holding at a fix that no longer
 * exists.
 */
export function parseSavedGame(text: string, at: { readonly airport: string }): LoadResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'that is not a saved game' }
  }

  try {
    const o = obj(raw, 'save')
    const version = num(o['version'], 'save.version')
    if (version !== SAVE_VERSION) {
      return {
        ok: false,
        reason: `that save is version ${version}; this is version ${SAVE_VERSION}`,
      }
    }

    const airport = str(o['airport'], 'save.airport')
    if (airport !== at.airport) {
      return { ok: false, reason: `that save was flown at ${airport}, not ${at.airport}` }
    }

    const clock = obj(o['clock'], 'save.clock')
    const score = obj(o['score'], 'save.score')
    const controller = o['controller']

    return {
      ok: true,
      game: {
        version,
        airport,
        savedAt: str(o['savedAt'], 'save.savedAt'),
        clock: {
          ticks: num(clock['ticks'], 'save.clock.ticks'),
          elapsedSeconds: num(clock['elapsedSeconds'], 'save.clock.elapsedSeconds'),
          timeOfDaySeconds: num(clock['timeOfDaySeconds'], 'save.clock.timeOfDaySeconds'),
        },
        score: {
          points: num(score['points'], 'save.score.points'),
          landed: num(score['landed'], 'save.score.landed'),
          lost: num(score['lost'], 'save.score.lost'),
          transited: num(score['transited'], 'save.score.transited'),
          emergencies: num(score['emergencies'], 'save.score.emergencies'),
        },
        atis: parseAtis(o['atis'], 'save.atis'),
        controller: parseController(controller),
        selected: nullableStr(o['selected'], 'save.selected'),
        traffic: arr(o['traffic'], 'save.traffic').map((a, i) =>
          parseAircraft(a, `save.traffic[${i}]`),
        ),
        spawner: parseSpawner(o['spawner'], 'save.spawner'),
        overflights: parseOverflights(o['overflights'], 'save.overflights'),
        emergencies: parseEmergencies(o['emergencies'], 'save.emergencies'),
      },
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Invalid ? e.message : 'that save is unreadable' }
  }
}
