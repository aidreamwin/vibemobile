import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const media = path.join(repo, 'docs', 'media')
const output = path.join(media, 'webp')
const ffmpeg = process.env.VIBEMOBILE_FFMPEG || 'ffmpeg'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const generatedPng = new Set([
  'approval.png',
  'diff.png',
  'overview.png',
  'sessions.png',
  'settings.png',
  'source.png',
  'streaming.png',
  'terminal.png',
  'workflow-poster.png',
])

await mkdir(output, { recursive: true })
const files = (await readdir(media, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
  .map((entry) => entry.name)

if (files.length === 0) {
  console.log(`No PNG files found in ${media}; skipping WebP conversion`)
  process.exit(0)
}

for (const file of files) {
  const source = path.join(media, file)
  const target = path.join(output, `${path.basename(file, path.extname(file))}.webp`)
  await run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-c:v',
    'libwebp',
    '-quality',
    '95',
    target,
  ])
}

const manifestPath = path.join(media, 'manifest.json')
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const artifact of manifest.artifacts ?? []) {
    if (!artifact.file.toLowerCase().endsWith('.png')) continue
    const webpFile = `webp/${path.basename(artifact.file, path.extname(artifact.file))}.webp`
    let bytes
    try {
      bytes = await readFile(path.join(media, webpFile))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    artifact.file = webpFile
    artifact.bytes = bytes.length
    artifact.sha256 = sha256(bytes)
  }
  const index = await readFile(path.join(media, 'index.html'))
  const indexArtifact = manifest.artifacts?.find((artifact) => artifact.file === 'index.html')
  if (indexArtifact) {
    indexArtifact.bytes = index.length
    indexArtifact.sha256 = sha256(index)
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

for (const file of generatedPng) {
  await unlink(path.join(media, file)).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
}

console.log(`Converted ${files.length} PNG files to WebP in ${path.relative(repo, output)}`)
