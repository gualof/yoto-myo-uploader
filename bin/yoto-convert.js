#!/usr/bin/env node
/**
 * yoto-convert
 * Converts a tree of audiobooks into organized, Yoto-ready MP3s that CONFORM to
 * Yoto MYO card limits. Walks nested folders (Author/Book or Author/Series/Book),
 * flattens each book into one output folder, re-encodes spoken-word audio to a
 * compact format, and splits any track that is too long to fit on a card.
 *
 * Requires: ffmpeg + ffprobe installed and on PATH.
 *
 * Yoto MYO limits enforced here:
 *   - 100 tracks per card
 *   - 60 min / 100 MB per single track   -> long tracks are split
 *   - 500 MB per card                    -> handled by re-encoding to 64k mono
 *   (5 h/card is a soft limit Yoto does not hard-enforce; size is the real cap.)
 *
 * Usage:
 *   node bin/yoto-convert.js <source> <output> [options]
 *
 * Options:
 *   --dry-run            Plan and report only. Writes nothing. (Do this first.)
 *   --bitrate <kbps>     Target audio bitrate, default 64 (good for speech).
 *   --stereo             Keep stereo. Default is mono (best for audiobooks).
 *   --max-minutes <n>    Split tracks longer than this. Default 55.
 *   --keep-author        Keep the top-level folder (author) in the card name.
 *                        Default drops it when the tree is nested.
 *   --force-reencode     Re-encode even already-conformant MP3s.
 *
 * Source tree (any depth; a "book" is any folder that directly contains audio):
 *   /source/
 *     R.J. Palacio/Wonder/*.mp3                 -> card "Wonder"
 *     P.L. Travers/Mary Poppins/1 - .../*.mp3   -> card "Mary Poppins - 1 - ..."
 *
 * Output tree (flat, one folder per card — consumable by yoto-upload):
 *   /output/
 *     Wonder/001 - Chapter One.mp3 ...
 *     Mary Poppins - 1 - Mary Poppins/001 - ....mp3 ...
 */

import { readdir, mkdir, copyFile, stat, access, rename, rm, readFile } from 'fs/promises'
import { join, extname, basename, resolve, relative, sep } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.flac', '.wav'])
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png']
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// Pick the cover image from a book folder's file list.
// Order: canonical cover/folder name -> any name containing "cover" -> largest image.
async function chooseCover (bookDir, files) {
  const exact = files.find(f => COVER_NAMES.includes(f.toLowerCase()))
  if (exact) return exact
  const imgs = files.filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))
  if (imgs.length === 0) return null
  const named = imgs.find(f => /cover/i.test(f))
  if (named) return named
  let best = imgs[0]; let bestSize = -1
  for (const f of imgs) {
    const s = (await stat(join(bookDir, f))).size
    if (s > bestSize) { bestSize = s; best = f }
  }
  return best
}

// Yoto hard limits
const MAX_TRACKS_PER_CARD = 100
const MAX_TRACK_MB = 100
const MAX_CARD_MB = 500

// ── Options ────────────────────────────────────────────────────────────────
function parseArgs (argv) {
  const positional = []
  const opts = {
    dryRun: false,
    bitrate: 64,        // kbps
    channels: 1,        // mono
    maxMinutes: 55,
    keepAuthor: false,
    forceReencode: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--stereo') opts.channels = 2
    else if (a === '--keep-author') opts.keepAuthor = true
    else if (a === '--force-reencode') opts.forceReencode = true
    else if (a === '--bitrate') opts.bitrate = parseInt(argv[++i], 10)
    else if (a === '--max-minutes') opts.maxMinutes = parseInt(argv[++i], 10)
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1) }
    else positional.push(a)
  }
  return { positional, opts }
}

// ── ffmpeg / ffprobe helpers ─────────────────────────────────────────────────
async function checkTool (name) {
  try { await execFileAsync(name, ['-version']); return true } catch { return false }
}

async function probe (file) {
  // Returns { duration (s), bitrate (kbps), channels }
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=bit_rate,channels,codec_type',
      '-of', 'json', file
    ])
    const j = JSON.parse(stdout)
    const dur = parseFloat(j.format?.duration) || 0
    const audio = (j.streams || []).find(s => s.codec_type === 'audio') || {}
    const br = audio.bit_rate ? Math.round(parseInt(audio.bit_rate, 10) / 1000) : null
    const ch = audio.channels || null
    return { duration: dur, bitrate: br, channels: ch }
  } catch {
    return { duration: 0, bitrate: null, channels: null }
  }
}

async function exists (p) { try { await access(p); return true } catch { return false } }

