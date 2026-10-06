import process from 'node:process'
import * as coc from 'coc.nvim'
import semver from 'semver'
import * as github from './github'
import * as minisign from './minisign'
import {
  camelCase,
  errorMessage,
  getWorkspaceFolderPath,
  getZigArchName,
  getZigOSName,
  handleConfigOption,
  resolveExePathAndVersion,
  snakeCase,
  updateConfiguration,
} from './util'
import * as versionManager from './versionManager'
import { zigProvider } from './zigSetup'

const ZIG_MODE: coc.DocumentSelector = ['zig']
const OUTPUT_CHANNEL_NAME = 'ZLS language server'
const SELECT_VERSION_URL = 'https://releases.zigtools.org/v1/zls/select-version'
const ZLS_REPOSITORY = 'zigtools/zls'

let client: coc.LanguageClient | null = null
let registration: coc.Disposable | undefined
let statusItem: coc.StatusBarItem
let versionManagerConfig: versionManager.Config

export const getClient = (): coc.LanguageClient | null => client

interface SelectVersionResponse {
  /** The ZLS version */
  version: string
  /** `YYYY-MM-DD` */
  date: string
  [artifact: string]: unknown
}

interface SelectVersionFailureResponse {
  code?: number
  /** A simplified explanation of why no ZLS build could be selected. */
  message?: string
  /** Set instead of `message` when the query was rejected, e.g. for an unknown Zig version. */
  error?: string
  version?: undefined
}

const configurationMiddleware = (params: coc.ConfigurationParams): unknown[] => {
  return params.items.map((param) => {
    if (!param.section) return null

    const configuration = coc.workspace.getConfiguration('zig', param.scopeUri)
    const workspaceFolder = getWorkspaceFolderPath() ?? 'none'

    const updateConfigOption = (section: string, value: unknown): unknown => {
      if (section === 'zls.zigExePath') {
        return zigProvider.getZigPath()
      } else if (section === 'zls.zigLibPath') {
        value = configuration.get('libPath')
      }

      if (typeof value === 'string') {
        // Make sure that `""` gets converted to `undefined` and resolve predefined values
        value = value ? handleConfigOption(value, workspaceFolder) : undefined
      } else if (Array.isArray(value)) {
        value = value.map((element: unknown) =>
          typeof element === 'string' ? handleConfigOption(element, workspaceFolder) : element,
        )
      } else if (typeof value === 'object' && value !== null) {
        const newValue: Record<string, unknown> = {}
        for (const [fieldName, fieldValue] of Object.entries(value)) {
          newValue[snakeCase(fieldName)] = updateConfigOption(`${section}.${fieldName}`, fieldValue)
        }
        return newValue
      }

      const inspect = configuration.inspect(section)
      const isDefaultValue
        = value === inspect?.defaultValue
          && inspect?.globalValue === undefined
          && inspect?.workspaceValue === undefined
          && inspect?.workspaceFolderValue === undefined

      if (isDefaultValue) {
        // The extension has a different default value for this config option compared to ZLS
        if (section === 'zls.semanticTokens') return value
        return undefined
      }
      return value
    }

    const additionalOptions = Object.fromEntries(
      Object.entries(configuration.get<Record<string, unknown>>('zls.additionalOptions', {}))
        .filter(([key]) => key.startsWith('zig.zls.'))
        .map(([key, value]) => [key.slice('zig.zls.'.length), value]),
    )

    switch (configuration.get<string>('buildOnSaveProvider', 'auto')) {
      case 'auto':
        additionalOptions.buildOnSaveArgs = configuration.get('buildOnSaveArgs')
        break
      case 'zls':
        additionalOptions.enableBuildOnSave = true
        additionalOptions.buildOnSaveArgs = configuration.get('buildOnSaveArgs')
        break
      case 'off':
      case 'extension':
        additionalOptions.enableBuildOnSave = false
        break
    }

    if (param.section === 'zls') {
      // ZLS has requested all config options.

      const options = { ...configuration.get<Record<string, unknown>>('zls', {}) }
      // Some config options are specific to the extension. ZLS ignores unknown values.
      delete options.debugLog
      delete options.trace
      delete options.enabled
      delete options.path
      delete options.additionalOptions

      return updateConfigOption('zls', {
        ...additionalOptions,
        ...options,
        zig_exe_path: zigProvider.getZigPath(),
        zig_lib_path: configuration.get('libPath') ?? undefined,
      })
    } else if (param.section.startsWith('zls.')) {
      // ZLS names its config options in snake_case while the extension uses camelCase
      const camelCaseSection = param.section.split('.').map(camelCase).join('.')

      return updateConfigOption(
        camelCaseSection,
        configuration.get(camelCaseSection, additionalOptions[camelCaseSection.slice('zls.'.length)]),
      )
    }

    // Do not allow ZLS to request other editor config options.
    return null
  })
}

