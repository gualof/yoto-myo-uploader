#!/usr/bin/env node
/**
 * yoto-upload
 * Upload a folder of audiobooks to your Yoto account as MYO cards.
 *
 * Usage:
 *   node bin/yoto-upload.js /path/to/audiobooks
 */

import { YotoClient, DEFAULT_CLIENT_ID } from 'yoto-nodejs-client'
import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { join, extname, basename, resolve } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { prepareCover } from './cover-image.js'

const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png']

const YOTO_API = 'https://api.yotoplay.com'
const CLIENT_ID = DEFAULT_CLIENT_ID
// Yoto's actual scopes (the library default 'openid profile offline_access' is
// generic OIDC boilerplate — 'openid' isn't a valid Yoto scope, so Auth0 rejects
// it with a 403). Creating MYO cards needs user:content:manage (which includes
// content:view + icons:manage for cover art); offline_access enables refresh.
// See https://yoto.dev/authentication/scopes/
const SCOPE = 'user:content:manage offline_access'
// How many tracks to upload+transcode at once per book (the web UI parallelizes
// too). Modest default to respect rate limits; override with YOTO_CONCURRENCY.
const CONCURRENCY = Math.max(1, parseInt(process.env.YOTO_CONCURRENCY || '4', 10))
const CONFIG_DIR = join(homedir(), '.yoto-myo-uploader')
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json')
const PROGRESS_FILE = join(CONFIG_DIR, 'progress.json')

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureConfigDir () {
  await mkdir(CONFIG_DIR, { recursive: true })
}

