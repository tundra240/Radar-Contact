/*
 * Builds the map around a field: the coastline, the aerodromes near it, and
 * the navigation aids it can see.
 *
 * Heathrow got all three from open data and the other three fields did not,
 * which is why Heathrow's scope has a shoreline and fifteen neighbours on it
 * and Faro's had two circles and an empty sea. Nothing about that gap was
 * deliberate -- Heathrow was built against the VATSIM UK sector file and
 * there is no equivalent for Portugal, Spain or France, so the parts that
 * came from a UK-only source stayed UK-only. The parts that did not are
 * global, and this points them at the other three.
 *
 *   coastline   Natural Earth 10m coastline (public domain)
 *   rivers      Natural Earth 10m rivers and lake centrelines (public domain)
 *   aerodromes  OurAirports airports.csv + runways.csv (public domain)
 *   navaids     OurAirports navaids.csv (public domain)
 *
 * Airspace is NOT built here. There is no open sector file for these three
 * countries, so their volumes are constructed by hand and marked as such;
 * see the provenance note in each file.
 *
 * Usage:
 *   node tools/build-field-map.mjs LPFR COAST.geojson airports.csv runways.csv navaids.csv [RIVERS.geojson]
 *
 * Writes straight into src/data/<icao>.json. Hand-made entry gates are kept
 * -- the traffic generator refers to them by name -- and real stations are
 * added around them. Re-running against the same inputs is a no-op.
 */
import fs from 'node:fs'

import { lineWorks } from './lib/lines.mjs'

/* ----------------------------------------------------------------- input */

const [icao, coastFile, airportsFile, runwaysFile, navaidsFile, riversFile] =
  process.argv.slice(2)
if (!icao) throw new Error('usage: build-field-map.mjs ICAO COAST.geojson airports.csv runways.csv navaids.csv')

const dataPath = `src/data/${icao.toLowerCase()}.json`
const field = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
const ARP = field.arp

/**
 * How far out to keep map data.
 *
 * The camera stops at twice the area of responsibility and a wide window
 * shows about 1.7 times the range each side of centre, so the furthest a
 * pan can reach is a little over three times the sector radius. Doubled
 * again, because a shoreline that stops exactly where the camera does looks
 * like the edge of the world.
 */
const REACH_NM = Math.max(180, field.sector.radiusNM * 6)

const D2R = Math.PI / 180
const kx = 60 * Math.cos(ARP.lat * D2R)
const distNM = (lat, lon) => Math.hypot((lon - ARP.lon) * kx, (lat - ARP.lat) * 60)

const BOX = {
  minLat: ARP.lat - REACH_NM / 60,
  maxLat: ARP.lat + REACH_NM / 60,
  minLon: ARP.lon - REACH_NM / kx,
  maxLon: ARP.lon + REACH_NM / kx,
}

const { asObjects, coastline, prepare } = lineWorks({ arp: ARP, box: BOX })

/* ------------------------------------------------------------------- csv */

/** Minimal CSV reader: OurAirports quotes fields containing commas. */
function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"'
          i += 1
        } else quoted = false
      } else value += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(value)
      value = ''
    } else if (c === '\n') {
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else if (c !== '\r') value += c
  }
  if (value !== '' || row.length > 0) {
    row.push(value)
    rows.push(row)
  }
  return rows
}

