import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import * as coc from 'coc.nvim'
import semver from 'semver'
import which from 'which'
import * as minisign from './minisign'
import { ensureDirectory, fileExists, getVersion, getZigArchName, getZigOSName, USER_AGENT } from './util'

const execFileAsync = promisify(execFile)

/** The maximum number of installations to keep before the least recently used ones are removed. */
const MAX_INSTALL_COUNT = 5
const REQUEST_TIMEOUT = 30_000
const EXTRACT_TIMEOUT = 60_000

/** Maps concurrent requests to install a version of an executable to a single promise. */
const inProgressInstalls = new Map<string, Promise<string>>()

export interface Config {
  context: coc.ExtensionContext
  /** The name of the application. */
  title: string
  /** The name of the executable file. */
  exeName: string
  minisignKey: minisign.Key
  /** The command-line argument passed to `tar` to extract the tarball. */
  extraTarArgs: string[]
  /** The command-line argument used to query the version. */
  versionArg: string
  getMirrorUrls: () => Promise<string[]>
  /** The canonical download URL of the artifacts for a specific version, ending with a slash. */
  getCanonicalUrl: (version: semver.SemVer) => string
  /**
   * Returns the URL of a single artifact of a specific version hosted elsewhere, e.g. on a release
   * page, or null when it is not available. Only tried when the canonical URL fails.
   */
  getFallbackArtifactUrl?: (version: semver.SemVer) => Promise<string | null>
  /** Get the artifact file name for a specific version, e.g. `zls-x86_64-windows-0.14.0.zip`. */
  getArtifactName: (version: semver.SemVer) => string
}

const getTargetName = (): string => `${getZigArchName('armv7a')}-${getZigOSName()}`

const getStorageDir = (config: Config): string => path.join(config.context.storagePath, config.exeName)

const getInstallDirName = (version: semver.SemVer): string => `${getTargetName()}-${version.raw}`

const getExeName = (config: Config): string =>
  process.platform === 'win32' ? `${config.exeName}.exe` : config.exeName

const getLastAccessKey = (config: Config, name: string): string => `${config.exeName}-last-access-time-${name}`

