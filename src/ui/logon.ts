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
  private readonly opts: LogonOptions
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly airspace: HTMLInputElement
  private readonly error: HTMLParagraphElement
  private readonly goButton: HTMLButtonElement
  private isVisible = true

  constructor(opts: LogonOptions) {
    this.opts = opts

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