function table(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const head = rows[0]
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

/* ---------------------------------------------------------------- rivers */

/**
 * Watercourses worth drawing, by field.
 *
 * A short list rather than everything nearby, because at ten-million scale
 * "everything nearby" is one or two rivers and a great deal of nothing: the
 * Llobregat at Barcelona and the Var at Nice, both of which run past the
 * end of the runway, are below the resolution of this dataset and simply
 * are not in it. The Guadiana is, and it is worth having -- it is the
 * Portuguese border, it is twenty-eight miles east of Faro, and Faro's
 * eastern entry gate is named after it.
 */
const RIVERS = {
  LPFR: ['Guadiana'],
  LEBL: [],
  LFMN: [],
  EGLL: [],
}

function rivers() {
  const names = RIVERS[field.icao] ?? []
  if (names.length === 0 || riversFile === undefined) return []
  const gj = JSON.parse(fs.readFileSync(riversFile, 'utf8'))

  const out = []
  for (const want of names) {
    const raw = []
    for (const f of gj.features) {
      const p = f.properties ?? {}
      if ((p.name ?? p.name_en) !== want) continue
      const g = f.geometry
      if (!g) continue
      if (g.type === 'LineString') raw.push(g.coordinates)
      else if (g.type === 'MultiLineString') raw.push(...g.coordinates)
    }
    const paths = prepare(raw)
    if (paths.length === 0) continue
    out.push({
      id: want.toLowerCase(),
      label: `River ${want}`,
      kind: 'river',
      derivation: 'survey',
      source: 'Natural Earth 10m rivers and lake centerlines (public domain)',
      // No width: the dataset carries none, and the renderer strokes a
      // widthless river as a plain line. The Thames at Heathrow has a width
      // profile because that profile was assembled by hand from a table of
      // real widths, which is worth doing for the river the whole city sits
      // on and is not worth doing for a border eighty miles away.
      paths: paths.map(asObjects),
    })
  }
  return out
}

/* ------------------------------------------------------------ aerodromes */

/*
 * Deliberately uneven, the same way Heathrow's list is. A large field is a
 * landmark and is worth drawing from a long way off; a grass strip is only
 * worth drawing when the scope is close in, and there are hundreds of them.
 */
const REACH = { large: 140, medium: 90, small: 30 }
/** Below this a "small aerodrome" is a farm strip, and there are hundreds. */
const SMALL_MIN_FT = 2000

function aerodromes() {
  const runwaysBy = new Map()
  for (const r of table(runwaysFile)) {
    if (r.closed === '1') continue
    const list = runwaysBy.get(r.airport_ident) ?? []
    list.push(r)
    runwaysBy.set(r.airport_ident, list)
  }

  const out = []
  for (const a of table(airportsFile)) {
    const kind = a.type.replace('_airport', '')
    if (!(kind in REACH)) continue
    if (a.ident === field.icao) continue
    // Four letters, so a strip recorded under a local code is not drawn
    // with a label nobody can look up.
    if (!/^[A-Z]{4}$/.test(a.ident)) continue
    const lat = Number(a.latitude_deg)
    const lon = Number(a.longitude_deg)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const d = distNM(lat, lon)
    if (d > REACH[kind]) continue

    const runway = longestRunway(runwaysBy.get(a.ident) ?? [])
    // A field with no runway on record cannot be drawn as one.
    if (runway === null) continue
    if (kind === 'small' && runway.lengthFt < SMALL_MIN_FT) continue

    out.push({
      icao: a.ident,
      name: a.name,
      iata: a.iata_code === '' ? null : a.iata_code,
      kind,
      lat: round(lat, 6),
      lon: round(lon, 6),
      elevationFt: Number(a.elevation_ft) || 0,
      primaryRunway: runway,
      _d: d,
    })
  }
  out.sort((p, q) => p._d - q._d)
  return out.map(({ _d, ...rest }) => rest)
}

/**
 * The longest runway a field has, with its true bearing.
 *
 * Bearing comes from the two threshold coordinates where the dataset has
 * them, because the published heading column is frequently blank and is
 * magnetic in some records. Falling back on the identifier -- the "09" in
 * 09L -- is a last resort and only good to ten degrees. The same rule
 * tools/build-airports.mjs used for Heathrow, deliberately: two neighbour
 * lists drawn by two different rules would disagree at the border between
 * one field's map and the next.
 */
function longestRunway(rows) {
  const list = rows.filter((r) => r.closed !== '1' && Number(r.length_ft) > 0)
  if (list.length === 0) return null
  list.sort((a, b) => Number(b.length_ft) - Number(a.length_ft))
  const r = list[0]

  const le = { lat: Number(r.le_latitude_deg), lon: Number(r.le_longitude_deg) }
  const he = { lat: Number(r.he_latitude_deg), lon: Number(r.he_longitude_deg) }

  let bearingTrue = null
  if ([le.lat, le.lon, he.lat, he.lon].every(Number.isFinite)) {
    const dx = (he.lon - le.lon) * 60 * Math.cos((((le.lat + he.lat) / 2) * Math.PI) / 180)
    const dy = (he.lat - le.lat) * 60
    if (Math.hypot(dx, dy) > 0.05) {
      bearingTrue = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    }
  }
  if (bearingTrue === null) {
    const n = parseInt(String(r.le_ident).replace(/[^0-9]/g, ''), 10)
    if (!Number.isFinite(n)) return null
    bearingTrue = (n * 10) % 360
  }

  return {
    ident: `${r.le_ident}/${r.he_ident}`,
    bearingTrue: Number(bearingTrue.toFixed(1)),
    lengthFt: Number(r.length_ft),
  }
}

/* --------------------------------------------------------------- navaids */

/**
 * Stations worth drawing: the ones an approach controller would name.
 *
 * The VOR family only, which is what Heathrow's list is. Low-powered NDB
 * locators and bare ILS DMEs sit on top of the field by the dozen and are
 * not what anybody is navigating by -- Nice alone has three of them inside
 * seven miles, on top of the two VOR-DMEs that matter.
 */
const NAVAID_TYPES = new Set(['VOR', 'VOR-DME', 'VORTAC'])
const NAVAID_REACH_NM = 55
/** Beyond this many, the display is a list of three-letter codes. */
const NAVAID_LIMIT = 12

function navaids() {
  const found = []
  for (const n of table(navaidsFile)) {
    if (!NAVAID_TYPES.has(n.type)) continue
    const lat = Number(n.latitude_deg)
    const lon = Number(n.longitude_deg)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const d = distNM(lat, lon)
    if (d > NAVAID_REACH_NM) continue
    const khz = Number(n.frequency_khz)
    if (!Number.isFinite(khz) || khz <= 0) continue

    found.push({
      name: n.ident,
      fullName: n.name,
      lat: round(lat, 6),
      lon: round(lon, 6),
      // NDBs are published in kHz and everything else in MHz. The field
      // is MHz throughout, so an NDB comes out as a fraction -- which is
      // what a controller would read off a chart anyway.
      navaid: { type: n.type, freqMHz: round(khz / 1000, 3) },
      _d: d,
    })
  }
  // Nearest first, one per ident: the same VOR is sometimes listed twice
  // under different countries near a border.
  found.sort((a, b) => a._d - b._d)
  const seen = new Set()
  const out = []
  for (const n of found) {
    if (seen.has(n.name)) continue
    seen.add(n.name)
    out.push(n)
    if (out.length >= NAVAID_LIMIT) break
  }
  return out.map(({ _d, ...rest }) => rest)
}

/* ---------------------------------------------------------------- output */

const round = (v, dp) => Number(v.toFixed(dp))

const coast = coastline(coastFile)

// The entry gates are gameplay furniture and the traffic generator names
// them, so they are kept exactly as they are and the real stations are put
// around them. A hand-made gate that happens to share an ident with a real
// station keeps the hand-made one: it is the one with a hold on it.
const gates = field.navaids.filter((n) => n.hold !== undefined || n.entry !== undefined)
const gateNames = new Set(gates.map((n) => n.name))
const stations = navaids().filter((n) => !gateNames.has(n.name))

field.navaids = [...gates, ...stations]
field.airports = aerodromes()
const water = rivers()
field.geography = [
  {
    id: 'coastline',
    label: 'Coastline',
    kind: 'coastline',
    derivation: 'survey',
    source: 'Natural Earth 10m coastline (public domain)',
    paths: coast.map(asObjects),
  },
  ...water,
]

fs.writeFileSync(dataPath, JSON.stringify(field, null, 2) + '\n')

const points = coast.reduce((n, p) => n + p.length, 0)
console.log(
  `${field.icao}: ${coast.length} coast chunks (${points} pts) within ${REACH_NM} nm, ` +
    `${water.length} rivers, ${field.airports.length} aerodromes, ` +
    `${gates.length} gates + ${stations.length} stations`,
)