// Extract a useful one-line error from a failed execFile (ffmpeg writes the real
// cause to stderr; the last non-empty line is usually the actionable message).
function ffErr (err) {
  const src = (err.stderr && err.stderr.trim()) || err.message || ''
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] || 'unknown error'
}

// Strip track-number/index noise from a filename, leaving a human title.
// Returns '' when nothing meaningful remains (caller falls back to "Chapter N").
// Deliberately conservative: never strips interior words like "Part" that are
// meaningful in titles such as "Chapter 3, Part 1".
function cleanTrackTitle (filename, ext) {
  let s = filename.slice(0, -ext.length)
  s = s.replace(/^.*?\bBook\s*\d+\s*[-–—]\s*/i, '')   // drop "… - Book N -" prefix
  s = s.replace(/^\s*\d+\s*of\s*\d+\s*[-._]*\s*/i, '') // leading "NN of MM"
  s = s.replace(/^\s*\d+[\s._-]+/i, '')                // leading "NN " / "NN - " / "NN."
  s = s.replace(/[\s\-_.]+\d+\s*of\s*\d+\s*$/i, '')     // trailing "NN of MM"
  s = s.replace(/[-_]\s*part\s*\d+\s*$/i, '')           // trailing "-PartNN" (hyphen-attached)
  s = s.replace(/\s*[-_]\s*\d+\s*$/i, '')               // trailing " - NN" (dash form)
  s = s.replace(/^[\s\-_.,]+|[\s\-_.,]+$/g, '').trim()
  return s
}

// Keep ffmpeg stderr small (no per-frame progress) so long files can't overflow
// execFile's stderr buffer, and raise the ceiling anyway as insurance.
const FF_QUIET = ['-hide_banner', '-nostats', '-loglevel', 'error']
const FF_EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024 }

// ffmpeg encode args for a single mono/stereo re-encode
function encodeArgs (input, output, opts) {
  return [
    ...FF_QUIET,
    '-i', input, '-vn', '-map', '0:a:0',
    '-ac', String(opts.channels),
    '-ar', '44100',
    '-b:a', `${opts.bitrate}k`,
    '-y', output
  ]
}

// ── Discover books: any folder that directly contains audio files ─────────────
// `skipDir` (the output dir) is excluded so re-runs don't re-discover already-
// converted books when the output lives inside the source tree.
async function findBooks (root, skipDir) {
  const books = []
  async function walk (dir) {
    if (skipDir && resolve(dir) === resolve(skipDir)) return
    const entries = await readdir(dir, { withFileTypes: true })
    // Audio detection by extension so symlinked files (common on NAS libraries) count too.
    const audio = entries.filter(e => !e.isDirectory() && AUDIO_EXTS.has(extname(e.name).toLowerCase()))
    if (audio.length > 0) {
      books.push(dir)               // leaf that holds tracks — do not descend further
      return
    }
    // Recurse into directories, resolving symlinks that point at directories.
    const subdirs = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      let isDir = e.isDirectory()
      if (e.isSymbolicLink()) {
        try { isDir = (await stat(join(dir, e.name))).isDirectory() } catch { isDir = false }
      }
      if (isDir) subdirs.push(e.name)
    }
    for (const name of subdirs.sort((a, b) => a.localeCompare(b))) {
      await walk(join(dir, name))
    }
  }
  await walk(root)
  return books.sort()
}

// Flatten "Author/Series/Book" -> a single, unambiguous card name
function cardName (sourceRoot, bookDir, keepAuthor) {
  const segs = relative(sourceRoot, bookDir).split(sep).filter(Boolean)
  const useSegs = (!keepAuthor && segs.length > 1) ? segs.slice(1) : segs
  return useSegs.join(' - ')
}