/** Resolves an artifact file name against the base URL it is hosted at. */
const getArtifactUrl = (baseUrl: string, fileName: string): string =>
  new URL(fileName, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href

const getTarExePath = async (): Promise<string | null> => {
  if (process.platform === 'win32' && process.env.SYSTEMROOT) {
    // Git Bash may put GNU tar on PATH, but bsdtar from the system directory is needed to extract zip files.
    const tarPath = `${process.env.SYSTEMROOT}\\system32\\tar.exe`
    if (await fileExists(tarPath)) return tarPath
  }
  return which.sync('tar', { nothrow: true })
}

/** Install a version and return the path to the executable. */
export const install = async (config: Config, version: semver.SemVer): Promise<string> => {
  const key = config.exeName + version.raw
  const running = inProgressInstalls.get(key)
  if (running) return running

  const promise = installGuarded(config, version)
  inProgressInstalls.set(key, promise)

  try {
    return await promise
  } finally {
    inProgressInstalls.delete(key)
  }
}

async function installGuarded(config: Config, version: semver.SemVer): Promise<string> {
  const installDir = path.join(getStorageDir(config), getInstallDirName(version))
  const exePath = path.join(installDir, getExeName(config))

  await setLastAccessTime(config, getInstallDirName(version))

  if (await fileExists(exePath)) return exePath

  const tarPath = await getTarExePath()
  if (!tarPath) throw new Error(`Can't install ${config.title} because 'tar' could not be found`)

  const mirrors = [...(await config.getMirrorUrls())]
    .map(mirror => ({ mirror, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ mirror }) => mirror)

  const fileName = config.getArtifactName(version)

  return coc.window.withProgress(
    { title: `Installing ${config.title} ${version.toString()}`, cancellable: true },
    async (progress, token) => {
      for (const mirror of mirrors) {
        try {
          return await installFromSource(
            config,
            version,
            getArtifactUrl(mirror, fileName),
            tarPath,
            progress,
            token,
          )
        } catch {}
      }

      const canonicalUrl = getArtifactUrl(config.getCanonicalUrl(version), fileName)

      try {
        return await installFromSource(config, version, canonicalUrl, tarPath, progress, token)
      } catch (error) {
        const fallbackUrl = await config.getFallbackArtifactUrl?.(version)
        if (!fallbackUrl) throw error
        return installFromSource(config, version, fallbackUrl, tarPath, progress, token)
      }
    },
  )
}

async function installFromSource(
  config: Config,
  version: semver.SemVer,
  artifactUrl: string,
  tarPath: string,
  progress: coc.Progress<{ message?: string, increment?: number }>,
  token: coc.CancellationToken,
): Promise<string> {
  const installDir = path.join(getStorageDir(config), getInstallDirName(version))
  const exePath = path.join(installDir, getExeName(config))
  const fileName = path.basename(new URL(artifactUrl).pathname)
  const tarballPath = path.join(installDir, fileName)
  const mirrorName = new URL(artifactUrl).host

  progress.report({ message: `trying ${mirrorName}` })

  const headers = { 'User-Agent': USER_AGENT }
  const signatureResult = await coc.fetch(
    `${artifactUrl}.minisig`,
    { buffer: true, headers, timeout: REQUEST_TIMEOUT },
    token,
  )

  await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
  await ensureDirectory(installDir)

  progress.report({ message: `downloading from ${mirrorName}` })
  await coc.download(artifactUrl, {
    dest: installDir,
    headers,
    timeout: REQUEST_TIMEOUT,
    onProgress: percent => progress.report({ message: `downloading ${fileName} (${percent}%)` }),
  }, token)

  if (token.isCancellationRequested) throw new Error('Canceled')
  if (!(await fileExists(tarballPath))) throw new Error(`Failed to download '${artifactUrl}'`)

  progress.report({ message: 'Verifying signature...' })
  const artifactData = await fs.promises.readFile(tarballPath)
  const signature = minisign.parseSignature(Buffer.from(signatureResult as Buffer))
  if (!minisign.verifySignature(config.minisignKey, signature, artifactData)) {
    await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`signature verification failed for '${artifactUrl}'`)
  }

  // The trusted comment names the canonical artifact, which the artifact URL does not always match.
  const match = /^timestamp:\d+\s+file:(\S+)\s+hashed$/.exec(signature.trustedComment.toString())
  if (match?.[1] !== config.getArtifactName(version)) {
    await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`filename verification failed for '${artifactUrl}'`)
  }

  progress.report({ message: 'Extracting...' })

  try {
    await execFileAsync(tarPath, ['-xf', tarballPath, '-C', installDir, ...config.extraTarArgs], {
      timeout: EXTRACT_TIMEOUT,
    })
  } catch (error) {
    await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`Failed to extract ${config.title} tarball: ${(error as Error).message}`)
  } finally {
    await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined)
  }

  const exeVersion = getVersion(exePath, config.versionArg)
  if (!exeVersion || exeVersion.compare(version) !== 0) {
    await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`Failed to validate version of ${config.title} installation!`)
  }

  await fs.promises.chmod(exePath, 0o755).catch(() => undefined)
  await removeUnusedInstallations(config).catch((error: Error) => {
    coc.window.showWarningMessage(`Failed to uninstall unused ${config.title} versions: ${error.message}`)
  })

  return exePath
}

/** Returns all locally installed versions. */
export const query = async (config: Config): Promise<semver.SemVer[]> => {
  const prefix = getTargetName()
  const available: semver.SemVer[] = []

  let entries: string[]
  try {
    entries = await fs.promises.readdir(getStorageDir(config))
  } catch {
    return []
  }

  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const version = semver.parse(name.substring(prefix.length + 1))
    if (version) available.push(version)
  }

  return available
}

async function setLastAccessTime(config: Config, installDirName: string): Promise<void> {
  await config.context.globalState.update(getLastAccessKey(config, installDirName), Date.now())
}

/** Remove installations with the oldest last access time until at most `MAX_INSTALL_COUNT` versions remain. */
async function removeUnusedInstallations(config: Config): Promise<void> {
  const storageDir = getStorageDir(config)

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(storageDir, { withFileTypes: true })
  } catch {
    return
  }

  const installs: { key: string, installDir: string, lastAccessTime: number }[] = []

  for (const entry of entries) {
    const installDir = path.join(storageDir, entry.name)
    const key = getLastAccessKey(config, entry.name)
    const lastAccessTime = config.context.globalState.get<number>(key)

    if (!lastAccessTime || !entry.isDirectory()) {
      await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    } else {
      installs.push({ key, installDir, lastAccessTime })
    }
  }

  installs.sort((lhs, rhs) => rhs.lastAccessTime - lhs.lastAccessTime)

  for (const item of installs.slice(MAX_INSTALL_COUNT)) {
    await fs.promises.rm(item.installDir, { recursive: true, force: true }).catch(() => undefined)
    await config.context.globalState.update(item.key, undefined)
  }
}
