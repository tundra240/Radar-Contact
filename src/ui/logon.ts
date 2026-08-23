/**
 * The main menu: a system logon screen.
 *
 * Displays over the whole shell before the session starts, in the idiom of
 * the terminal software the rest of the interface is modelled on -- a
 * centred window with a caption strip, a couple of sunken fields, and a
 * boot summary of what the radar has loaded.
 *
 * Two deliberate decisions:
 *
 * - **Settings are not reimplemented here.** The button hands off to the
 *   same `Menu` the scope uses, so there is exactly one place the display
 *   scheme and the overlays are configured, and a change made before
 *   logging on is the change that applies afterwards.
 * - **Nothing is authenticated.** This is a position logon in the sense a
 *   controller means it -- who is working, and what they are working -- so
 *   it takes initials and shows the position. There is no password field
 *   and no credential of any kind, because there is nothing to check them
 *   against and a box that looks like one would be a lie.
 */

import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  type DifficultyName,
} from '../sim/difficulty'

/**
 * What a session is for.
 *
 * Career locks the setting for the shift, which is the point of it: a run
 * whose difficulty could be turned down half way through is not a run at
 * that difficulty. Sandbox keeps the preset as a starting point and lets it
 * be changed, because that is what a sandbox is.
 */
export type SessionMode = 'career' | 'sandbox'

/** One field on the menu. */
export interface AirportChoice {
  readonly icao: string
  readonly name: string
  readonly tier: string
  readonly brief: string
}

export interface LogonDetails {
  /** Operating initials, two or three letters. */
  readonly initials: string
  /** The position being worked, e.g. EGLL_APP. */
  readonly position: string
  /**
   * Whether the area of responsibility is enforced for this session.
   *
   * On, the published airspace is the job: the rest of the map is dimmed
   * and traffic outside the boundary can be watched and not touched. Off,
   * the whole picture is live and anything on it will take a clearance.
   *
   * A rule for the shift rather than a display setting, which is why it is
   * chosen here and not in the options menu.
   */
  readonly enforceAirspace: boolean
  readonly difficulty: DifficultyName
  readonly mode: SessionMode
}

export interface LogonOptions {
  readonly mount: HTMLElement
  /** Shown large: the field and the sector being worked. */
  readonly title: string
  readonly subtitle: string
  readonly position: string
  /** Boot summary lines -- what the radar has actually loaded. */
  readonly facts: readonly string[]
  /** Remembered initials, prefilled. */
  readonly initials: string
  /** Remembered airspace setting, preselected. */
  readonly enforceAirspace: boolean
  /** Remembered difficulty, preselected. */
  readonly difficulty: DifficultyName
  readonly mode: SessionMode
  /** The fields on offer, gentlest first. */
  readonly airports: readonly AirportChoice[]
  /** Which one is loaded now. */
  readonly airport: string
  /**
   * Asked for a different field.
   *
   * Not a value returned with the logon: a sector is the world the whole
   * session is built on, so changing it reloads rather than being carried
   * through as a preference.
   */
  readonly onAirport: (icao: string) => void
  readonly onLogon: (details: LogonDetails) => void
  /**
   * Log on and start the tutorial instead of a free session.
   *
   * Offered here rather than on the tool rail because it is a choice about
   * what this sitting is for, and that is a question you answer before you
   * have traffic rather than half way through working it.
   */
  readonly onTutorial: (details: LogonDetails) => void
  readonly onSettings: () => void
}

const MIN_INITIALS = 2
const MAX_INITIALS = 3

/** Two or three letters. Anything else is not a set of operating initials. */
export function validateInitials(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase()
  if (!/^[A-Z]+$/.test(cleaned)) return null
  if (cleaned.length < MIN_INITIALS || cleaned.length > MAX_INITIALS) return null
  return cleaned
}

export class Logon {
  private difficulty: DifficultyName = DEFAULT_DIFFICULTY
  private mode: SessionMode = 'career'
  private readonly levelButtons: HTMLButtonElement[] = []
  private readonly fieldButtons: HTMLButtonElement[] = []
  private fieldNote!: HTMLParagraphElement
  private readonly modeButtons: HTMLButtonElement[] = []
  private levelNote!: HTMLParagraphElement
  private readonly opts: LogonOptions
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly airspace: HTMLInputElement
  private readonly error: HTMLParagraphElement
  private readonly goButton: HTMLButtonElement
  private isVisible = true