const applyTrace = (languageClient: coc.LanguageClient): void => {
  switch (coc.workspace.getConfiguration('zig.zls').get<string>('trace.server', 'off')) {
    case 'messages':
      languageClient.trace = coc.Trace.Messages
      break
    case 'verbose':
      languageClient.trace = coc.Trace.Verbose
      break
    default:
      languageClient.trace = coc.Trace.Off
  }
}

const startClient = async (zlsPath: string): Promise<coc.LanguageClient> => {
  const clientOptions: coc.LanguageClientOptions = {
    documentSelector: ZIG_MODE,
    outputChannelName: OUTPUT_CHANNEL_NAME,
    middleware: { workspace: { configuration: configurationMiddleware } },
    // Formatting is handled by `zigFormat.ts`
    disabledFeatures: ['documentFormatting', 'documentRangeFormatting', 'documentOnTypeFormatting'],
  }

  const languageClient = new coc.LanguageClient(
    'zig.zls',
    'ZLS language server',
    { command: zlsPath },
    clientOptions,
  )

  applyTrace(languageClient)
  registration = coc.services.registerLanguageClient(languageClient)
  await coc.services.getService(languageClient.id)?.start()

  return languageClient
}

const stopClient = async (): Promise<void> => {
  if (!client) return

  const oldClient = client
  client = null

  registration?.dispose()
  registration = undefined

  if (oldClient.needsStop()) {
    await oldClient.stop().catch(() => undefined)
  }
  await oldClient.dispose().catch(() => undefined)
}

const updateStatusItem = (version: semver.SemVer | null): void => {
  statusItem.text = version ? `ZLS ${version.toString()}` : 'ZLS: off'
}

export const restartClient = async (context: coc.ExtensionContext): Promise<void> => {
  try {
    const result = await getZLSPath(context)

    if (!result) {
      await stopClient()
      updateStatusItem(null)
      return
    }

    await stopClient()
    client = await startClient(result.exe)
    updateStatusItem(result.version)
  } catch (reason) {
    coc.window.showWarningMessage(`Failed to run ZLS language server: ${errorMessage(reason)}`)
    updateStatusItem(null)
  }
}

/** Returns the file system path to the zls executable. */
async function getZLSPath(
  context: coc.ExtensionContext,
): Promise<{ exe: string, version: semver.SemVer } | null> {
  const configuration = coc.workspace.getConfiguration('zig.zls')
  const zlsExePath = configuration.get<string>('path')

  if (zlsExePath) {
    const result = resolveExePathAndVersion(zlsExePath, '--version')
    if ('message' in result) {
      void coc.window
        .showErrorMessage(`Unexpected 'zig.zls.path': ${result.message}`, 'install ZLS', 'open settings')
        .then(async (response) => {
          switch (response) {
            case 'install ZLS':
              await updateConfiguration(configuration, 'enabled', 'on')
              await updateConfiguration(configuration, 'path', undefined)
              break
            case 'open settings':
              await coc.commands.executeCommand('workbench.action.openSettingsJson')
              break
          }
        })
      return null
    }
    return result
  }

  if (configuration.get<string>('enabled', 'ask') !== 'on') return null

  const zigVersion = zigProvider.getZigVersion()
  if (!zigVersion) return null

  const version = await fetchVersion(context, zigVersion)
  if (!version) return null

  try {
    const exe = await versionManager.install(versionManagerConfig, version)
    return { exe, version }
  } catch (error) {
    coc.window.showErrorMessage(`Failed to install ZLS ${version.toString()}: ${errorMessage(error)}`)
    return null
  }
}

