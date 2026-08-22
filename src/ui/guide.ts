import { renderMarkdown } from './markdown'
import { setToolLabel } from './icons'

/**
 * The in-game guide: a book button that opens the project's own how-to-play
 * document in a window.
 *
 * The text is **not written here**. It is imported from a Markdown file at
 * the root of the repository and rendered at runtime, so the guide has one
 * source that is also the file a person would naturally edit. Editing it
 * with the dev server running updates the panel immediately; a production
 * build inlines whatever the file said at build time.
 *
 * The file to read is passed in rather than imported here, so this module
 * has no opinion about which document it is showing and the test can hand
 * it one of its own.
 */

export interface GuideOptions {
  readonly mount: HTMLElement
  /** Raw Markdown. See `main.ts` for where it comes from. */
  readonly source: string
  /** Caption strip text. */
  readonly title: string
  /** Shown under the caption: where to edit what is on screen. */
  readonly note?: string
}

export class Guide {
  private readonly root: HTMLDivElement
  private readonly button: HTMLButtonElement
  private readonly window: HTMLDivElement
  private readonly body: HTMLDivElement
  private isOpen = false

  private readonly onDocumentPointerDown: (e: PointerEvent) => void
  private readonly onDocumentKeyDown: (e: KeyboardEvent) => void

  constructor(opts: GuideOptions) {
    this.root = document.createElement('div')
    this.root.className = 'guide'

    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'mode-toggle guide-button'
    // Drawn rather than an emoji: an emoji renders in whatever colour and
    // weight the platform feels like, which is never the rail's. The label
    // below is what a screen reader reads, since a glyph is not a name.
    setToolLabel(this.button, 'guide', 'GUIDE')
    this.button.title = 'How to play'
    this.button.setAttribute('aria-label', 'How to play')
    this.button.setAttribute('aria-haspopup', 'dialog')
    this.button.addEventListener('click', () => this.setOpen(!this.isOpen))
    this.root.appendChild(this.button)

    this.window = document.createElement('div')
    this.window.className = 'guide-window'
    this.window.hidden = true
    this.window.setAttribute('role', 'dialog')
    this.window.setAttribute('aria-label', opts.title)

    const caption = document.createElement('div')
    caption.className = 'guide-caption'

    const captionText = document.createElement('span')
    captionText.textContent = opts.title
    caption.appendChild(captionText)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'guide-close'
    close.textContent = 'X'
    close.title = 'Close'
    close.setAttribute('aria-label', 'Close the guide')
    close.addEventListener('click', () => this.setOpen(false))
    caption.appendChild(close)

    this.window.appendChild(caption)

    if (opts.note !== undefined) {
      const note = document.createElement('p')
      note.className = 'guide-note'
      note.textContent = opts.note
      this.window.appendChild(note)
    }

    this.body = document.createElement('div')
    this.body.className = 'guide-body'
    this.body.tabIndex = 0
    this.body.appendChild(renderMarkdown(opts.source))
    this.window.appendChild(this.body)

    this.root.appendChild(this.window)
    opts.mount.appendChild(this.root)

    this.onDocumentPointerDown = (e: PointerEvent) => {
      if (!this.isOpen) return
      if (e.target instanceof Node && this.root.contains(e.target)) return
      this.setOpen(false)
    }
    this.onDocumentKeyDown = (e: KeyboardEvent) => {
      if (this.isOpen && e.key === 'Escape') this.setOpen(false)
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown)
    document.addEventListener('keydown', this.onDocumentKeyDown)

    this.paint()
  }

  get element(): HTMLElement {
    return this.root
  }

  get open(): boolean {
    return this.isOpen
  }

  setOpen(open: boolean): void {
    this.isOpen = open
    this.paint()
    // The body scrolls, so it takes focus and the arrow keys work without
    // having to click into it first.
    if (open) this.body.focus()
  }

  toggle(): void {
    this.setOpen(!this.isOpen)
  }

  /** Releases the document listeners. Only tests need this. */
  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown)
    document.removeEventListener('keydown', this.onDocumentKeyDown)
    this.root.remove()
  }

  private paint(): void {
    this.window.hidden = !this.isOpen
    this.button.setAttribute('aria-expanded', String(this.isOpen))
    this.button.classList.toggle('is-open', this.isOpen)
  }
}
