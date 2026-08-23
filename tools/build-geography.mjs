/*
 * Builds the `geography` block for src/data/egll.json: the coastline, the
 * Thames and the London FIR boundary.
 *
 * Three sources, deliberately not the same one:
 *   - coastline    Natural Earth 10m coastline (public domain)
 *   - FIR boundary VATSIM UK Sector File, ARTCC/High/EGTT London FIR.txt
 *   - Thames       VATSIM UK Sector File, Misc Geo/Rivers.txt
 *
 * Public domain was preferred for the coastline because the sector file is
 * GPL-3.0 and this repository is already encumbered by it -- see
 * ATTRIBUTION.md, which also gives the URL for each input.
 *
 * All three are clipped to a box roughly 180 NM around Heathrow, simplified
 * in nautical-mile space, and emitted as OPEN polylines: the loader stores
 * them without closure, because joining the ends of a clipped shoreline
 * would draw a line straight across the sea.
 *
 * Usage:
 *   node tools/build-geography.mjs COASTLINE.geojson EGTT.txt RIVERS.txt OUT.json
 *
 * The other three fields have no sector file to draw on and are built by
 * tools/build-field-map.mjs instead, through the same line tools.
 *
 * Paste the result over the `geography` array in src/data/egll.json. Running
 * it against the same inputs reproduces the committed data exactly.
 */
import fs from 'node:fs'

import { DEFAULTS, lineWorks } from './lib/lines.mjs'

const ARP = { lat: 51.470748, lon: -0.459909 }

// Generous: at the 80 NM zoom ceiling a wide window shows about 170 NM
// half-width, and the camera can be panned further still.
const BOX = { minLat: 48.5, maxLat: 54.6, minLon: -6.6, maxLon: 4.6 }

/*
 * Clipping, simplification and chunking live in tools/lib/lines.mjs, which
 * every field's map is built through. They were here first and were lifted
 * out when Faro, Barcelona and Nice needed the same work done: there is no
 * version of "the coastline is prepared differently at Nice" that is not a
 * bug. What stays here is what is genuinely Heathrow's -- the sector file
 * formats, finding the Thames in an unlabelled pile of rivers, and the
 * width profile along it.
 *
 * The Heathrow coastline committed in egll.json is reproduced exactly by
 * the shared code; airport.test.ts asserts it against the same Natural
 * Earth input.
 */
const { toNM, clipPath, simplify, densify, chunk, asObjects, prepare, coastline } = lineWorks({
  arp: ARP,
  box: BOX,
})

const TOLERANCE_NM = DEFAULTS.toleranceNM
const MAX_SEGMENT_NM = DEFAULTS.maxSegmentNM

/** N051.28.00.000 -> signed decimal degrees */
function parseDms(s) {
  const m = /^([NSEW])(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return null
  const sign = m[1] === 'S' || m[1] === 'W' ? -1 : 1
  const sec = Number(m[4]) + (m[5] ? Number(m[5]) / 1000 : 0)
  return sign * (Number(m[2]) + Number(m[3]) / 60 + sec / 3600)
}

/**
 * The ARTCC segment format: one boundary SEGMENT per line, as
 * `<name> <lat1> <lon1> <lat2> <lon2>`. Consecutive segments are chained
 * where they meet, so the FIR comes out as continuous polylines rather
 * than several hundred disconnected two-point strokes.
 */
function firLines(file) {
  const segments = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const bare = line.split(';')[0].trim()
    if (bare === '' || bare.startsWith(';')) continue
    const dms = bare.match(/[NSEW]\d+\.\d+\.\d+(?:\.\d+)?/g)
    if (!dms || dms.length < 4) continue
    const nums = dms.slice(0, 4).map(parseDms)
    if (nums.some((n) => n === null)) continue
    segments.push([
      [nums[1], nums[0]],
      [nums[3], nums[2]],
    ])
  }

  const chained = []
  for (const [a, b] of segments) {
    const last = chained[chained.length - 1]
    if (last && near(last[last.length - 1], a)) last.push(b)
    else chained.push([a, b])
  }

  const out = []
  for (const path of chained) {
    for (const run of clipPath(path)) {
      const simplified = simplify(run, TOLERANCE_NM)
      if (simplified.length < 2) continue
      if (lengthNM(simplified) < MIN_PATH_NM) continue
      out.push(...chunk(densify(simplified, MAX_SEGMENT_NM)))
    }
  }
  console.error(`fir: ${segments.length} segments -> ${chained.length} chains -> ${out.length} clipped`)
  return out
}

