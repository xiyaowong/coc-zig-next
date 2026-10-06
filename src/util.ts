import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import * as coc from 'coc.nvim'
import semver from 'semver'
import which from 'which'

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.promises.stat(filePath)
    return true
  } catch {
    return false
  }
}

export const ensureDirectory = async (directory: string): Promise<void> => {
  await fs.promises.mkdir(directory, { recursive: true })
}

export const executableName = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** The user agent sent with every network request. */
export const USER_AGENT = 'coc-zig-next'

export const getConfiguration = (section = 'zig'): coc.WorkspaceConfiguration => coc.workspace.getConfiguration(section)

export const getOptionalString = (key: string, section?: string): string | undefined => {
  const value = getConfiguration(section).get<string | null>(key)
  const trimmed = value?.trim()
  return trimmed || undefined
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const getZigArchName = (armName: string): string => {
  switch (process.arch) {
    case 'ia32':
      return 'x86'
    case 'x64':
      return 'x86_64'
    case 'arm':
      return armName
    case 'arm64':
      return 'aarch64'
    case 'ppc':
      return 'powerpc'
    case 'ppc64':
      return 'powerpc64le'
    case 'loong64':
      return 'loongarch64'
    default:
      return process.arch
  }
}

export const getZigOSName = (): string => {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return process.platform
  }
}

const isFileUri = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value)

export const uriToPath = (uri: string): string => (isFileUri(uri) ? coc.Uri.parse(uri).fsPath : uri)

export const getWorkspaceFolderPath = (filePath?: string): string | undefined => {
  if (filePath) {
    const folder = coc.workspace.getWorkspaceFolder(coc.Uri.file(filePath))
    if (folder) return uriToPath(folder.uri)
  }
  return coc.workspace.folderPaths.find(p => path.isAbsolute(p)) ?? coc.workspace.folderPaths[0]
}

const activeDocument = (): coc.Document | undefined => coc.workspace.getDocument(coc.workspace.bufnr) ?? undefined

const CONFIG_VARIABLE = /\$\{([^}]+)\}/g

// Replace the predefined variables in a config value.
// https://code.visualstudio.com/docs/editor/variables-reference#_predefined-variables
export const handleConfigOption = (input: string, workspaceFolder: string | 'none' | 'guess'): string => {
  if (workspaceFolder === 'guess') {
    workspaceFolder = getWorkspaceFolderPath() ?? 'none'
  }

  const document = activeDocument()
  const fileName = document ? uriToPath(document.uri) : undefined
  const hasWorkspaceFolder = workspaceFolder !== 'none'

  const variables: Record<string, string | undefined> = {
    'userHome': os.homedir(),
    'workspaceFolder': hasWorkspaceFolder ? workspaceFolder : undefined,
    'workspaceFolderBasename': hasWorkspaceFolder ? path.basename(workspaceFolder) : undefined,
    'file': fileName,
    'fileBasename': fileName && path.basename(fileName),
    'fileBasenameNoExtension': fileName && path.basename(fileName, path.extname(fileName)),
    'fileExtname': fileName && path.extname(fileName),
    'fileDirname': fileName && path.dirname(fileName),
    'fileDirnameBasename': fileName && path.basename(path.dirname(fileName)),
    'pathSeparator': path.sep,
    '/': path.sep,
    'cwd': coc.workspace.cwd,
  }

  return input.replace(CONFIG_VARIABLE, (match, name: string) =>
    name.startsWith('env:') ? process.env[name.slice('env:'.length)] ?? '' : variables[name] ?? match)
}

/** Resolves the absolute executable path and version of a program like zig or zls. */
export const resolveExePathAndVersion = (
  cmd: string,
  versionArg: string,
): { exe: string, version: semver.SemVer } | { message: string } => {
  if (cmd.length === 0) return { message: 'the path is empty' }

  cmd = handleConfigOption(cmd, 'guess')

  if (cmd.startsWith('~')) {
    cmd = path.join(os.homedir(), cmd.substring(1))
  }

  const isWindows = os.platform() === 'win32'
  const isAbsolute = path.isAbsolute(cmd)
  const hasPathSeparator = cmd.includes('/') || (isWindows && cmd.includes('\\'))
  if (!isAbsolute && hasPathSeparator) {
    return {
      message: `'${cmd}' is not valid. Use '\${workspaceFolder}' to specify a path relative to the current workspace folder and '~' for the home directory.`,
    }
  }

  const exePath = which.sync(cmd, { nothrow: true })
  if (!exePath) {
    if (!isAbsolute) return { message: `Could not find '${cmd}' in PATH.` }

    const stats = fs.statSync(cmd, { throwIfNoEntry: false })
    if (!stats) return { message: `'${cmd}' does not exist.` }
    if (stats.isDirectory()) return { message: `'${cmd}' is a directory and not an executable.` }
    return { message: `'${cmd}' is not an executable.` }
  }

  const version = getVersion(exePath, versionArg)
  if (!version) return { message: `Failed to run '${exePath} ${versionArg}'.` }
  return { exe: exePath, version }
}

export function getVersion(filePath: string, versionArg: string): semver.SemVer | null {
  try {
    const output = execFileSync(filePath, [versionArg], { cwd: getWorkspaceFolderPath() })
    const versionString = output.toString('utf8').trim()
    if (versionString === '0.2.0.83a2a36a') {
      // Zig 0.2.0 reports the version in a non-semver format
      return semver.parse('0.2.0')
    }
    return semver.parse(versionString)
  } catch {
    return null
  }
}

export const snakeCase = (value: string): string =>
  value.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

export const camelCase = (value: string): string =>
  value.replace(/_([a-z\d])/g, (_, char: string) => char.toUpperCase())

/** Wrapper around `WorkspaceConfiguration.update` that does not throw. */
export const updateConfiguration = async (
  config: coc.WorkspaceConfiguration,
  section: string,
  value: unknown,
  global = true,
): Promise<void> => {
  try {
    await config.update(section, value, global)
  } catch (error) {
    coc.window.showErrorMessage(errorMessage(error))
  }
}

export const asyncDebounce = <T extends unknown[]>(
  func: (...args: T) => Promise<void>,
  wait = 0,
): (...args: T) => Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  return (...args: T): Promise<void> =>
    new Promise((resolve, reject) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        func(...args).then(resolve, reject)
      }, wait)
    })
}
