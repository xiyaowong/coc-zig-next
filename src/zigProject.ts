import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import * as coc from 'coc.nvim'
import { errorMessage } from './util'
import { zigProvider } from './zigSetup'

const execFileAsync = promisify(execFile)

type InitTemplate = 'default' | 'minimal'

interface InitTemplateItem extends coc.QuickPickItem {
  template: InitTemplate
}

const initTemplates: InitTemplateItem[] = [
  {
    label: 'Default',
    description: 'Recommended for most projects: an executable, a library and tests.',
    template: 'default',
  },
  {
    label: 'Minimal',
    description: 'Bare minimum project with only the essential files.',
    template: 'minimal',
  },
]

const expandHome = (input: string): string =>
  input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input

export const createZigProject = async (): Promise<void> => {
  const selection = await coc.window.showQuickPick<InitTemplateItem>(initTemplates, {
    title: 'Create Zig project',
    placeHolder: 'Choose a template',
    canPickMany: false,
  })
  if (!selection) return

  const zigPath = zigProvider.getZigPath()
  if (!zigPath) {
    coc.window.showErrorMessage('Cannot create a Zig project because Zig is not installed.')
    return
  }

  const input = await coc.window.requestInput('Directory for the Zig project')
  if (!input?.trim()) return

  const projectPath = path.resolve(expandHome(input.trim()))
  const projectName = path.basename(projectPath)

  try {
    await fs.promises.mkdir(projectPath, { recursive: true })
  } catch (error) {
    coc.window.showErrorMessage(`Failed to create '${projectPath}': ${errorMessage(error)}`)
    return
  }

  const entries = await fs.promises.readdir(projectPath)
  if (entries.length > 0) {
    coc.window.showErrorMessage(`Cannot create Zig project: '${projectPath}' is not empty.`)
    return
  }

  try {
    await coc.window.withProgress(
      { title: `Creating Zig project '${projectName}'...`, cancellable: false },
      async () => {
        const args = selection.template === 'minimal' ? ['init', '--minimal'] : ['init']
        await execFileAsync(zigPath, args, { cwd: projectPath })
      },
    )
  } catch (error) {
    coc.window.showErrorMessage(`Failed to create Zig project '${projectName}': ${errorMessage(error)}`)
    return
  }

  await coc.workspace.nvim.call('chdir', [projectPath]).catch(() => undefined)
  coc.window.showInformationMessage(`Created Zig project at ${projectPath}`)
}
