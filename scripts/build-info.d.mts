/**
 * Types for `build-info.mjs`.
 *
 * `apps/web/tsconfig.json` includes `vite.config.ts`, which imports the `.mjs`
 * module directly. Without this declaration a clean `tsc -b` fails with
 * TS7016 (`implicitly has an 'any' type`) — the repo's incremental
 * `tsconfig.tsbuildinfo` hid it. Keep the two files in sync.
 */
export interface BuildInfo {
  version: string
  commit: string | null
  dirty: boolean
  builtAt: number | null
}

export declare function versionFrom(packageJsonPath: string): string
export declare function gitFacts(): { commit: string | null; dirty: boolean }
export declare function buildInfo(options: { packageJson: string; builtAt?: number | null }): BuildInfo
