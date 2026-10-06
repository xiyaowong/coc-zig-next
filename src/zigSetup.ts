import * as fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import * as coc from 'coc.nvim'
import semver from 'semver'
import * as minisign from './minisign'
import {
  asyncDebounce,
  errorMessage,
  getConfiguration,
  getOptionalString,
  getWorkspaceFolderPath,
  getZigArchName,
  getZigOSName,
  updateConfiguration,
} from './util'
import * as versionManager from './versionManager'
import { ZigProvider } from './zigProvider'

let statusItem: coc.StatusBarItem
let versionManagerConfig: versionManager.Config
let context: coc.ExtensionContext
export const zigProvider = new ZigProvider()

/** The order of these enums defines the order in which these sources are applied. */
enum WantedZigVersionSource {
  /** `.zigversion` */
  workspaceZigVersionFile = '.zigversion',
  /** The `minimum_zig_version` in `build.zig.zon` */
  workspaceBuildZigZon = 'build.zig.zon',
  /** `zig.version` */
  zigVersionConfigOption = 'zig.version',
}

interface ZigVersion {
  name: string
  version: semver.SemVer
  url: string
  sha: string
  notes?: string
  isMach: boolean
}

type VersionIndex = Record<string, { version?: string, notes?: string, [target: string]: unknown }>

const getZigArchNameForVersion = (version: semver.SemVer): string =>
  version.compare(new semver.SemVer('0.15.0-dev.836+080ee25ec')) <= 0
    ? getZigArchName('armv7a')
    : getZigArchName('arm')

const sortVersions = (versions: { name?: string, version: semver.SemVer, isMach: boolean }[]): void => {
  versions.sort((lhs, rhs) => {
    // Mach versions except `mach-latest` move to the end
    if (lhs.name !== 'mach-latest' && rhs.name !== 'mach-latest' && lhs.isMach !== rhs.isMach) {
      return Number(lhs.isMach) - Number(rhs.isMach)
    }
    return semver.compare(rhs.version, lhs.version)
  })
}

const findClosestSatisfyingZigVersion = async (
  context: coc.ExtensionContext,
  version: semver.SemVer,
): Promise<semver.SemVer> => {
  if (version.prerelease.length !== 0) return version

  try {
    // We can't just return `version` because `0.12.0` should return `0.12.1`.
    const availableVersions = (await getVersions(context)).map(item => item.version)
    return semver.maxSatisfying(availableVersions, `^${version.toString()}`) ?? version
  } catch {
    return version
  }
}

const getLatestTaggedZigVersion = async (context: coc.ExtensionContext): Promise<semver.SemVer | null> => {
  try {
    const versions = await getVersions(context)
    return versions.find(item => item.version.prerelease.length === 0)?.version ?? null
  } catch {
    return null
  }
}

/**
 * Returns a sorted list of all versions provided by Zig's index.json and Mach's index.json.
 * Nominated Mach versions are sorted to the bottom. Throws when no network connection is available.
 */
async function getVersions(context: coc.ExtensionContext): Promise<ZigVersion[]> {
  const cacheKey = 'zig-version-list'
  const urls = ['https://ziglang.org/download/index.json', 'https://pkg.machengine.org/zig/index.json']

  let zigIndexJson: VersionIndex
  let machIndexJson: VersionIndex
  try {
    const responses = await Promise.all(urls.map(async url => (await coc.fetch(url, { timeout: 30_000 })) as VersionIndex))
    zigIndexJson = responses[0]
    machIndexJson = responses[1]
  } catch (error) {
    const cached = context.globalState.get<ZigVersion[]>(cacheKey)
    if (cached !== undefined) {
      for (const version of cached) {
        version.version = new semver.SemVer(version.version.raw)
      }
      return cached
    }
    throw error
  }

  const indexJson: VersionIndex = { ...machIndexJson, ...zigIndexJson }

  const result: ZigVersion[] = []
  for (const [key, value] of Object.entries(indexJson)) {
    const name = key === 'master' ? 'nightly' : key
    const version = new semver.SemVer(value.version ?? key)
    const targetName = `${getZigArchNameForVersion(version)}-${getZigOSName()}`
    const release = value[targetName] as { tarball: string, shasum: string } | undefined
    if (release) {
      result.push({
        name,
        version,
        url: release.tarball,
        sha: release.shasum,
        notes: value.notes,
        isMach: name.includes('mach'),
      })
    }
  }

  if (result.length === 0) {
    throw new Error(
      `no pre-built Zig is available for your system '${getZigArchName('arm')}-${getZigOSName()}', you can build it yourself using https://codeberg.org/ziglang/zig-bootstrap`,
    )
  }

  sortVersions(result)
  await context.globalState.update(cacheKey, result)
  return result
}

