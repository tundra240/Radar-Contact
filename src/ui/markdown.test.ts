// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import guideSource from '../../TUTORIAL.md?raw'

/**
 * The renderer only has to handle what the project's own documents use, so
 * these tests are mostly the real constructs from TUTORIAL.md -- plus the
 * one property that matters more than any feature: text from a Markdown
 * file can never become markup.
 */

let host: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.appendChild(host)
})

const render = (src: string): HTMLElement => {
  host.replaceChildren(renderMarkdown(src))
  return host
}

const tags = (el: HTMLElement): string[] => [...el.children].map((c) => c.tagName)

describe('blocks', () => {
  it('renders headings at their level', () => {
    const el = render('# One\n\n## Two\n\n### Three')
    expect(tags(el)).toEqual(['H1', 'H2', 'H3'])
    expect(el.querySelector('h2')?.textContent).toBe('Two')
  })

  it('joins a hard-wrapped paragraph into one', () => {
    // The source is wrapped at 96 columns, so treating each line as its own
    // paragraph would break sentences in half.
    const el = render('One line\nand its continuation.\n\nA second paragraph.')
    const ps = el.querySelectorAll('p')
    expect(ps).toHaveLength(2)
    expect(ps[0]?.textContent).toBe('One line and its continuation.')
  })

  it('renders bullet and numbered lists', () => {
    const el = render('- first\n- second\n\n1. one\n2. two')
    expect(tags(el)).toEqual(['UL', 'OL'])
    expect(el.querySelectorAll('ul li')).toHaveLength(2)
    expect(el.querySelectorAll('ol li')).toHaveLength(2)
  })

  it('folds an indented continuation into its bullet', () => {
    const el = render('- a bullet that\n  runs onto the next line\n- another')
    const items = el.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toBe('a bullet that runs onto the next line')
  })

  it('renders a table with a head and a body', () => {
    const el = render('| Fix | Where |\n|---|---|\n| BNN | north |\n| OCK | south |')
    expect(el.querySelectorAll('th')).toHaveLength(2)
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(el.querySelectorAll('td')[1]?.textContent).toBe('north')
  })

  it('accepts an aligned table rule', () => {
    const el = render('| A | B |\n|:--|--:|\n| 1 | 2 |')
    expect(el.querySelector('table')).not.toBeNull()
  })

  it('keeps a fenced block exactly as written', () => {
    // The guide has an ASCII diagram in it; collapsing its whitespace would
    // destroy it.
    const el = render('```\n  a   b\n   |\n```')
    expect(el.querySelector('pre')?.textContent).toBe('  a   b\n   |')
  })

  it('does not parse markup inside a fenced block', () => {
    const el = render('```\n**not bold**\n```')
    expect(el.querySelector('pre strong')).toBeNull()
    expect(el.querySelector('pre')?.textContent).toBe('**not bold**')
  })

  it('renders a block quote, and blocks inside it', () => {
    const el = render('> **Note.** One line\n> and another.\n\nAfter.')
    const quote = el.querySelector('blockquote')
    expect(quote).not.toBeNull()
    expect(quote?.querySelector('strong')?.textContent).toBe('Note.')
    expect(quote?.textContent).toContain('One line and another.')
  })

  it('renders a horizontal rule', () => {
    expect(render('a\n\n---\n\nb').querySelector('hr')).not.toBeNull()
  })

  it('treats a table row as a block, not as paragraph text', () => {
    // Otherwise a paragraph immediately before a table swallows it.
    const el = render('Intro line.\n| A | B |\n|---|---|\n| 1 | 2 |')
    expect(tags(el)).toEqual(['P', 'TABLE'])
  })
})

describe('inline', () => {
  it('renders bold, italic and code', () => {
    const el = render('A **bold** and *emphasis* and `code` here.')
    expect(el.querySelector('strong')?.textContent).toBe('bold')
    expect(el.querySelector('em')?.textContent).toBe('emphasis')
    expect(el.querySelector('code')?.textContent).toBe('code')
  })

  it('does not parse inside inline code', () => {
    const el = render('`**kept**`')
    expect(el.querySelector('code')?.textContent).toBe('**kept**')
    expect(el.querySelector('strong')).toBeNull()
  })

  it('keeps link text and drops the target', () => {
    // The only links point at sibling Markdown files, which are not pages
    // inside the app; something that looked clickable and was not would be
    // worse than plain text.
    const el = render('See [TUTORIAL.md](TUTORIAL.md) for more.')
    expect(el.textContent).toBe('See TUTORIAL.md for more.')
    expect(el.querySelector('a')).toBeNull()
  })

  it('leaves the ASCII dash convention alone', () => {
    // The documents use -- rather than an em dash to stay ASCII.
    expect(render('one -- two').textContent).toBe('one -- two')
  })
})

describe('safety', () => {
  it('never turns document text into markup', () => {
    // The whole point of reading a file at runtime is that the file can be
    // edited. It must not be a way to inject elements.
    const el = render('A <script>alert(1)</script> and <b>bold</b>.')
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
  })

  it('survives an empty document', () => {
    expect(render('').children).toHaveLength(0)
    expect(render('\n\n\n').children).toHaveLength(0)
  })

  it('survives an unclosed fence', () => {
    const el = render('```\nstill open')
    expect(el.querySelector('pre')?.textContent).toBe('still open')
  })
})

describe('the real guide', () => {
  it('renders TUTORIAL.md into something with structure', () => {
    // Guards the actual file, not just synthetic input: if the document is
    // reorganised into constructs the renderer does not know, this notices.
    const el = render(guideSource)
    expect(el.querySelectorAll('h1').length).toBeGreaterThanOrEqual(1)
    expect(el.querySelectorAll('h2').length).toBeGreaterThan(3)
    expect(el.querySelectorAll('table').length).toBeGreaterThan(3)
    expect(el.querySelectorAll('pre').length).toBeGreaterThanOrEqual(1)
    expect(el.querySelectorAll('blockquote').length).toBeGreaterThanOrEqual(1)
    expect(el.querySelectorAll('p').length).toBeGreaterThan(10)
  })

  it('carries the content across, not just the shape', () => {
    const text = render(guideSource).textContent ?? ''
    expect(text).toContain('Bovingdon')
    expect(text).toContain('North Atlantic')
    expect(text).toContain('bottom of the stack')
  })

  it('leaves no raw table pipes or hashes in the text', () => {
    // A sign the block parsers missed something and fell through to a
    // paragraph.
    const text = render(guideSource).textContent ?? ''
    expect(text).not.toContain('|---')
    expect(text).not.toMatch(/(^|\n)#{1,6} /)
  })
})
