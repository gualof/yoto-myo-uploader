#!/usr/bin/env node
/**
 * yoto-patch-covers
 * Retroactively adds cover art to cards that were uploaded without it.
 * Reads progress.json to find uploaded cards, then uploads and attaches
 * the cover image from the local book folder.
 *
 * Usage:
 *   node bin/yoto-patch-covers.js /path/to/audiobooks
 */

import { YotoClient, DEFAULT_CLIENT_ID } from 'yoto-nodejs-client'
import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { join, basename, resolve } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { prepareCover } from './cover-image.js'

const CONFIG_DIR = join(homedir(), '.yoto-myo-uploader')
const TOKENS_FILE = join(CONFIG_DIR, 'tokens.json')
const PROGRESS_FILE = join(CONFIG_DIR, 'progress.json')
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png']
const CLIENT_ID = DEFAULT_CLIENT_ID

async function loadTokens () {
  try {
    return JSON.parse(await readFile(TOKENS_FILE, 'utf8'))
  } catch {
    console.error('No saved credentials found. Run yoto-upload first to log in.')
    process.exit(1)
  }
}

async function main () {
  const booksDir = resolve(process.argv[2] || '')
  const only = process.argv[3] || null // optional: patch a single book by name

  if (!process.argv[2]) {
    console.error('Usage: node bin/yoto-patch-covers.js /path/to/your/audiobooks [book-name]')
    process.exit(1)
  }

  try {
    const s = await stat(booksDir)
    if (!s.isDirectory()) throw new Error()
  } catch {
    console.error(`Error: folder not found: ${booksDir}`)
    process.exit(1)
  }

  const tokens = await loadTokens()
  const client = new YotoClient({
    clientId: CLIENT_ID,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    onTokenRefresh: async (e) => {
      await mkdir(CONFIG_DIR, { recursive: true })
      await writeFile(TOKENS_FILE, JSON.stringify({
        accessToken: e.updatedAccessToken,
        refreshToken: e.updatedRefreshToken
      }, null, 2))
    }
  })

  let allProgress = {}
  try {
    allProgress = JSON.parse(await readFile(PROGRESS_FILE, 'utf8'))
  } catch {
    console.error('No progress file found. No books have been uploaded yet.')
    process.exit(1)
  }

  const progress = allProgress[booksDir]
  if (!progress || Object.keys(progress).length === 0) {
    console.error(`No uploaded books found for: ${booksDir}`)
    process.exit(1)
  }

  console.log(`\nyoto-patch-covers`)
  console.log(`Books folder: ${booksDir}`)
  console.log(`Found ${Object.keys(progress).length} uploaded book(s).\n`)

  let patched = 0
  let skipped = 0

  for (const [bookName, entry] of Object.entries(progress)) {
    if (only && bookName !== only) continue
    const cardId = typeof entry === 'string' ? entry : entry.cardId
    const bookDir = join(booksDir, bookName)
    const coverFile = COVER_NAMES.map(n => join(bookDir, n)).find(p => existsSync(p))

    if (!coverFile) {
      console.log(`Skip (no cover file): ${bookName}`)
      skipped++
      continue
    }

    process.stdout.write(`Patching: ${bookName} ... `)
    try {
      // createOrUpdateContent REPLACES the card's whole content object, so we
      // must fetch the existing content and re-send it (chapters + title)
      // alongside the new cover — otherwise the card's audio is wiped.
      const existing = await client.getContent({ cardId })
      const card = existing.card || existing
      const chapters = card?.content?.chapters || []
      if (chapters.length === 0) {
        // Refuse to write: nothing to preserve, and an empty content object
        // would clobber a card that may still have audio we failed to read.
        console.log('SKIP (card has no chapters; not overwriting)')
        skipped++
        continue
      }

      // Pad to Yoto's cover ratio so it isn't cropped when Yoto resizes it.
      const { buffer, filename } = await prepareCover(coverFile)
      const { coverImage } = await client.uploadCoverImage({
        imageData: buffer,
        filename,
        coverType: 'default' // 638x1011 portrait; 'myo' is a 520x400 landscape crop
      })

      await client.createOrUpdateContent({
        content: {
          cardId,
          title: card.title,
          content: card.content, // preserve existing chapters/tracks verbatim
          metadata: { ...(card.metadata || {}), cover: { ...(card.metadata?.cover || {}), imageL: coverImage.mediaUrl } }
        }
      })
      console.log('✓')
      patched++
    } catch (e) {
      console.log(`FAILED: ${e.textBody || e.message}`)
    }
  }

  console.log(`\nDone! ${patched} card(s) patched, ${skipped} skipped (no cover file, or no chapters to preserve).`)
}

main().catch(err => {
  console.error('\nError:', err.message)
  process.exit(1)
})