// ── Plan one book (probe every track, decide copy/encode/split) ───────────────
async function planBook (bookDir, opts) {
  const maxSec = opts.maxMinutes * 60
  const files = (await readdir(bookDir))
    .filter(f => AUDIO_EXTS.has(extname(f).toLowerCase()))
    .sort()

  const items = []
  for (const f of files) {
    const p = join(bookDir, f)
    const ext = extname(f).toLowerCase()
    const { duration, bitrate, channels } = await probe(p)
    const sizeBytes = (await stat(p)).size
    const sizeMB = sizeBytes / 1e6
    const rawTitle = cleanTrackTitle(f, ext)

    const fitsDur = duration > 0 && duration <= maxSec
    const alreadyGood = !opts.forceReencode &&
      ext === '.mp3' &&
      channels === opts.channels &&
      bitrate != null && bitrate <= opts.bitrate * 1.1 &&
      sizeMB <= MAX_TRACK_MB &&
      fitsDur

    let action, parts, projMB
    if (fitsDur && alreadyGood) {
      action = 'copy'; parts = 1; projMB = sizeMB
    } else if (fitsDur) {
      action = 'encode'; parts = 1; projMB = (opts.bitrate / 8) * duration / 1000 // MB
    } else {
      parts = Math.max(1, Math.ceil(duration / maxSec))
      action = 'split'; projMB = (opts.bitrate / 8) * duration / 1000
    }
    items.push({ file: f, path: p, ext, rawTitle, duration, bitrate, channels, sizeMB, action, parts, projMB })
  }

  // Assign final titles: keep a distinct, meaningful name; otherwise (empty, or a
  // name shared by 2+ tracks — e.g. every file cleans to the book title) number
  // sequentially as "Chapter N".
  const counts = {}
  for (const it of items) if (it.rawTitle) counts[it.rawTitle.toLowerCase()] = (counts[it.rawTitle.toLowerCase()] || 0) + 1
  items.forEach((it, idx) => {
    it.title = (it.rawTitle && counts[it.rawTitle.toLowerCase()] === 1) ? it.rawTitle : `Chapter ${idx + 1}`
  })

  const totalTracks = items.reduce((n, it) => n + it.parts, 0)
  const totalMB = items.reduce((n, it) => n + it.projMB, 0)
  const totalDur = items.reduce((n, it) => n + it.duration, 0)
  const cover = await chooseCover(bookDir, await readdir(bookDir))
  return { items, totalTracks, totalMB, totalDur, cover }
}

