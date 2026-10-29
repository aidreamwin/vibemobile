/**
 * 生成本地 Hub 的原生 TLS 证书（私有 CA + 服务器证书 + 私钥）。
 *
 * 输出目录默认 `certs/`，已被 .gitignore 忽略；私钥绝不入库。
 * 服务器证书默认包含本机回环、主机名和所有非回环 IPv4/IPv6 地址，
 * 因此局域网直接用 https://<当前IP>:3000 也能通过地址校验。
 *
 *   node scripts/generate-hub-certs.mjs
 *   node scripts/generate-hub-certs.mjs --san=10.0.0.5 --san=hub.lan --force
 *
 * 需要 PATH 里（或 OPENSSL 环境变量指向）openssl。Windows 上会自动尝试
 * Git for Windows 自带的 openssl。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const force = args.includes('--force')
const out = path.resolve(value('out') ?? 'certs')
const caDays = Number(value('ca-days') ?? 3650)
const serverDays = Number(value('days') ?? 825)
if (!Number.isInteger(caDays) || caDays < 1 || !Number.isInteger(serverDays) || serverDays < 1)
  throw new Error('--days / --ca-days must be positive integers')

const files = {
  caKey: path.join(out, 'ca-key.pem'),
  caCert: path.join(out, 'ca.pem'),
  caDer: path.join(out, 'ca.crt'),
  hubKey: path.join(out, 'hub-key.pem'),
  hubCert: path.join(out, 'hub-cert.pem'),
}
for (const file of [files.caKey, files.caCert, files.hubKey, files.hubCert]) {
  if (fs.existsSync(file) && !force) throw new Error(`${file} already exists; pass --force to replace it`)
}

function findOpenssl() {
  const candidates = [
    process.env.OPENSSL,
    'openssl',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) return candidate
  }
  throw new Error('openssl not found; install it or set OPENSSL=/path/to/openssl')
}

const openssl = findOpenssl()
const run = (argv) => {
  const result = spawnSync(openssl, argv, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0)
    throw new Error(`openssl ${argv[0]} failed: ${(result.stderr || result.stdout || '').trim()}`)
}

// SAN 覆盖当前机器的所有非回环地址；主机名同时作为 CN。
const dns = new Set(['localhost', os.hostname(), `${os.hostname()}.local`])
const ips = new Set(['127.0.0.1', '::1'])
for (const list of Object.values(os.networkInterfaces())) {
  for (const address of list ?? []) {
    if (address.internal) continue
    const family = typeof address.family === 'string' ? address.family : `IPv${address.family}`
    if (family === 'IPv4' && !address.address.startsWith('169.254.')) ips.add(address.address)
    if (family === 'IPv6' && !address.address.startsWith('fe80:')) ips.add(address.address)
  }
}
for (const san of args.filter((arg) => arg.startsWith('--san='))) {
  const entry = san.slice('--san='.length).trim()
  if (!entry) throw new Error('--san requires a hostname or IP address')
  if (/^[\d.]+$/.test(entry) || entry.includes(':')) ips.add(entry)
  else dns.add(entry)
}
const subjectAltName = [
  ...[...dns].sort().map((name) => `DNS:${name}`),
  ...[...ips].sort().map((ip) => `IP:${ip}`),
].join(',')

fs.mkdirSync(out, { recursive: true })
run(['genrsa', '-out', files.caKey, '4096'])
run([
  'req',
  '-x509',
  '-new',
  '-key',
  files.caKey,
  '-sha256',
  '-days',
  String(caDays),
  '-out',
  files.caCert,
  '-subj',
  '/CN=VibeMobile Local CA',
  '-addext',
  'basicConstraints=critical,CA:TRUE,pathlen:0',
  '-addext',
  'keyUsage=critical,keyCertSign,cRLSign',
  '-addext',
  'subjectKeyIdentifier=hash',
])
run(['genrsa', '-out', files.hubKey, '2048'])
const csr = path.join(out, 'hub.csr')
const ext = path.join(out, 'hub.ext')
const leaf = path.join(out, 'hub-leaf.pem')
run(['req', '-new', '-key', files.hubKey, '-out', csr, '-subj', `/CN=${os.hostname().replace(/[^\w.-]/g, '')}`])
fs.writeFileSync(
  ext,
  [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${subjectAltName}`,
    'authorityKeyIdentifier=keyid,issuer',
    'subjectKeyIdentifier=hash',
    '',
  ].join('\n'),
)
run([
  'x509',
  '-req',
  '-in',
  csr,
  '-CA',
  files.caCert,
  '-CAkey',
  files.caKey,
  '-CAcreateserial',
  '-days',
  String(serverDays),
  '-sha256',
  '-out',
  leaf,
  '-extfile',
  ext,
])
// 服务器证书文件带完整链；runner 也可以直接用 ca.pem 作为信任锚。
fs.writeFileSync(files.hubCert, fs.readFileSync(leaf, 'utf8') + fs.readFileSync(files.caCert, 'utf8'))
run(['x509', '-in', files.caCert, '-outform', 'der', '-out', files.caDer])
for (const temporary of [csr, ext, leaf]) fs.rmSync(temporary, { force: true })
if (process.platform !== 'win32') for (const file of [files.caKey, files.hubKey]) fs.chmodSync(file, 0o600)

const enddate = spawnSync(openssl, ['x509', '-in', files.hubCert, '-noout', '-enddate'], {
  encoding: 'utf8',
  windowsHide: true,
}).stdout.trim()
console.log(`CA certificate   ${files.caCert}`)
console.log(`CA for phones    ${files.caDer}  (DER; install as a trusted profile)`)
console.log(`Hub certificate  ${files.hubCert}`)
console.log(`Hub private key  ${files.hubKey}`)
console.log(`SAN              ${subjectAltName}`)
console.log(`Validity         ${serverDays} days (${enddate.replace(/^notAfter=/, 'until ')})`)
