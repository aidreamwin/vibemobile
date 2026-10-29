import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const id = arg('id')
const name = arg('name') ?? id
// 发布包安装（deploy/install.mjs）把名单放在 data/runners/，并通过
// VIBEMOBILE_RUNNERS_FILE 告诉 Hub；显式 --file 仍然优先。
const file = path.resolve(arg('file') ?? process.env.VIBEMOBILE_RUNNERS_FILE ?? '.multi-runner/runners.json')
if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !name || name.length > 100)
  throw new Error('usage: node scripts/create-runner.mjs --id=runner-b --name=开发机 [--file=path]')
const specs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
if (!Array.isArray(specs) || specs.some((value) => value.id === id))
  throw new Error('runner ID already exists or config is invalid; choose a new ID')
const token = crypto.randomBytes(32).toString('hex')
specs.push({ id, name, tokenHash: crypto.createHash('sha256').update(token).digest('hex') })
fs.mkdirSync(path.dirname(file), { recursive: true })
const temporary = `${file}.${process.pid}.tmp`
fs.writeFileSync(temporary, JSON.stringify(specs, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
fs.renameSync(temporary, file)
console.log(`Runner registered in ${file}. Restart the new Hub to load changes.`)
console.log(`VIBEMOBILE_RUNNER_ID=${id}`)
console.log(`VIBEMOBILE_RUNNER_TOKEN=${token}`)
console.log('Keep this token on the runner machine; the Hub file contains only its SHA-256 hash.')