/** Removes the `zig.path` config option. */
const installZig = async (context: coc.ExtensionContext, temporaryVersion?: semver.SemVer): Promise<void> => {
  let version = temporaryVersion

  if (!version) {
    const wantedZig = await getWantedZigVersion(Object.values(WantedZigVersionSource) as WantedZigVersionSource[])
    version = wantedZig?.version
    if (wantedZig?.source === WantedZigVersionSource.workspaceBuildZigZon) {
      version = await findClosestSatisfyingZigVersion(context, wantedZig.version)
    }
  }

  if (!version) {
    // Look up zig in $PATH
    const result = zigProvider.resolveZigPathConfigOption('zig')
    if (result) {
      await updateConfiguration(getConfiguration(), 'path', undefined)
      zigProvider.set(result)
      return
    }
  }

  if (!version) {
    version = (await getLatestTaggedZigVersion(context)) ?? undefined
  }

  if (!version) {
    await zigProvider.setAndSave(null)
    return
  }

  try {
    const exePath = await versionManager.install(versionManagerConfig, version)
    await updateConfiguration(getConfiguration(), 'path', undefined)
    zigProvider.set({ exe: exePath, version })
  } catch (error) {
    zigProvider.set(null)
    coc.window.showErrorMessage(`Failed to install Zig ${version.toString()}: ${errorMessage(error)}`)
  }
}

interface BuildZigZonMetadata {
  manifestPath: string
  minimumZigVersion: semver.SemVer
  /** The offset of the quoted version string, without the quotes. */
  minimumZigVersionStart: number
  minimumZigVersionEnd: number
}

const parseBuildZigZon = async (): Promise<BuildZigZonMetadata | null> => {
  const workspace = getWorkspaceFolderPath()
  if (!workspace) return null

  const manifestPath = path.join(workspace, 'build.zig.zon')
  let manifest: string
  try {
    manifest = await fs.promises.readFile(manifestPath, 'utf8')
  } catch {
    return null
  }

  const regex = /\n\s*\.minimum_zig_version\s*=\s*"(.*)"/.exec(manifest)
  if (!regex) return null

  const versionString = regex[1]
  const version = semver.parse(versionString)
  if (!version) return null

  const minimumZigVersionStart = regex.index + regex[0].length - versionString.length - 1

  return {
    manifestPath,
    minimumZigVersion: version,
    minimumZigVersionStart,
    minimumZigVersionEnd: minimumZigVersionStart + versionString.length,
  }
}

/** Try to resolve the workspace-specific Zig version. */
async function getWantedZigVersion(
  sources: WantedZigVersionSource[],
): Promise<{ version: semver.SemVer, source: WantedZigVersionSource } | null> {
  for (const source of sources) {
    let result: semver.SemVer | null = null

    try {
      switch (source) {
        case WantedZigVersionSource.workspaceZigVersionFile: {
          const workspace = getWorkspaceFolderPath()
          if (workspace) {
            const content = await fs.promises.readFile(path.join(workspace, '.zigversion'), 'utf8')
            result = semver.parse(content.trim())
          }
          break
        }
        case WantedZigVersionSource.workspaceBuildZigZon: {
          const metadata = await parseBuildZigZon()
          if (metadata) result = metadata.minimumZigVersion
          break
        }
        case WantedZigVersionSource.zigVersionConfigOption: {
          const versionString = getOptionalString('version')
          if (versionString) {
            result = semver.parse(versionString)
            if (!result) {
              coc.window.showErrorMessage(
                `Invalid 'zig.version' config option. '${versionString}' is not a valid Zig version`,
              )
            }
          }
          break
        }
      }
    } catch {}

    if (!result) continue

    return { version: result, source }
  }

  return null
}

const getMirrors = async (context: coc.ExtensionContext): Promise<string[]> => {
  const cacheKey = 'zig-mirror-list'
  let cached = context.globalState.get<{ timestamp: number, mirrors: string }>(cacheKey, { timestamp: 0, mirrors: '' })

  const millisecondsInDay = 24 * 60 * 60 * 1000
  if (Date.now() - cached.timestamp > millisecondsInDay) {
    try {
      const response = (await coc.fetch('https://ziglang.org/download/community-mirrors.txt', {
        timeout: 30_000,
      })) as string
      cached = { timestamp: Date.now(), mirrors: response }
      await context.globalState.update(cacheKey, cached)
    } catch {
      // Cannot fetch mirrors, rely on the cache.
    }
  }

  return cached.mirrors
    .trim()
    .split('\n')
    .filter(url => !!url)
}

interface VersionQuickPickItem extends coc.QuickPickItem {
  version?: semver.SemVer
  action?: 'workspace' | 'path' | 'manual'
}