// ── Execute the plan for one book ─────────────────────────────────────────────
async function convertBook (bookDir, bookOut, plan, opts) {
  await mkdir(bookOut, { recursive: true })
  let track = 0
  const pad = n => String(n).padStart(3, '0')

  for (const it of plan.items) {
    if (it.action === 'copy') {
      track++
      const out = join(bookOut, `${pad(track)} - ${it.title}.mp3`)
      process.stdout.write(`  [${pad(track)}] ${it.title} (copy)`)
      if (await exists(out)) { console.log(' (exists)'); continue }
      await copyFile(it.path, out)
      console.log(' ✓')
    } else if (it.action === 'encode') {
      track++
      const out = join(bookOut, `${pad(track)} - ${it.title}.mp3`)
      process.stdout.write(`  [${pad(track)}] ${it.title} (${opts.bitrate}k ${opts.channels === 1 ? 'mono' : 'stereo'})`)
      if (await exists(out)) { console.log(' (exists)'); continue }
      try {
        await execFileAsync('ffmpeg', encodeArgs(it.path, out, opts), FF_EXEC_OPTS)
        console.log(' ✓')
      } catch (err) { console.log(` FAILED: ${ffErr(err)}`) }
    } else { // split
      const numParts = Math.max(2, Math.ceil(it.duration / (opts.maxMinutes * 60)))
      const step = it.duration / numParts // balanced parts
      // Explicit cut points -> exactly numParts files, last runs to EOF (no sliver).
      const times = Array.from({ length: numParts - 1 }, (_, k) => ((k + 1) * step).toFixed(3)).join(',')
      process.stdout.write(`  ${it.title}: splitting into ${numParts} parts (~${Math.round(step / 60)} min each)\n`)
      // Write segments into a plain temp subdir (NOT dotfiles — some SMB/NAS
      // mounts reject hidden-file creation by the segment muxer), then move.
      const tmpDir = join(bookOut, '_segtmp')
      await rm(tmpDir, { recursive: true, force: true })
      await mkdir(tmpDir, { recursive: true })
      try {
        await execFileAsync('ffmpeg', [
          ...FF_QUIET,
          '-i', it.path, '-vn', '-map', '0:a:0',
          '-ac', String(opts.channels), '-ar', '44100', '-b:a', `${opts.bitrate}k`,
          '-f', 'segment', '-segment_times', times, '-reset_timestamps', '1',
          '-y', join(tmpDir, 'seg_%03d.mp3')
        ], FF_EXEC_OPTS)
      } catch (err) { console.log(`    FAILED: ${ffErr(err)}`); await rm(tmpDir, { recursive: true, force: true }); continue }
      const segs = (await readdir(tmpDir)).filter(f => f.endsWith('.mp3')).sort()
      for (let k = 0; k < segs.length; k++) {
        track++
        const out = join(bookOut, `${pad(track)} - ${it.title} (Part ${k + 1}).mp3`)
        await rename(join(tmpDir, segs[k]), out)
        console.log(`    [${pad(track)}] ${it.title} (Part ${k + 1}) ✓`)
      }
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  // Cover art (chosen during planning)
  const cover = plan.cover
  if (cover) {
    const destName = `cover${extname(cover).toLowerCase()}`
    await copyFile(join(bookDir, cover), join(bookOut, destName))
    console.log(`  Cover copied (${cover}${COVER_NAMES.includes(cover.toLowerCase()) ? '' : ' → cover' + extname(cover).toLowerCase()})`)
  } else {
    console.log('  (no cover art found)')
  }
}

function limitFlags (tracks, mb, dur) {
  const f = []
  if (tracks > MAX_TRACKS_PER_CARD) f.push(`⚠ ${tracks} tracks > ${MAX_TRACKS_PER_CARD}`)
  if (mb > MAX_CARD_MB) f.push(`⚠ ${mb.toFixed(0)} MB > ${MAX_CARD_MB} MB`)
  return f
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main () {
  const { positional, opts } = parseArgs(process.argv.slice(2))
  const sourceDir = resolve(positional[0] || '')
  const outputDir = resolve(positional[1] || '')

  if (!positional[0] || !positional[1]) {
    console.error('Usage: node bin/yoto-convert.js <source> <output> [options]')
    console.error('  --dry-run  --bitrate <kbps>  --stereo  --max-minutes <n>')
    console.error('  --keep-author  --force-reencode')
    console.error('\nTip: run with --dry-run first to see the plan before writing anything.')
    process.exit(1)
  }

  try { if (!(await stat(sourceDir)).isDirectory()) throw new Error() }
  catch { console.error(`Error: source folder not found: ${sourceDir}`); process.exit(1) }

  if (!(await checkTool('ffmpeg')) || !(await checkTool('ffprobe'))) {
    console.error('Error: ffmpeg/ffprobe not found. Install:')
    console.error('  Mac:    brew install ffmpeg')
    console.error('  Ubuntu: sudo apt install ffmpeg')
    process.exit(1)
  }

  console.log('\nyoto-convert' + (opts.dryRun ? '  [DRY RUN — nothing will be written]' : ''))
  console.log(`Source:  ${sourceDir}`)
  console.log(`Output:  ${outputDir}`)
  console.log(`Encode:  ${opts.bitrate}k ${opts.channels === 1 ? 'mono' : 'stereo'}, split > ${opts.maxMinutes} min\n`)

  const books = await findBooks(sourceDir, outputDir)
  if (books.length === 0) { console.error('No folders containing audio found under source.'); process.exit(1) }
  console.log(`Found ${books.length} book(s).\n`)

  if (!opts.dryRun) await mkdir(outputDir, { recursive: true })

  let converted = 0, skipped = 0
  const warnings = []

  for (let i = 0; i < books.length; i++) {
    const bookDir = books[i]
    const name = cardName(sourceDir, bookDir, opts.keepAuthor)
    const bookOut = join(outputDir, name)
    console.log(`[${i + 1}/${books.length}] ${name}`)

    // resumable skip
    if (!opts.dryRun && await exists(bookOut)) {
      const have = (await readdir(bookOut)).filter(f => extname(f).toLowerCase() === '.mp3')
      if (have.length > 0) { console.log('  Skip (already converted).\n'); skipped++; continue }
    }

    const plan = await planBook(bookDir, opts)
    const flags = limitFlags(plan.totalTracks, plan.totalMB, plan.totalDur)

    // Plan summary line
    const nCopy = plan.items.filter(it => it.action === 'copy').length
    const nEnc = plan.items.filter(it => it.action === 'encode').length
    const nSplit = plan.items.filter(it => it.action === 'split').length
    console.log(`  Plan: ${plan.items.length} source file(s) -> ${plan.totalTracks} track(s) ` +
      `(${nCopy} copy, ${nEnc} re-encode, ${nSplit} split), ` +
      `~${plan.totalMB.toFixed(0)} MB, ${(plan.totalDur / 3600).toFixed(1)} h`)
    console.log(`  Cover: ${plan.cover || '⚠ none found'}`)
    if (flags.length) { console.log(`  ${flags.join('  ')}`); warnings.push(`${name}: ${flags.join(', ')}`) }

    if (opts.dryRun) { console.log(''); continue }

    await convertBook(bookDir, bookOut, plan, opts)
    console.log('')
    converted++
  }

  console.log('─'.repeat(60))
  if (opts.dryRun) {
    console.log(`Dry run complete. ${books.length} book(s) planned.`)
  } else {
    console.log(`Done! ${converted} converted, ${skipped} skipped.`)
    console.log(`Output: ${outputDir}`)
    console.log(`\nNext: node bin/yoto-upload.js "${outputDir}"`)
  }
  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} card(s) still exceed a Yoto limit — review before uploading:`)
    for (const w of warnings) console.log(`   - ${w}`)
  }
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1) })