/** Returns the release asset of `version` matching this system, if the release has one. */
const findReleaseAsset = (release: github.Release, version: semver.SemVer): github.ReleaseAsset | null => {
  // Release assets are published without the version that the canonical artifact name contains.
  const assetName = versionManagerConfig.getArtifactName(version).replace(`-${version.raw}`, '')
  if (!release.assets.some(asset => asset.name === `${assetName}.minisig`)) return null
  return release.assets.find(asset => asset.name === assetName) ?? null
}

/** Returns the newest released ZLS version built for the same Zig release as `zigVersion`. */
const fetchReleasedVersion = async (zigVersion: semver.SemVer): Promise<semver.SemVer | null> => {
  // A nightly build of Zig is paired with a nightly build of ZLS, which is not published as a release.
  if (zigVersion.prerelease.length !== 0) return null

  const versions: semver.SemVer[] = []
  for (const release of await github.fetchReleases(ZLS_REPOSITORY)) {
    const version = semver.parse(release.tag_name)
    if (!version || version.major !== zigVersion.major || version.minor !== zigVersion.minor) continue
    if (!findReleaseAsset(release, version)) continue
    versions.push(version)
  }

  return versions.length === 0 ? null : semver.rsort(versions)[0]
}

/** Returns the URL of the release asset of `version` matching this system, if there is one. */
const fetchReleasedArtifactUrl = async (version: semver.SemVer): Promise<string | null> => {
  const release = (await github.fetchReleases(ZLS_REPOSITORY)).find(item => item.tag_name === version.raw)
  if (!release) return null
  return findReleaseAsset(release, version)?.browser_download_url ?? null
}

async function fetchVersion(
  context: coc.ExtensionContext,
  zigVersion: semver.SemVer,
): Promise<semver.SemVer | null> {
  const cacheKey = `zls-select-version-${zigVersion.raw}`

  let response: SelectVersionResponse | SelectVersionFailureResponse | null = null
  try {
    const url = new URL(SELECT_VERSION_URL)
    url.searchParams.append('zig_version', zigVersion.raw)
    url.searchParams.append('compatibility', 'only-runtime')

    response = (await coc.fetch(url.href, { timeout: 30_000 })) as SelectVersionResponse | SelectVersionFailureResponse
    await context.globalState.update(cacheKey, response)
  } catch (error) {
    response = context.globalState.get<SelectVersionResponse | SelectVersionFailureResponse>(cacheKey) ?? null
    if (!response) {
      // The query failed and there is no cached answer, fall back to the published releases.
      const released = await fetchReleasedVersion(zigVersion).catch(() => null)
      if (released) return released

      coc.window.showErrorMessage(`Failed to query ZLS version: ${errorMessage(error)}`)
      return null
    }
  }

  if (typeof response.version !== 'string') {
    const message = response.message ?? response.error ?? 'the response does not contain a version'
    coc.window.showErrorMessage(`Unable to fetch ZLS: ${message}`)
    return null
  }

  const version = new semver.SemVer(response.version)
  const armName = semver.gte(version, '0.15.0') ? 'arm' : 'armv7a'
  const targetName = `${getZigArchName(armName)}-${getZigOSName()}`

  if (!(targetName in response)) {
    coc.window.showErrorMessage(
      `A prebuilt ZLS ${response.version} binary is not available for your system. You can build it yourself with https://github.com/zigtools/zls#from-source`,
    )
    return null
  }

  return version
}

