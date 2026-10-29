import fs from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'

type Environment = Record<string, string | undefined>
export interface HubHttpsOptions {
  cert: Buffer
  key: Buffer
  minVersion: 'TLSv1.2'
}

export function loadHubTls(env: Environment = process.env): HubHttpsOptions | undefined {
  const mode = env.VIBEMOBILE_HUB_TLS?.trim() || 'off'
  if (mode === 'off') return undefined
  if (mode !== 'on') throw new Error('VIBEMOBILE_HUB_TLS must be on or off')
  if (!env.VIBEMOBILE_HUB_TLS_CERT_FILE || !env.VIBEMOBILE_HUB_TLS_KEY_FILE)
    throw new Error('native Hub TLS requires VIBEMOBILE_HUB_TLS_CERT_FILE and VIBEMOBILE_HUB_TLS_KEY_FILE')
  const options: HubHttpsOptions = {
    cert: fs.readFileSync(env.VIBEMOBILE_HUB_TLS_CERT_FILE),
    key: fs.readFileSync(env.VIBEMOBILE_HUB_TLS_KEY_FILE),
    minVersion: 'TLSv1.2',
  }
  // Fail before starting the execution service if PEM files or the key pair are invalid.
  createSecureContext(options)
  return options
}

export function loadRunnerCa(hubUrl: string, env: Environment = process.env): Buffer | undefined {
  if (new URL(hubUrl).protocol !== 'wss:' || !env.VIBEMOBILE_HUB_CA_FILE) return undefined
  const ca = fs.readFileSync(env.VIBEMOBILE_HUB_CA_FILE)
  const certificates = ca.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!certificates?.length) throw new Error('VIBEMOBILE_HUB_CA_FILE must contain PEM certificates')
  for (const certificate of certificates) new X509Certificate(certificate)
  return ca
}

export function defaultRunnerTransport(port: number, tls: HubHttpsOptions | undefined, env: Environment = process.env) {
  const hubUrl = env.VIBEMOBILE_DEFAULT_RUNNER_HUB_URL || `${tls ? 'wss' : 'ws'}://127.0.0.1:${port}`
  if (new URL(hubUrl).protocol !== (tls ? 'wss:' : 'ws:'))
    throw new Error('default runner URL must match the Hub TLS mode')
  return {
    VIBEMOBILE_HUB_URL: hubUrl,
    // For self-signed Hub certificates the public certificate itself is the trust anchor.
    // Private CA deployments supply the issuing CA explicitly.
    VIBEMOBILE_HUB_CA_FILE: tls ? env.VIBEMOBILE_HUB_CA_FILE || env.VIBEMOBILE_HUB_TLS_CERT_FILE || '' : '',
  }
}