const selectVersionAndInstall = async (context: coc.ExtensionContext): Promise<void> => {
  const offlineVersions = await versionManager.query(versionManagerConfig)

  const versions: {
    name?: string
    version: semver.SemVer
    offline: boolean
    online: boolean
    isMach: boolean
  }[] = offlineVersions.map(version => ({ version, offline: true, online: false, isMach: false }))

  await coc.window.withProgress(
    { title: 'Fetching available Zig versions...', cancellable: false },
    async () => {
      let onlineVersions: ZigVersion[]
      try {
        onlineVersions = await getVersions(context)
      } catch (error) {
        if (offlineVersions.length === 0) {
          coc.window.showErrorMessage(`Failed to query available Zig version: ${errorMessage(error)}`)
        }
        return
      }

      for (const onlineVersion of onlineVersions) {
        for (const version of versions) {
          if (semver.eq(version.version, onlineVersion.version)) {
            version.name ??= onlineVersion.name
            version.online = true
            version.isMach = onlineVersion.isMach
          }
        }

        const alreadyListed = versions.some(
          version => semver.eq(version.version, onlineVersion.version) && version.name === onlineVersion.name,
        )
        if (alreadyListed) continue

        versions.push({
          name: onlineVersion.name,
          version: onlineVersion.version,
          online: true,
          offline: offlineVersions.some(item => semver.eq(item.version, onlineVersion.version)),
          isMach: onlineVersion.isMach,
        })
      }
    },
  )

  sortVersions(versions)
  const placeholderVersion = versions.find(item => item.version.prerelease.length === 0)?.version

  const items: VersionQuickPickItem[] = []

  const workspaceZig = await getWantedZigVersion([
    WantedZigVersionSource.workspaceZigVersionFile,
    WantedZigVersionSource.workspaceBuildZigZon,
    WantedZigVersionSource.zigVersionConfigOption,
  ])
  if (workspaceZig !== null) {
    items.push({
      label: 'Use Workspace Version',
      description: workspaceZig.version.raw,
      action: 'workspace',
    })
  }

  const zigInPath = zigProvider.resolveZigPathConfigOption('zig')
  if (zigInPath) {
    items.push({ label: 'Use Zig in PATH', description: `${zigInPath.exe} ${zigInPath.version.raw}`, action: 'path' })
  }

  items.push({ label: 'Manually Specify Path', action: 'manual' })

  for (const item of versions) {
    const useName = item.isMach || item.version.prerelease.length !== 0
    items.push({
      label: useName ? (item.name ?? item.version.raw) : item.version.raw,
      description: item.offline ? 'already installed' : undefined,
      version: item.version,
    })
  }

  const selection = await coc.window.showQuickPick<VersionQuickPickItem>(items, {
    title: 'Select Zig version to install',
    placeHolder: placeholderVersion?.raw,
    canPickMany: false,
    matchOnDescription: true,
  })
  if (!selection) return

  switch (selection.action) {
    case 'workspace':
      await installZig(context)
      break
    case 'path':
      await updateConfiguration(getConfiguration(), 'path', 'zig')
      break
    case 'manual': {
      const input = await coc.window.requestInput('Path to the Zig executable')
      if (!input) return
      await zigProvider.setAndSave(input)
      break
    }
    default: {
      if (!selection.version) return
      await showUpdateWorkspaceVersionDialog(selection.version, workspaceZig?.source)
      await installZig(context, selection.version)
    }
  }
}

async function showUpdateWorkspaceVersionDialog(
  version: semver.SemVer,
  source?: WantedZigVersionSource,
): Promise<void> {
  const workspace = getWorkspaceFolderPath()

  if (workspace) {
    let buttonName: string
    switch (source) {
      case WantedZigVersionSource.workspaceZigVersionFile:
        buttonName = 'update .zigversion'
        break
      case WantedZigVersionSource.workspaceBuildZigZon:
        buttonName = 'update build.zig.zon'
        break
      case WantedZigVersionSource.zigVersionConfigOption:
        buttonName = 'update workspace settings'
        break
      default:
        buttonName = 'create .zigversion'
    }

    const response = await coc.window.showInformationMessage(
      `Would you like to save Zig ${version.toString()} in this workspace?`,
      buttonName,
    )
    if (!response) return
  }

  source ??= workspace ? WantedZigVersionSource.workspaceZigVersionFile : WantedZigVersionSource.zigVersionConfigOption

  switch (source) {
    case WantedZigVersionSource.workspaceZigVersionFile: {
      if (!workspace) return
      await fs.promises.writeFile(path.join(workspace, '.zigversion'), version.raw)
      break
    }
    case WantedZigVersionSource.workspaceBuildZigZon: {
      const metadata = await parseBuildZigZon()
      if (!metadata) return
      const content = await fs.promises.readFile(metadata.manifestPath, 'utf8')
      await fs.promises.writeFile(
        metadata.manifestPath,
        content.slice(0, metadata.minimumZigVersionStart)
        + version.raw
        + content.slice(metadata.minimumZigVersionEnd),
      )
      break
    }
    case WantedZigVersionSource.zigVersionConfigOption:
      await updateConfiguration(getConfiguration(), 'version', version.raw, !workspace)
      break
  }
}