  constructor(opts: LogonOptions) {
    this.opts = opts
    this.difficulty = opts.difficulty
    this.mode = opts.mode

    this.root = document.createElement('div')
    this.root.className = 'logon'
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-label', 'Radar system logon')

    const win = document.createElement('div')
    win.className = 'logon-window'

    const caption = document.createElement('div')
    caption.className = 'logon-caption'
    caption.textContent = 'Radar Contact -- system logon'
    win.appendChild(caption)

    const body = document.createElement('div')
    body.className = 'logon-body'

    const brand = document.createElement('div')
    brand.className = 'logon-brand'
    brand.textContent = opts.title
    body.appendChild(brand)

    const sub = document.createElement('div')
    sub.className = 'logon-sub'
    sub.textContent = opts.subtitle
    body.appendChild(sub)

    // The boot summary. Period-appropriate, and it doubles as a sanity
    // check: if the airport data failed to load, this is where you see it.
    const facts = document.createElement('ul')
    facts.className = 'logon-facts'
    for (const line of opts.facts) {
      const li = document.createElement('li')
      li.textContent = line
      facts.appendChild(li)
    }
    body.appendChild(facts)

    const fields = document.createElement('div')
    fields.className = 'logon-fields'

    const idRow = document.createElement('label')
    idRow.className = 'logon-field'
    const idLabel = document.createElement('span')
    idLabel.textContent = 'Controller'
    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.className = 'logon-input'
    this.input.maxLength = MAX_INITIALS
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.placeholder = 'XX'
    this.input.value = opts.initials
    this.input.setAttribute('aria-label', 'Operating initials')
    idRow.append(idLabel, this.input)
    fields.appendChild(idRow)

    const airspaceRow = document.createElement('label')
    airspaceRow.className = 'logon-field logon-check'
    const airspaceLabel = document.createElement('span')
    airspaceLabel.textContent = 'Airspace'
    this.airspace = document.createElement('input')
    this.airspace.type = 'checkbox'
    this.airspace.className = 'logon-toggle'
    this.airspace.checked = opts.enforceAirspace
    this.airspace.setAttribute('aria-label', 'Enforce the area of responsibility')
    const airspaceNote = document.createElement('span')
    airspaceNote.className = 'logon-note'
    airspaceNote.textContent = 'Only control traffic inside it'
    airspaceRow.append(airspaceLabel, this.airspace, airspaceNote)
    airspaceRow.title =
      'On: the map outside your airspace is dimmed and traffic is not yours until it crosses in. ' +
      'Off: the whole picture is live and anything on it takes a clearance.'
    fields.appendChild(airspaceRow)

    const posRow = document.createElement('div')
    posRow.className = 'logon-field'
    const posLabel = document.createElement('span')
    posLabel.textContent = 'Position'
    const pos = document.createElement('output')
    pos.className = 'logon-output'
    pos.textContent = opts.position
    posRow.append(posLabel, pos)
    fields.appendChild(posRow)

    body.appendChild(fields)

    this.error = document.createElement('p')
    this.error.className = 'logon-error'
    this.error.hidden = true
    this.error.setAttribute('role', 'alert')
    body.appendChild(this.error)

    body.appendChild(this.buildAirports())
    body.appendChild(this.buildDifficulty())
    body.appendChild(this.buildMode())

    const actions = document.createElement('div')
    actions.className = 'logon-actions'

    this.goButton = document.createElement('button')
    this.goButton.type = 'button'
    this.goButton.className = 'logon-button logon-go'
    this.goButton.textContent = 'Log on'
    this.goButton.addEventListener('click', () => this.submit())
    actions.appendChild(this.goButton)

    const tutorial = document.createElement('button')
    tutorial.type = 'button'
    tutorial.className = 'logon-button logon-tutorial'
    tutorial.textContent = 'Tutorial'
    tutorial.title = 'A guided lesson: the scope, the hold, a vectored ILS and the weather'
    tutorial.addEventListener('click', () => this.submit('tutorial'))
    actions.appendChild(tutorial)

    const settings = document.createElement('button')
    settings.type = 'button'
    settings.className = 'logon-button logon-settings'
    settings.textContent = 'Settings'
    settings.title = 'Display scheme, overlays and simulation rate'
    settings.addEventListener('click', () => this.opts.onSettings())
    actions.appendChild(settings)

    body.appendChild(actions)

    const foot = document.createElement('p')
    foot.className = 'logon-foot'
    // Says plainly what this is, so nobody reads it as an account prompt.
    foot.textContent = 'No account and no password: initials identify the position only.'
    body.appendChild(foot)

    win.appendChild(body)
    this.root.appendChild(win)
    opts.mount.appendChild(this.root)

    // Light the remembered choices, and say what they mean, before anybody
    // looks at them.
    this.describeAirport(opts.airport)
    this.paintDifficulty()

    // Uppercase as typed, because operating initials are always written
    // that way and correcting it afterwards feels like a rejection.
    this.input.addEventListener('input', () => {
      const caret = this.input.selectionStart
      this.input.value = this.input.value.toUpperCase().replace(/[^A-Z]/g, '')
      if (caret !== null) this.input.setSelectionRange(caret, caret)
      this.clearError()
    })

    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      this.submit()
    })
  }

  get element(): HTMLElement {
    return this.root
  }

  get visible(): boolean {
    return this.isVisible
  }

  focus(): void {
    this.input.focus()
    this.input.select()
  }

  hide(): void {
    this.isVisible = false
    this.root.hidden = true
  }

  show(): void {
    this.isVisible = true
    this.root.hidden = false
    this.focus()
  }

  destroy(): void {
    this.root.remove()
  }

  /**
   * The fields, with a paragraph on whichever is under the cursor.
   *
   * The brief matters more than the name: "Nice" tells somebody nothing,
   * and "a strip of usable airspace between the Alps and the sea" tells
   * them what they are about to be asked to do.
   */
  private buildAirports(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'logon-section'

    const title = document.createElement('div')
    title.className = 'logon-section-title'
    title.textContent = 'Sector'
    wrap.appendChild(title)

    const row = document.createElement('div')
    row.className = 'logon-levels'
    for (const field of this.opts.airports) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'logon-level logon-field'
      button.dataset['airport'] = field.icao
      button.textContent = field.icao
      button.title = `${field.name} -- ${field.tier}`
      button.addEventListener('click', () => this.opts.onAirport(field.icao))
      button.addEventListener('pointerenter', () => this.describeAirport(field.icao))
      button.addEventListener('pointerleave', () => this.describeAirport(this.opts.airport))
      row.appendChild(button)
      this.fieldButtons.push(button)
    }
    wrap.appendChild(row)

    this.fieldNote = document.createElement('p')
    this.fieldNote.className = 'logon-note logon-field-note'
    wrap.appendChild(this.fieldNote)
    return wrap
  }

  /** Say what a field is like to work. */
  private describeAirport(icao: string): void {
    const field = this.opts.airports.find((f) => f.icao === icao)
    if (field === undefined) return
    this.fieldNote.textContent = `${field.name} (${field.tier}). ${field.brief}`
    for (const button of this.fieldButtons) {
      const on = button.dataset['airport'] === this.opts.airport
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
    }
  }

  /** The four settings, as a row of buttons with the chosen one lit. */
  private buildDifficulty(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'logon-section'

    const title = document.createElement('div')
    title.className = 'logon-section-title'
    title.textContent = 'Difficulty'
    wrap.appendChild(title)

    const row = document.createElement('div')
    row.className = 'logon-levels'
    for (const name of DIFFICULTY_ORDER) {
      const settings = DIFFICULTIES[name]
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'logon-level'
      button.dataset['level'] = name
      button.textContent = settings.label
      button.title = settings.summary
      button.addEventListener('click', () => {
        this.difficulty = name
        this.paintDifficulty()
      })
      row.appendChild(button)
      this.levelButtons.push(button)
    }
    wrap.appendChild(row)

    this.levelNote = document.createElement('p')
    // Its own class: .logon-note already belongs to the airspace note, and
    // two elements answering to one name is a query that finds the wrong
    // one depending on which came first.
    this.levelNote.className = 'logon-note logon-level-note'
    wrap.appendChild(this.levelNote)
    return wrap
  }

  /** Career or sandbox, which decides whether the setting is fixed. */
  private buildMode(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'logon-section'

    const row = document.createElement('div')
    row.className = 'logon-levels'
    for (const mode of ['career', 'sandbox'] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'logon-level logon-mode'
      button.dataset['mode'] = mode
      button.textContent = mode === 'career' ? 'Career' : 'Sandbox'
      button.title =
        mode === 'career'
          ? 'The setting is fixed for the whole session'
          : 'Start from this setting and change it whenever you like'
      button.addEventListener('click', () => {
        this.mode = mode
        this.paintDifficulty()
      })
      row.appendChild(button)
      this.modeButtons.push(button)
    }
    wrap.appendChild(row)
    return wrap
  }

  /** Light the chosen setting, and say what it means. */
  private paintDifficulty(): void {
    for (const button of this.levelButtons) {
      const on = button.dataset['level'] === this.difficulty
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
    }
    for (const button of this.modeButtons) {
      const on = button.dataset['mode'] === this.mode
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-pressed', String(on))
    }
    const settings = DIFFICULTIES[this.difficulty]
    this.levelNote.textContent =
      `${settings.summary} ${settings.arrivalsPerHour} arrivals an hour, ` +
      `score x${settings.scoreMultiplier}.` +
      (this.mode === 'career' ? ' Fixed for the session.' : ' Changeable as you go.')
  }

  private submit(into: 'session' | 'tutorial' = 'session'): void {
    const initials = validateInitials(this.input.value)
    if (initials === null) {
      this.showError(
        `Operating initials are ${MIN_INITIALS} or ${MAX_INITIALS} letters, e.g. AB.`,
      )
      this.input.focus()
      return
    }
    this.clearError()
    const details = {
      initials,
      position: this.opts.position,
      enforceAirspace: this.airspace.checked,
      difficulty: this.difficulty,
      mode: this.mode,
    }
    if (into === 'tutorial') this.opts.onTutorial(details)
    else this.opts.onLogon(details)
  }

  private showError(message: string): void {
    this.error.textContent = message
    this.error.hidden = false
    this.input.setAttribute('aria-invalid', 'true')
  }

  private clearError(): void {
    this.error.hidden = true
    this.error.textContent = ''
    this.input.removeAttribute('aria-invalid')
  }
}
