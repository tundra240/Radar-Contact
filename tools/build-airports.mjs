/*
 * Extends the `airports` block of src/data/egll.json outwards.
 *
 * Source: OurAirports (public domain), the same dataset the original fifteen
 * came from. Selection is deliberately uneven: the fields a controller would
 * actually recognise reach a long way out, while grass strips are only worth
 * drawing close in.
 */
import fs from 'node:fs'

// Usage: node tools/build-airports.mjs airports.csv runways.csv egll.json OUT.json
// Merge the result into the `airports` array in src/data/egll.json.

const ARP = { lat: 51.470748, lon: -0.459909 }
const kx = 60 * Math.cos((ARP.lat * Math.PI) / 180)
const distNM = (lat, lon) => Math.hypot((lon - ARP.lon) * kx, (lat - ARP.lat) * 60)

// Big enough to be a landmark, so it is drawn even a long way out; small
// enough that it is only drawn near the field.
// Only fields a controller would name. The close-in grass strips already in
// the config were chosen by hand; this pass is about reach, not density, so
// small aerodromes are left alone entirely.
const RANGE = { large: 100, medium: 90 }

/** Minimal CSV reader: OurAirports quotes fields containing commas. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function table(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const head = rows[0]
  return rows.slice(1).map((r) => {
    const o = {}
    head.forEach((h, i) => {
      o[h] = r[i]
    })
    return o
  })
}

const airports = table(process.argv[2])
const runways = table(process.argv[3])

const KIND = {
  large_airport: 'large',
  medium_airport: 'medium',
}

const byAirport = new Map()
for (const r of runways) {
  if (!byAirport.has(r.airport_ident)) byAirport.set(r.airport_ident, [])
  byAirport.get(r.airport_ident).push(r)
}

/**
 * The longest runway, with its true bearing.
 *
 * Bearing comes from the two threshold coordinates where the dataset has
 * them, because the published `le_heading_degT` column is frequently blank
 * and is magnetic in some records. Falling back on the identifier (the "09"
 * in 09L) is a last resort and only accurate to ten degrees.
 */
function primaryRunway(ident) {
  const list = (byAirport.get(ident) || []).filter(
    (r) => r.closed !== '1' && Number(r.length_ft) > 0,
  )
  if (list.length === 0) return null
  list.sort((a, b) => Number(b.length_ft) - Number(a.length_ft))
  const r = list[0]

  const le = { lat: Number(r.le_latitude_deg), lon: Number(r.le_longitude_deg) }
  const he = { lat: Number(r.he_latitude_deg), lon: Number(r.he_longitude_deg) }

  let bearing = null
  if ([le.lat, le.lon, he.lat, he.lon].every(Number.isFinite)) {
    const dx = (he.lon - le.lon) * 60 * Math.cos(((le.lat + he.lat) / 2 * Math.PI) / 180)
    const dy = (he.lat - le.lat) * 60
    if (Math.hypot(dx, dy) > 0.05) {
      bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    }
  }
  if (bearing === null) {
    const n = parseInt(String(r.le_ident).replace(/[^0-9]/g, ''), 10)
    if (!Number.isFinite(n)) return null
    bearing = (n * 10) % 360
  }

  return {
    ident: `${r.le_ident}/${r.he_ident}`,
    bearingTrue: Number(bearing.toFixed(1)),
    lengthFt: Number(r.length_ft),
  }
}

const config = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
// The field being worked is not one of its own neighbours.
const existing = new Set([config.icao, ...config.airports.map((a) => a.icao)])

const picked = []
for (const a of airports) {
  const kind = KIND[a.type]
  if (!kind) continue
  const lat = Number(a.latitude_deg)
  const lon = Number(a.longitude_deg)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
  const d = distNM(lat, lon)
  if (d > RANGE[kind]) continue
  const icao = a.ident
  if (!/^[A-Z]{4}$/.test(icao)) continue
  if (existing.has(icao)) continue

  const rwy = primaryRunway(icao)
  // A field with no runway on record is a dot with a name; not useful.
  if (!rwy) continue

  picked.push({
    icao,
    name: a.name,
    iata: /^[A-Z]{3}$/.test(a.iata_code) ? a.iata_code : null,
    kind,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    elevationFt: Number.isFinite(Number(a.elevation_ft)) ? Number(a.elevation_ft) : 0,
    primaryRunway: rwy,
    _distNM: Number(d.toFixed(1)),
  })
}

picked.sort((a, b) => a._distNM - b._distNM)
for (const p of picked) {
  console.error(`${p.icao} ${String(p._distNM).padStart(5)} NM ${p.kind.padEnd(6)} ${p.name}`)
}
console.error(`${picked.length} new aerodromes`)

fs.writeFileSync(
  process.argv[5],
  JSON.stringify(
    picked.map(({ _distNM, ...rest }) => rest),
    null,
    2,
  ) + '\n',
)
