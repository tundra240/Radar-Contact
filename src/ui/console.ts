/**
 * The command console: a prompt and a readback log.
 *
 * A dumb terminal, on purpose. It does not know what a command is, what an
 * aircraft is, or whether what was typed makes sense -- it takes a line,
 * hands it to `onSubmit`, and shows whatever it is told to show. Everything
 * that decides anything lives in `commands/parse.ts` and
 * `commands/apply.ts`, which are pure and tested without a DOM.
 *
 * The history is the one piece of state it does keep, because that is a
 * property of the terminal rather than of the simulation: up and down walk
 * back through what you typed, including the lines that were refused, since
 * a rejected line is usually one character away from a good one.
 */

export interface ConsoleOptions {
  readonly mount: HTMLElement
  /** Handed the raw line. The console makes no judgement about it. */
  readonly onSubmit: (line: string) => void
  /** Shown greyed in the prompt when there is nothing typed. */
  readonly placeholder?: string
}

/** How a line is shown. Readbacks and refusals must not look alike. */
export type LogKind = 'command' | 'readback' | 'reject' | 'note'

/** Lines kept in the log. Older ones are dropped from the top. */
const HISTORY_LINES = 200

export class CommandConsole {
  private readonly root: HTMLDivElement
  private readonly log: HTMLDivElement
  private readonly input: HTMLInputElement

  /** What has been typed, oldest first, for the up arrow. */
  private readonly typed: string[] = []
  /** Where the up arrow currently is; the length means "not browsing". */
  private cursor = 0
  /** What was in the box before the up arrow was first pressed. */
  private draft = ''

  constructor(opts: ConsoleOptions) {
    this.root = document.createElement('div')
    this.root.className = 'console'

    this.log = document.createElement('div')
    this.log.className = 'console-log'
    this.log.setAttribute('role', 'log')
    this.log.setAttribute('aria-live', 'polite')
    this.log.setAttribute('aria-label', 'Readback log')
    this.root.appendChild(this.log)

    const row = document.createElement('div')
    row.className = 'console-row'

    const prompt = document.createElement('span')
    prompt.className = 'console-prompt'
    prompt.textContent = '>'
    prompt.setAttribute('aria-hidden', 'true')
    row.appendChild(prompt)

    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.className = 'console-input'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.setAttribute('aria-label', 'Command line')
    if (opts.placeholder !== undefined) this.input.placeholder = opts.placeholder
    row.appendChild(this.input)

    this.root.appendChild(row)
    opts.mount.appendChild(this.root)

    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const line = this.input.value.trim()
        if (line === '') return
        this.remember(line)
        this.input.value = ''
        opts.onSubmit(line)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        this.walk(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        this.walk(1)
        return
      }
      if (e.key === 'Escape') {
        // Clears the line rather than closing anything: there is nothing to
        // close, and a half-typed clearance is worth being able to abandon.
        e.preventDefault()
        this.input.value = ''
        this.cursor = this.typed.length
      }
    })
  }

  get element(): HTMLElement {
    return this.root
  }

  focus(): void {
    this.input.focus()
  }

  /** For tests and for anything that needs to know what is half-typed. */
  get value(): string {
    return this.input.value
  }

  /**
   * Adds a line to the log.
   *
   * The log follows the newest line, but only when it is already at the
   * bottom: scrolling back to read an earlier refusal should not be yanked
   * away by the next readback.
   */
  write(text: string, kind: LogKind = 'note'): void {
    const atBottom =
      this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 4

    const line = document.createElement('p')
    line.className = `console-line is-${kind}`
    line.textContent = kind === 'command' ? `> ${text}` : text
    this.log.appendChild(line)

    while (this.log.childElementCount > HISTORY_LINES) {
      this.log.firstElementChild?.remove()
    }

    if (atBottom) this.log.scrollTop = this.log.scrollHeight
  }

  /* -------------------------------------------------------------- private */

  private remember(line: string): void {
    // Not the same line twice in a row: repeating a clearance is common and
    // filling the history with it makes the up arrow useless.
    if (this.typed[this.typed.length - 1] !== line) this.typed.push(line)
    this.cursor = this.typed.length
    this.draft = ''
  }

  private walk(by: number): void {
    if (this.typed.length === 0) return

    if (this.cursor === this.typed.length && by < 0) this.draft = this.input.value

    const next = Math.min(this.typed.length, Math.max(0, this.cursor + by))
    this.cursor = next
    this.input.value = next === this.typed.length ? this.draft : (this.typed[next] ?? '')
    // Caret to the end, so editing a recalled line starts where you expect.
    const end = this.input.value.length
    this.input.setSelectionRange(end, end)
  }
}
