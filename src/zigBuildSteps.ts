import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import * as coc from 'coc.nvim'
import { errorMessage } from './util'
import { zigProvider } from './zigSetup'

const execFileAsync = promisify(execFile)

interface ZigBuildStep {
  name: string
  description: string
  isDefault: boolean
}

interface ZigBuildStepQuickPickItem extends coc.QuickPickItem {
  step: ZigBuildStep
}

export const registerBuildStepsCommand = (context: coc.ExtensionContext): void => {
  context.subscriptions.push(coc.commands.registerCommand('zig.buildStep', () => void runBuildStep()))
}

async function runBuildStep(): Promise<void> {
  const zigPath = zigProvider.getZigPath()
  if (!zigPath) {
    coc.window.showErrorMessage('Cannot run Zig build steps because Zig is not installed.')
    return
  }

  const workspaceFolder = await pickWorkspaceFolder()
  if (!workspaceFolder) return

  let steps: ZigBuildStep[]
  try {
    steps = await coc.window.withProgress(
      { title: 'Loading Zig build steps...', cancellable: false },
      () => getBuildSteps(zigPath, workspaceFolder),
    )
  } catch (error) {
    coc.window.showErrorMessage(errorMessage(error))
    return
  }

  if (steps.length === 0) {
    coc.window.showInformationMessage('No Zig build steps were found.')
    return
  }

  const items: ZigBuildStepQuickPickItem[] = steps.map(step => ({
    label: step.isDefault ? `* ${step.name}` : step.name,
    description: step.isDefault ? 'default' : step.description || undefined,
    step,
  }))

  const pick = await coc.window.showQuickPick<ZigBuildStepQuickPickItem>(items, {
    title: 'Select a Zig build step to run',
    matchOnDescription: true,
    canPickMany: false,
  })
  if (!pick) return

  await coc.window.runTerminalCommand(
    `${quoteShellArg(zigPath)} build ${quoteShellArg(pick.step.name)}`,
    workspaceFolder,
  )
}

async function pickWorkspaceFolder(): Promise<string | undefined> {
  const folders = coc.workspace.folderPaths
  if (folders.length === 0) return undefined

  const activeFile = coc.window.activeTextEditor?.document.uri
  if (activeFile) {
    const folder = folders.find((candidate) => {
      const parsed = activeFile.startsWith('file://') ? coc.Uri.parse(activeFile).fsPath : activeFile
      return path.relative(candidate, parsed).startsWith('..') === false
    })
    if (folder && hasBuildFile(folder)) return folder
  }

  const candidates = folders.filter(hasBuildFile)
  if (candidates.length === 0) {
    coc.window.showErrorMessage('No \'build.zig\' file was found in the workspace.')
    return undefined
  }
  if (candidates.length === 1) return candidates[0]

  return await coc.window.showQuickPick(candidates, {
    title: 'Select the workspace folder to build',
    canPickMany: false,
  })
}

function hasBuildFile(folder: string): boolean {
  return fs.existsSync(path.join(folder, 'build.zig'))
}

function quoteShellArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

async function getBuildSteps(zigPath: string, cwd: string): Promise<ZigBuildStep[]> {
  const { stdout } = await execFileAsync(zigPath, ['build', '--list-steps'], { cwd })

  const steps: ZigBuildStep[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    steps.push(parseStepLine(line))
  }

  // The default step should be the first pick
  steps.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return steps
}

const DEFAULT_SUFFIX = ' (default)'

/**
 * Parses a line of `zig build --list-steps` output, e.g.:
 * - `  install (default)            Copy build artifacts to prefix path`
 * - `  spaced step (default)        Spaced step description`
 *
 * Step names may contain single spaces, so the name/description boundary is the first run of 2+ spaces.
 */
function parseStepLine(line: string): ZigBuildStep {
  const trimmed = line.replace(/^\s+/, '')
  const columnGap = /\s{2,}/.exec(trimmed)
  const namePart = columnGap ? trimmed.slice(0, columnGap.index) : trimmed
  const description = columnGap ? trimmed.slice(columnGap.index + columnGap[0].length).trim() : ''

  const isDefault = namePart.endsWith(DEFAULT_SUFFIX)
  return {
    name: (isDefault ? namePart.slice(0, -DEFAULT_SUFFIX.length) : namePart).trim(),
    description,
    isDefault,
  }
}
