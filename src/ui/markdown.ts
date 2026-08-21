/**
 * A small Markdown renderer, for showing the project's own documentation
 * inside the game.
 *
 * Deliberately not a library. The project has zero runtime dependencies and
 * this is the only place Markdown is displayed, so what is implemented is
 * exactly the subset `TUTORIAL.md` uses: headings, paragraphs, bullet and
 * numbered lists, block quotes, fenced code, tables, horizontal rules, and
 * inline code, bold, italic and links.
 *
 * Two things it does NOT do, on purpose:
 *
 * - **No HTML pass-through.** Every piece of text reaches the document
 *   through `textContent`, never `innerHTML`, so a document can only ever
 *   produce text and the elements below -- there is no path from editing a
 *   Markdown file to injecting markup.
 * - **No link targets.** The only links in the guide point at sibling
 *   Markdown files, which do not exist as pages inside the app. The link
 *   text is kept and the target dropped, rather than rendering something
 *   that looks clickable and is not.
 */

/** Anything the renderer will not recognise is shown as plain text. */
export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i += 1
      continue
    }

    if (line.startsWith('```')) {
      i = fence(lines, i, out)
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.appendChild(document.createElement('hr'))
      i += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      const el = document.createElement(`h${Math.min(level, 6)}`)
      inline(heading[2] ?? '', el)
      out.appendChild(el)
      i += 1
      continue
    }

    if (line.startsWith('|') && isTableRule(lines[i + 1])) {
      i = table(lines, i, out)
      continue
    }
    if (line.startsWith('>')) {
      i = quote(lines, i, out)
      continue
    }
    if (bulletOf(line) !== null || numberOf(line) !== null) {
      i = list(lines, i, out)
      continue
    }

    i = paragraph(lines, i, out)
  }

  return out
}

/* ------------------------------------------------------------- helpers */

const bulletOf = (line: string | undefined): string | null => {
  const m = /^[-*+]\s+(.*)$/.exec(line ?? '')
  return m ? (m[1] ?? '') : null
}

const numberOf = (line: string | undefined): string | null => {
  const m = /^\d+[.)]\s+(.*)$/.exec(line ?? '')
  return m ? (m[1] ?? '') : null
}

/** A table's second line: |---|---| , with optional alignment colons. */
const isTableRule = (line: string | undefined): boolean =>
  /^\|(\s*:?-+:?\s*\|)+$/.test((line ?? '').trim())

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/** True where a line ends the paragraph it would otherwise continue. */
function startsBlock(line: string | undefined): boolean {
  if (line === undefined) return true
  const t = line.trim()
  if (t === '') return true
  if (t.startsWith('```') || t.startsWith('>') || t.startsWith('|')) return true
  if (/^#{1,6}\s/.test(t)) return true
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true
  return bulletOf(t) !== null || numberOf(t) !== null
}

/* -------------------------------------------------------------- blocks */

function fence(lines: readonly string[], start: number, out: DocumentFragment): number {
  let i = start + 1
  const body: string[] = []
  while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
    body.push(lines[i] ?? '')
    i += 1
  }
  const pre = document.createElement('pre')
  // Text, not markup: a code block is shown exactly as written.
  pre.textContent = body.join('\n')
  out.appendChild(pre)
  // Step past the closing fence, if there is one.
  return i < lines.length ? i + 1 : i
}

function paragraph(lines: readonly string[], start: number, out: DocumentFragment): number {
  const body: string[] = [lines[start] ?? '']
  let i = start + 1
  // Markdown joins consecutive lines into one paragraph, which matters
  // here: the source is hard-wrapped at 96 columns and would otherwise
  // break in the middle of sentences.
  while (i < lines.length && !startsBlock(lines[i])) {
    body.push(lines[i] ?? '')
    i += 1
  }
  const p = document.createElement('p')
  inline(body.join(' '), p)
  out.appendChild(p)
  return i
}

function quote(lines: readonly string[], start: number, out: DocumentFragment): number {
  const body: string[] = []
  let i = start
  while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
    body.push((lines[i] ?? '').replace(/^>\s?/, ''))
    i += 1
  }
  const el = document.createElement('blockquote')
  // A quote can hold several paragraphs, so it recurses.
  el.appendChild(renderMarkdown(body.join('\n')))
  out.appendChild(el)
  return i
}

function list(lines: readonly string[], start: number, out: DocumentFragment): number {
  const ordered = numberOf(lines[start]) !== null
  const el = document.createElement(ordered ? 'ol' : 'ul')
  let i = start

  while (i < lines.length) {
    const item = ordered ? numberOf(lines[i]) : bulletOf(lines[i])
    if (item === null) break
    const parts = [item]
    i += 1
    // Continuation lines are indented under their bullet.
    while (i < lines.length && /^\s+\S/.test(lines[i] ?? '') && !startsBlock((lines[i] ?? '').trim())) {
      parts.push((lines[i] ?? '').trim())
      i += 1
    }
    const li = document.createElement('li')
    inline(parts.join(' '), li)
    el.appendChild(li)
  }

  out.appendChild(el)
  return i
}

function table(lines: readonly string[], start: number, out: DocumentFragment): number {
  const el = document.createElement('table')
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const cell of cellsOf(lines[start] ?? '')) {
    const th = document.createElement('th')
    inline(cell, th)
    headRow.appendChild(th)
  }
  head.appendChild(headRow)
  el.appendChild(head)

  const body = document.createElement('tbody')
  // start is the header, start + 1 the |---| rule.
  let i = start + 2
  while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
    const tr = document.createElement('tr')
    for (const cell of cellsOf(lines[i] ?? '')) {
      const td = document.createElement('td')
      inline(cell, td)
      tr.appendChild(td)
    }
    body.appendChild(tr)
    i += 1
  }
  el.appendChild(body)
  out.appendChild(el)
  return i
}

/* -------------------------------------------------------------- inline */

/**
 * Inline spans, in precedence order. Code comes first so that its contents
 * are never treated as further markup.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]*\))/

function inline(text: string, into: Node): void {
  let rest = text
  for (;;) {
    const m = INLINE.exec(rest)
    if (!m || m.index === undefined) break

    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)))
    const token = m[0]

    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      into.appendChild(code)
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong')
      inline(token.slice(2, -2), strong)
      into.appendChild(strong)
    } else if (token.startsWith('*')) {
      const em = document.createElement('em')
      inline(token.slice(1, -1), em)
      into.appendChild(em)
    } else {
      // Link text only. See the note at the top of the file.
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token
      inline(label, into)
    }

    rest = rest.slice(m.index + token.length)
  }
  if (rest !== '') into.appendChild(document.createTextNode(rest))
}
