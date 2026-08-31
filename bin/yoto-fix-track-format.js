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
 *   node bin/yoto-fix-track-format.js [--dry-run] [--all]
 *
 *   --dry-run  Report what would change; write nothing.
 *   --all      Fix every MYO card in the library, not just ones this tool made.
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

// Detect a track's real format from the signed media URL's Content-Type.
async function detectFormat (token, cardId) {
  const playable = await api(token, `/content/${cardId}?playable=true&signingType=cloudfront`)
  const card = playable.card || playable
  const track = card?.content?.chapters?.[0]?.tracks?.[0]
  if (!track?.trackUrl?.startsWith('http')) return null
  const resp = await fetch(track.trackUrl, { headers: { range: 'bytes=0-1' } })
  const type = (resp.headers.get('content-type') || '').split(';')[0].trim()
  return CONTENT_TYPE_FORMAT[type] || null
}

async function main () {
  const dryRun = process.argv.includes('--dry-run')
  const all = process.argv.includes('--all')
  const token = await loadToken()

  const library = await api(token, '/card/family/library')
  const cards = (library.cards || []).filter(c =>
    c.shareType === 'myo' && (all || c.card?.createdByClientId === OUR_CLIENT_ID))

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

      const format = await detectFormat(token, cardId)
      if (!format) { console.log(`${label} — SKIP (could not detect format)`); skipped++; continue }

      console.log(`${label} — ${missing.length} track(s) missing format -> ${format}${dryRun ? '' : ' ...'}`)
      if (dryRun) { fixed++; continue }

      const patched = chapters.map(ch => ({
        ...ch,
        tracks: (ch.tracks || []).map(t => (t.format ? t : { ...t, format, channels: t.channels || 'stereo' }))
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