/**
 * The Thames, out of the sector file's unlabelled rivers.
 *
 * Every line in that file ends in the colour name "river" and nothing says
 * which watercourse it belongs to, so the Thames is identified by where it
 * runs: chain the segments on shared endpoints, then keep the chain that
 * passes within a mile of a series of known points on the river. Exactly
 * one chain does, and it matches all six from Windsor to Gravesend.
 */
const ON_THAMES = [
  [51.4839, -0.6094], // Windsor
  [51.4612, -0.3084], // Richmond
  [51.5007, -0.1246], // Westminster
  [51.5055, -0.0754], // Tower Bridge
  [51.4934, 0.0684], // Woolwich
  [51.4415, 0.3685], // Gravesend
]

function nearestNM(path, [lat, lon]) {
  const t = toNM([lon, lat])
  let best = Infinity
  for (let i = 1; i < path.length; i += 1) {
    const a = toNM(path[i - 1])
    const b = toNM(path[i])
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let u = l2 === 0 ? 0 : ((t[0] - a[0]) * dx + (t[1] - a[1]) * dy) / l2
    u = Math.max(0, Math.min(1, u))
    best = Math.min(best, Math.hypot(t[0] - (a[0] + u * dx), t[1] - (a[1] + u * dy)))
  }
  return best
}

/*
 * Width of the Thames, in metres, at points along it.
 *
 * The rivers file is a centreline and carries no width at all, so this is a
 * table of approximate real widths at known places, interpolated along the
 * line by arc length. It is an approximation and is recorded as one -- but
 * the shape of it is the point: the Thames is a 60 m stream at Windsor and
 * over a kilometre wide at Gravesend, and a river drawn at one width
 * everywhere loses the single most recognisable thing about it.
 */
const THAMES_WIDTHS = [
  [51.6957, -1.2799, 25], // Oxford
  [51.4614, -0.9755, 60], // Reading
  [51.4839, -0.6094, 65], // Windsor
  [51.4319, -0.5093, 70], // Staines
  [51.4109, -0.3065, 90], // Kingston
  [51.4612, -0.3084, 95], // Richmond
  [51.4676, -0.2159, 200], // Putney
  [51.5007, -0.1246, 250], // Westminster
  [51.5055, -0.0754, 265], // Tower Bridge
  [51.4826, -0.0077, 350], // Greenwich
  [51.4934, 0.0684, 450], // Woolwich
  [51.4808, 0.1783, 700], // Erith
  [51.4415, 0.3685, 1300], // Gravesend
  [51.4636, 0.552, 2600], // Lower Hope / Mucking
  [51.5155, 0.6555, 5000], // off Canvey
]

