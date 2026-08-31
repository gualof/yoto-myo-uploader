#!/usr/bin/env node
/**
 * yoto-fix-track-format
 *
 * Adds the missing `format` field to every track of the MYO cards this tool
 * created.
 *
 * Why: yoto-upload builds chapters with only { key, title, trackUrl, type }.
 * Yoto fills in duration/fileSize server-side but NOT `format`, and the
 * physical Yoto player needs it to pick a decoder. Without it the player
 * accepts the card, reports each track as ~1 second, and races through the
 * whole thing in silence. The phone app sniffs the container instead, which is
 * why these cards play there and nowhere else.
 *
 * The format is detected from the media's actual Content-Type rather than
 * assumed, then written back with the card's content preserved verbatim
 * (createOrUpdateContent REPLACES content — a partial write wipes the audio).
 *
 * Usage:
 *   node bin/yoto-fix-track-format.js [--dry-run] [--all] [--card <id>]
 *
 *   --dry-run   Report what would change; write nothing.
 *   --all       Fix every MYO card in the library, not just ones this tool made.
 *   --card <id> Only touch these cards (repeatable, or comma-separated). Use it
 *               to try the fix on one card before sweeping the whole library.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const YOTO_API = 'https://api.yotoplay.com'
const TOKENS_FILE = join(homedir(), '.yoto-myo-uploader', 'tokens.json')

// Client ID this uploader authenticates as; its cards are the ones missing `format`.
const OUR_CLIENT_ID = 'ix91Qy0B4uA8187JhI0tQbQQ5I5nUKYh'

const CONTENT_TYPE_FORMAT = {
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'audio/mp4': 'aac',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3'
}

async function loadToken () {
  const { accessToken } = JSON.parse(await readFile(TOKENS_FILE, 'utf8'))
  if (!accessToken) throw new Error('No accessToken — run yoto-upload once to log in.')
  return accessToken
}

async function api (token, path, init = {}) {
  const resp = await fetch(`${YOTO_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) }
  })
  if (!resp.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${resp.status} ${(await resp.text()).slice(0, 200)}`)
  return resp.json()
}

// Channel count lives in the OpusHead identification header, which Ogg puts in
// the first page: the magic string then version(1) then a channel-count byte.
// Yoto's own cards carry both 'mono' and 'stereo', so this must be read, not
// assumed — a mono book labelled stereo is a wrong value written on purpose.
function channelsFromOpusHead (buf) {
  const at = buf.indexOf('OpusHead', 0, 'latin1')
  if (at === -1 || at + 9 >= buf.length) return null
  const count = buf[at + 9]
  if (count === 1) return 'mono'
  if (count === 2) return 'stereo'
  return null
}

// Detect a track's real format (and channel count where we can read it) from
// the signed media URL, rather than assuming what the transcoder produced.
async function detectMedia (token, cardId) {
  const playable = await api(token, `/content/${cardId}?playable=true&signingType=cloudfront`)
  const card = playable.card || playable
  const track = card?.content?.chapters?.[0]?.tracks?.[0]
  if (!track?.trackUrl?.startsWith('http')) return null
  // Enough bytes for the first Ogg page; still a range request, not a download.
  const resp = await fetch(track.trackUrl, { headers: { range: 'bytes=0-127' } })
  const type = (resp.headers.get('content-type') || '').split(';')[0].trim()
  const format = CONTENT_TYPE_FORMAT[type] || null
  if (!format) return null
  const head = Buffer.from(await resp.arrayBuffer())
  return { format, channels: format === 'opus' ? channelsFromOpusHead(head) : null }
}

// --card <id>, repeatable and/or comma-separated.
function parseCardIds (argv) {
  const ids = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--card') ids.push(...String(argv[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean))
  }
  return ids
}

async function main () {
  const dryRun = process.argv.includes('--dry-run')
  const all = process.argv.includes('--all')
  const only = parseCardIds(process.argv)
  const token = await loadToken()

  const library = await api(token, '/card/family/library')
  let cards = (library.cards || []).filter(c =>
    c.shareType === 'myo' && (all || c.card?.createdByClientId === OUR_CLIENT_ID))

  if (only.length > 0) {
    cards = cards.filter(c => only.includes(c.cardId))
    const missing = only.filter(id => !cards.some(c => c.cardId === id))
    // Bail rather than silently fixing fewer cards than asked for.
    if (missing.length > 0) throw new Error(`--card not found in the MYO cards selected: ${missing.join(', ')} (try --all)`)
  }

  console.log(`\nyoto-fix-track-format${dryRun ? '  [DRY RUN — nothing will be written]' : ''}`)
  console.log(`${cards.length} MYO card(s) to inspect.\n`)

  let fixed = 0; let ok = 0; let skipped = 0
  const failures = []

  for (let i = 0; i < cards.length; i++) {
    const cardId = cards[i].cardId
    const label = `[${i + 1}/${cards.length}] ${cards[i].card?.title || cardId}`
    try {
      const detail = await api(token, `/content/${cardId}`)
      const card = detail.card || detail
      const chapters = card?.content?.chapters || []

      // Refuse to write a card we can't read properly — an empty content object
      // would clobber audio that is probably still there.
      if (chapters.length === 0) { console.log(`${label} — SKIP (no chapters)`); skipped++; continue }

      const missing = chapters.flatMap(ch => ch.tracks || []).filter(t => !t.format)
      if (missing.length === 0) { console.log(`${label} — already has format`); ok++; continue }

      const media = await detectMedia(token, cardId)
      if (!media) { console.log(`${label} — SKIP (could not detect format)`); skipped++; continue }
      const { format, channels } = media

      console.log(`${label} — ${missing.length} track(s) missing format -> ${format}${channels ? `/${channels}` : ''}${dryRun ? '' : ' ...'}`)
      if (dryRun) { fixed++; continue }

      // Leave channels alone when it could not be read — an absent field beats a
      // guessed one, and `format` is what the player actually needs.
      const patched = chapters.map(ch => ({
        ...ch,
        tracks: (ch.tracks || []).map(t => (t.format
          ? t
          : { ...t, format, ...((t.channels || channels) && { channels: t.channels || channels }) }))
      }))
      await api(token, '/content', {
        method: 'POST',
        body: JSON.stringify({
          cardId,
          title: card.title,
          content: { ...card.content, chapters: patched },
          ...(card.metadata && { metadata: card.metadata })
        })
      })
      fixed++
    } catch (err) {
      console.log(`${label} — FAILED: ${err.message}`)
      failures.push(`${cardId}: ${err.message}`)
    }
  }

  console.log('\n' + '─'.repeat(60))
  console.log(`${dryRun ? 'Would fix' : 'Fixed'}: ${fixed}   already ok: ${ok}   skipped: ${skipped}   failed: ${failures.length}`)
  for (const f of failures) console.log(`   - ${f}`)
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1) })