const updateStatusItem = (version: semver.SemVer | null): void => {
  statusItem.text = version ? `Zig ${version.toString()}` : 'Zig: not installed'
}

const updateStatus = async (): Promise<void> => {
  const zigVersion = zigProvider.getZigVersion()
  const zigPath = zigProvider.getZigPath()

  updateStatusItem(zigVersion)

  if (!zigVersion || !zigPath) return

  const metadata = await parseBuildZigZon()
  if (!metadata) return
  if (semver.gte(zigVersion, metadata.minimumZigVersion)) return

  void coc.window
    .showWarningMessage(
      `Your Zig version '${zigVersion.toString()}' does not satisfy the minimum Zig version '${metadata.minimumZigVersion.toString()}' of your project.`,
      'update Zig',
      'open build.zig.zon',
    )
    .then(async (response) => {
      switch (response) {
        case 'update Zig':
          await installZig(context)
          break
        case 'open build.zig.zon': {
          const document = await coc.workspace.openTextDocument(coc.Uri.file(metadata.manifestPath))
          const position = document.textDocument.positionAt(metadata.minimumZigVersionStart)
          await coc.workspace.jumpTo(document.uri, position)
          break
        }
      }
    })
}

export const setupZig = async (extensionContext: coc.ExtensionContext): Promise<void> => {
  context = extensionContext

  versionManagerConfig = {
    context,
    title: 'Zig',
    exeName: 'zig',
    extraTarArgs: ['--strip-components=1'],
    /** https://ziglang.org/download */
    minisignKey: minisign.parseKey('RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U'),
    versionArg: 'version',
    getMirrorUrls: () => getMirrors(context),
    getCanonicalUrl: version =>
      version.prerelease.length === 0
        ? `https://ziglang.org/download/${version.raw}/`
        : 'https://ziglang.org/builds/',
    getArtifactName(version) {
      const fileExtension = process.platform === 'win32' ? 'zip' : 'tar.xz'
      if (
        (version.prerelease.length === 0 && semver.gte(version, '0.14.1'))
        || semver.gte(version, '0.15.0-dev.631+9a3540d61')
      ) {
        return `zig-${getZigArchNameForVersion(version)}-${getZigOSName()}-${version.raw}.${fileExtension}`
      }
      return `zig-${getZigOSName()}-${getZigArchNameForVersion(version)}-${version.raw}.${fileExtension}`
    },
  }

  statusItem = coc.window.createStatusBarItem(1)
  updateStatusItem(null)

  const refreshZigInstallation = asyncDebounce(async () => {
    if (!getOptionalString('path')) {
      await installZig(context)
    } else {
      await updateStatus()
    }
  }, 200)

  const updateStatusVisibility = (editor: coc.TextEditor | undefined): void => {
    if (editor?.document.languageId === 'zig') {
      statusItem.show()
    } else {
      statusItem.hide()
    }
  }
  updateStatusVisibility(coc.window.activeTextEditor)

  const watcher1 = coc.workspace.createFileSystemWatcher('**/.zigversion')
  const watcher2 = coc.workspace.createFileSystemWatcher('**/build.zig.zon')

  context.subscriptions.push(
    coc.window.onDidChangeActiveTextEditor(updateStatusVisibility),
    watcher1,
    watcher2,
    watcher1.onDidCreate(() => void refreshZigInstallation()),
    watcher1.onDidChange(() => void refreshZigInstallation()),
    watcher1.onDidDelete(() => void refreshZigInstallation()),
    watcher2.onDidCreate(() => void refreshZigInstallation()),
    watcher2.onDidChange(() => void refreshZigInstallation()),
    watcher2.onDidDelete(() => void refreshZigInstallation()),
    coc.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration('zig.version')) {
        void refreshZigInstallation()
      }
      if (change.affectsConfiguration('zig.path')) {
        const result = zigProvider.resolveZigPathConfigOption()
        if (result === undefined) return
        if (result !== null) zigProvider.set(result)
        void refreshZigInstallation()
      }
    }),
    coc.commands.registerCommand('zig.install', async () => {
      await selectVersionAndInstall(context)
    }),
    zigProvider.onChange.event(() => {
      void updateStatus()
    }),
  )

  if (!getOptionalString('path')) {
    await installZig(context)
  }
  await updateStatus()
}