async function loadTokens () {
  try {
    return JSON.parse(await readFile(TOKENS_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function saveTokens (tokens) {
  await ensureConfigDir()
  await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8')
}

async function loadProgress (booksDir) {
  try {
    const all = JSON.parse(await readFile(PROGRESS_FILE, 'utf8'))
    return all[booksDir] || {}
  } catch {
    return {}
  }
}

async function markDone (booksDir, bookName, cardId) {
  let all = {}
  try { all = JSON.parse(await readFile(PROGRESS_FILE, 'utf8')) } catch {}
  if (!all[booksDir]) all[booksDir] = {}
  all[booksDir][bookName] = { cardId, uploadedAt: new Date().toISOString() }
  await ensureConfigDir()
  await writeFile(PROGRESS_FILE, JSON.stringify(all, null, 2), 'utf8')
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate () {
  const saved = await loadTokens()

  if (saved) {
    console.log('Using saved Yoto credentials.\n')
    return new YotoClient({
      clientId: CLIENT_ID,
      accessToken: saved.accessToken,
      refreshToken: saved.refreshToken,
      onTokenRefresh: async (e) => saveTokens({
        accessToken: e.updatedAccessToken,
        refreshToken: e.updatedRefreshToken
      })
    })
  }

  const deviceAuth = await YotoClient.requestDeviceCode({ clientId: CLIENT_ID, scope: SCOPE })
  console.log('\n╔═══════════════════════════════════════════════════════════╗')
  console.log('║  Log in to your Yoto account to continue:                 ║')
  console.log(`║  ${deviceAuth.verification_uri_complete.padEnd(57)}║`)
  console.log('╚═══════════════════════════════════════════════════════════╝\n')
  process.stdout.write('Waiting for login ')

  const tokens = await YotoClient.waitForDeviceAuthorization({
    deviceCode: deviceAuth.device_code,
    clientId: CLIENT_ID,
    initialInterval: deviceAuth.interval * 1000,
    expiresIn: deviceAuth.expires_in,
    onPoll: () => process.stdout.write('.')
  })
  console.log('\n✓ Logged in!\n')

  await saveTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token
  })

  return new YotoClient({
    clientId: CLIENT_ID,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    onTokenRefresh: async (e) => saveTokens({
      accessToken: e.updatedAccessToken,
      refreshToken: e.updatedRefreshToken
    })
  })
}

// ── Upload + transcode one track ──────────────────────────────────────────────
// Full flow:
//   1. Get presigned S3 URL from Yoto
//   2. PUT file to S3 with Content-Type: audio/mpeg (triggers transcoding pipeline)
//   3. Poll /media/upload/{uploadId}/transcoded until transcodedSha256 appears
//   4. Return transcodedSha256 for use in trackUrl

// Card display title: for series folders "Series - N - Title", drop the first
// hyphen so it reads "Series N - Title" (e.g. "Mary Poppins 2 - Mary Poppins
// Comes Back"). Single-book folders (no " - <number>") are left unchanged.
function cardTitle (name) {
  return name.replace(/ - (?=\d)/, ' ')
}

// Yoto card IDs are normally mixed-case (e.g. "hIjsw"), but an all-digit one
// turns up occasionally and breaks Home Assistant's Yoto media browser.
const NUMERIC_ID_RETRIES = 3

function readCardId (card) {
  return card.cardId || card.card?.cardId || 'unknown'
}

function isNumericCardId (cardId) {
  return /^\d+$/.test(String(cardId))
}

// Run fn over items with bounded concurrency; results returned in input order.
// If any fn rejects, the returned promise rejects (book won't be marked done).
async function mapPool (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker () {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function uploadAndTranscode (client, filePath, accessToken) {
  const data = await readFile(filePath)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const filename = basename(filePath)

  const { upload } = await client.getAudioUploadUrl({ sha256, filename })

  if (upload.uploadUrl) {
    const resp = await fetch(upload.uploadUrl, {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': 'audio/mpeg' }
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`S3 upload failed for ${filename}: ${resp.status} ${body.substring(0, 200)}`)
    }
  }

  // Poll until transcoding is complete. Yoto usually finishes in ~10–30s, so we
  // poll every 3s (no long dead-wait before the first check). ~200 tries ≈ 10 min.
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const pollResp = await fetch(`${YOTO_API}/media/upload/${upload.uploadId}/transcoded`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    const body = await pollResp.json()
    const transcodedSha256 = body.transcode?.transcodedSha256
    if (transcodedSha256) {
      // The Yoto player needs `format` on each track to pick a decoder. Yoto
      // fills in duration/fileSize server-side but never format, and a card
      // without it is accepted, reported as ~1s per track, and raced through in
      // silence on the player (the phone app sniffs the container, so it plays
      // there — which is what makes this look like a player problem).
      const info = body.transcode?.transcodedInfo || {}
      return {
        transcodedSha256,
        format: info.format || info.codec || null,
        channels: info.channels || null
      }
    }
    if (body.transcode?.progress?.phase === 'failed') {
      throw new Error(`Yoto transcoding failed for ${filename}`)
    }
  }
  throw new Error(`Transcoding timed out for ${filename} after 10 minutes`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main () {
  const booksDir = resolve(process.argv[2] || '')

  if (!process.argv[2]) {
    console.error('Usage: node bin/yoto-upload.js /path/to/your/audiobooks')
    console.error('')
    console.error('The folder should contain one subfolder per book,')
    console.error('with MP3 files inside each subfolder.')
    process.exit(1)
  }

  try {
    const s = await stat(booksDir)
    if (!s.isDirectory()) throw new Error()
  } catch {
    console.error(`Error: folder not found: ${booksDir}`)
    process.exit(1)
  }

  console.log(`\nyoto-myo-uploader`)
  console.log(`Books folder: ${booksDir}\n`)

  const client = await authenticate()
  const tokens = await loadTokens()
  const progress = await loadProgress(booksDir)

  const entries = (await readdir(booksDir, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()

  if (entries.length === 0) {
    console.error('No subfolders found in', booksDir)
    process.exit(1)
  }

  console.log(`Found ${entries.length} book(s).\n`)

  let uploaded = 0
  let skipped = 0

  for (let i = 0; i < entries.length; i++) {
    const bookName = entries[i]
    const bookDir = join(booksDir, bookName)

    if (progress[bookName]) {
      console.log(`[${i + 1}/${entries.length}] Skip (already uploaded): ${bookName}`)
      skipped++
      continue
    }

    console.log(`[${i + 1}/${entries.length}] ${bookName}`)

    const files = (await readdir(bookDir))
      .filter(f => extname(f).toLowerCase() === '.mp3')
      .sort()

    if (files.length === 0) {
      console.log('  No MP3s found, skipping.\n')
      continue
    }

    console.log(`  Uploading ${files.length} tracks (${CONCURRENCY} at a time)...`)
    // Upload + transcode tracks concurrently; mapPool returns results in file order.
    const results = await mapPool(files, CONCURRENCY, async (file, t) => {
      const trackTitle = file.replace(/^\d+[\s._-]+/, '').replace(/\.mp3$/i, '')
      const media = await uploadAndTranscode(client, join(bookDir, file), tokens.accessToken)
      console.log(`    [${t + 1}/${files.length}] ${trackTitle} ✓`)
      return { trackTitle, ...media }
    })

    const chapters = results.map((r, t) => ({
      key: `ch${String(t + 1).padStart(3, '0')}`,
      title: r.trackTitle,
      tracks: [{
        key: `tr${String(t + 1).padStart(3, '0')}`,
        title: r.trackTitle,
        trackUrl: `yoto:#${r.transcodedSha256}`,
        type: 'audio',
        ...(r.format && { format: r.format }),
        ...(r.channels && { channels: r.channels })
      }]
    }))

    const noFormat = results.filter(r => !r.format).length
    if (noFormat > 0) {
      console.log(`  ! ${noFormat} track(s) have no format — the Yoto player will skip them. Run yoto-fix-track-format after.`)
    }

    // Upload cover art if present
    let coverUrl = null
    const coverFile = COVER_NAMES.map(n => join(bookDir, n)).find(p => existsSync(p))
    if (coverFile) {
      process.stdout.write('  Uploading cover art... ')
      try {
        // Pad to Yoto's cover ratio so it isn't cropped when Yoto resizes it.
        const { buffer, filename } = await prepareCover(coverFile)
        const { coverImage } = await client.uploadCoverImage({
          imageData: buffer,
          filename,
          coverType: 'default' // 638x1011 portrait; 'myo' is a 520x400 landscape crop
        })
        coverUrl = coverImage.mediaUrl
        console.log('✓')
      } catch (e) {
        console.log(`(skipped: ${e.message})`)
      }
    }

    const content = {
      title: cardTitle(bookName),
      content: { chapters },
      ...(coverUrl && { metadata: { cover: { imageL: coverUrl } } })
    }

    let card = await client.createOrUpdateContent({ content })
    let cardId = readCardId(card)

    // Yoto sometimes hands out an all-digit card ID. Home Assistant's yoto
    // integration then breaks: yoto_api coerces digit-only strings to ints, and
    // building the browse URI does '/'.join([...card.id]) -> TypeError, which
    // kills the media browser for the whole library, not just this card.
    // Re-post to draw a different ID, then delete the numeric one.
    for (let attempt = 0; attempt < NUMERIC_ID_RETRIES && isNumericCardId(cardId); attempt++) {
      console.log(`  Card ID ${cardId} is all digits (breaks Home Assistant) — re-creating...`)
      const numericId = cardId
      card = await client.createOrUpdateContent({ content })
      cardId = readCardId(card)
      try {
        await client.deleteContent({ cardId: numericId })
      } catch (e) {
        console.log(`  (could not delete ${numericId}: ${e.message} — remove it in the Yoto app)`)
      }
    }
    if (isNumericCardId(cardId)) {
      console.log(`  ! Card ID ${cardId} is still all digits — Home Assistant's media browser will fail until it is re-created.`)
    }
    await markDone(booksDir, bookName, cardId)
    console.log(`  ✓ Card created: ${cardId}\n`)
    uploaded++
  }

  console.log(`\nDone! ${uploaded} card(s) uploaded, ${skipped} already skipped.`)
  console.log('Check your Yoto app under My Cards > MYO.')
}

main().catch(err => {
  console.error('\nError:', err.message)
  if (err.statusCode) console.error('HTTP status:', err.statusCode)
  if (err.textBody) console.error('Response:', err.textBody)
  process.exit(1)
})