const isEnabled = async (): Promise<boolean> => {
  const zlsConfig = coc.workspace.getConfiguration('zig.zls')
  if (zlsConfig.get<string>('path')) return true

  switch (zlsConfig.get<string>('enabled', 'ask')) {
    case 'on':
      return true
    case 'off':
      return false
    default: {
      const response = await coc.window.showInformationMessage(
        'Enable the ZLS language server for a better editing experience?',
        'Yes',
        'No',
      )
      switch (response) {
        case 'Yes':
          await updateConfiguration(zlsConfig, 'enabled', 'on')
          return true
        case 'No':
          await updateConfiguration(zlsConfig, 'enabled', 'off')
          return false
        default:
          return false
      }
    }
  }
}

const notifyConfigurationChanged = async (): Promise<void> => {
  if (!client) return
  await client.sendNotification('workspace/didChangeConfiguration', { settings: null }).catch(() => undefined)
}

const updateStatusVisibility = (editor: coc.TextEditor | undefined): void => {
  if (editor?.document.languageId === 'zig') {
    statusItem.show()
  } else {
    statusItem.hide()
  }
}

export const activateZls = async (context: coc.ExtensionContext): Promise<void> => {
  versionManagerConfig = {
    context,
    title: 'ZLS',
    exeName: 'zls',
    extraTarArgs: [],
    /** https://github.com/zigtools/release-worker */
    minisignKey: minisign.parseKey('RWR+9B91GBZ0zOjh6Lr17+zKf5BoSuFvrx2xSeDE57uIYvnKBGmMjOex'),
    versionArg: '--version',
    getMirrorUrls: () => Promise.resolve([]),
    getCanonicalUrl: () => 'https://builds.zigtools.org/',
    getFallbackArtifactUrl: fetchReleasedArtifactUrl,
    getArtifactName(version) {
      const fileExtension = process.platform === 'win32' ? 'zip' : 'tar.xz'
      const targetName = semver.gte(version, '0.15.0')
        ? `${getZigArchName('arm')}-${getZigOSName()}`
        : `${getZigOSName()}-${getZigArchName('armv7a')}`
      return `zls-${targetName}-${version.raw}.${fileExtension}`
    },
  }

  statusItem = coc.window.createStatusBarItem(2)
  updateStatusItem(null)
  updateStatusVisibility(coc.window.activeTextEditor)

  context.subscriptions.push(
    statusItem,
    coc.window.onDidChangeActiveTextEditor(updateStatusVisibility),
    coc.commands.registerCommand('zig.zls.enable', async () => {
      await updateConfiguration(coc.workspace.getConfiguration('zig.zls'), 'enabled', 'on')
    }),
    coc.commands.registerCommand('zig.zls.stop', async () => {
      await stopClient()
      updateStatusItem(null)
    }),
    coc.commands.registerCommand('zig.zls.startRestart', async () => {
      await updateConfiguration(coc.workspace.getConfiguration('zig.zls'), 'enabled', 'on')
      await restartClient(context)
    }),
    zigProvider.onChange.event(() => {
      void restartClient(context)
    }),
    coc.workspace.onDidChangeConfiguration(async (change) => {
      if (change.affectsConfiguration('zig.zls.enabled') || change.affectsConfiguration('zig.zls.path')) {
        await restartClient(context)
        return
      }
      if (change.affectsConfiguration('zig.zls.trace.server') && client) {
        applyTrace(client)
      }
      if (change.affectsConfiguration('zig.zls')) {
        await notifyConfigurationChanged()
      }
    }),
  )

  if (await isEnabled()) {
    await restartClient(context)
  }
}

export const deactivateZls = async (): Promise<void> => {
  await stopClient()
}