/** Cumulative arc length in NM at each point of a path. */
function arcLengths(points) {
  const out = [0]
  for (let i = 1; i < points.length; i += 1) {
    const a = toNM(points[i - 1])
    const b = toNM(points[i])
    out.push(out[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  return out
}

/**
 * Assigns a width to every point of the river by interpolating the table
 * along the line. Anchors are placed by finding the nearest point on the
 * chain to each named location, so the table does not have to be in order
 * or to sit exactly on the centreline.
 */
function widthsFor(points) {
  const s = arcLengths(points)
  const anchors = []
  for (const [lat, lon, widthM] of THAMES_WIDTHS) {
    const t = toNM([lon, lat])
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < points.length; i += 1) {
      const p = toNM(points[i])
      const d = Math.hypot(p[0] - t[0], p[1] - t[1])
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    // Only trust an anchor that actually landed on this river.
    if (bestD <= 1.5) anchors.push({ at: s[bestI], widthM })
  }
  anchors.sort((a, b) => a.at - b.at)
  if (anchors.length < 2) throw new Error('not enough width anchors matched the river')

  return s.map((at) => {
    if (at <= anchors[0].at) return anchors[0].widthM
    const last = anchors[anchors.length - 1]
    if (at >= last.at) return last.widthM
    for (let i = 1; i < anchors.length; i += 1) {
      const b = anchors[i]
      if (at <= b.at) {
        const a = anchors[i - 1]
        const u = (at - a.at) / (b.at - a.at)
        return a.widthM + (b.widthM - a.widthM) * u
      }
    }
    return last.widthM
  })
}

function thames(file) {
  const segments = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const dms = line.match(/[NSEW]\d+\.\d+\.\d+(?:\.\d+)?/g)
    if (!dms || dms.length < 4) continue
    const n = dms.slice(0, 4).map(parseDms)
    if (n.some((v) => v === null)) continue
    segments.push([
      [n[1], n[0]],
      [n[3], n[2]],
    ])
  }

  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`
  const byStart = new Map()
  for (const s of segments) {
    const k = key(s[0])
    if (!byStart.has(k)) byStart.set(k, [])
    byStart.get(k).push(s)
  }

  const used = new Set()
  const chains = []
  for (const seg of segments) {
    if (used.has(seg)) continue
    used.add(seg)
    const path = [seg[0], seg[1]]
    for (;;) {
      const next = (byStart.get(key(path[path.length - 1])) || []).find((s) => !used.has(s))
      if (!next) break
      used.add(next)
      path.push(next[1])
    }
    chains.push(path)
  }

  const matches = chains.filter(
    (c) => ON_THAMES.filter((p) => nearestNM(c, p) < 1).length >= 5,
  )
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Thames chain, found ${matches.length}`)
  }

  const out = []
  for (const run of clipPath(matches[0])) {
    const simplified = simplify(run, TOLERANCE_NM)
    if (simplified.length < 2) continue
    // Widths are attached AFTER densifying, so every drawn vertex has one,
    // and before chunking, so the profile survives the split.
    const dense = densify(simplified, MAX_SEGMENT_NM)
    const w = widthsFor(dense)
    out.push(...chunk(dense.map((p, i) => [p[0], p[1], w[i]])))
  }
  console.error(`thames: ${segments.length} river segments -> ${chains.length} chains -> 1 match -> ${out.length} chunks`)
  return out
}

/* ---------------------------------------------------------------- output */

const coast = coastline(process.argv[2])
const fir = firLines(process.argv[3])
const river = thames(process.argv[4])

const stats = (paths) => ({
  paths: paths.length,
  points: paths.reduce((n, p) => n + p.length, 0),
})

console.error('coastline', JSON.stringify(stats(coast)))
console.error('fir', JSON.stringify(stats(fir)))
console.error('thames', JSON.stringify(stats(river)))


const geography = [
  {
    id: 'coastline',
    label: 'Coastline',
    kind: 'coastline',
    derivation: 'survey',
    source: 'Natural Earth 10m coastline (public domain)',
    paths: coast.map(asObjects),
  },
  {
    id: 'thames',
    label: 'River Thames',
    kind: 'river',
    derivation: 'survey',
    source: 'VATSIM UK Sector File, Misc Geo/Rivers.txt',
    paths: river.map(asObjects),
  },
  {
    id: 'fir-boundary',
    label: 'FIR boundary',
    kind: 'fir',
    derivation: 'aip',
    source: 'VATSIM UK Sector File, Sector Boundaries/Lines - External FIR',
    paths: fir.map(asObjects),
  },
]

fs.writeFileSync(process.argv[5], JSON.stringify(geography, null, 2) + '\n')
console.error('wrote', process.argv[5])
