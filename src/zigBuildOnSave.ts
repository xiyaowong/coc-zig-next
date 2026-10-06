import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import * as coc from 'coc.nvim'
import { handleConfigOption, uriToPath } from './util'
import { zigProvider } from './zigSetup'

const OUTPUT_CHANNEL_NAME = 'Zig Watch'

class BuildOnSaveProvider implements coc.Disposable {
  private disposables: coc.Disposable[] = []
  private processes = new Map<string, ChildProcess>()
  private outputChannel = coc.window.createOutputChannel(OUTPUT_CHANNEL_NAME)

  constructor() {
    for (const folder of coc.workspace.folderPaths) {
      this.addOrRestart(folder)
    }

    coc.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) {
        this.addOrRestart(uriToPath(folder.uri))
      }
      for (const folder of event.removed) {
        this.stop(uriToPath(folder.uri))
      }
    }, undefined, this.disposables)

    coc.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('zig.buildOnSaveProvider')
        && !event.affectsConfiguration('zig.buildOnSaveArgs')
      ) {
        return
      }
      for (const folder of coc.workspace.folderPaths) {
        this.addOrRestart(folder)
      }
    }, undefined, this.disposables)
  }

  private addOrRestart(folder: string): void {
    this.stop(folder)

    const configuration = coc.workspace.getConfiguration('zig')
    const provider = configuration.get<string>('buildOnSaveProvider', 'auto')
    const args = configuration.get<string[]>('buildOnSaveArgs', []).map(arg => handleConfigOption(arg, folder))

    if (provider !== 'extension') return

    if (!args.includes('--build-file') && !fs.existsSync(path.join(folder, 'build.zig'))) {
      return
    }

    const child = spawn(zigProvider.getZigPath() ?? 'zig', ['build', '--watch', ...args], {
      cwd: folder,
      windowsHide: true,
    })

    const append = (chunk: string): void => this.outputChannel.append(chunk)
    child.stdout?.setEncoding('utf8').on('data', append)
    child.stderr?.setEncoding('utf8').on('data', append)
    child.on('error', (error) => {
      this.outputChannel.appendLine(`Failed to run 'zig build --watch': ${error.message}`)
    })
    child.on('exit', (code) => {
      this.outputChannel.appendLine(`'zig build --watch' exited with code ${code}`)
    })

    this.processes.set(folder, child)
  }

  private stop(folder: string): void {
    const child = this.processes.get(folder)
    if (child) child.kill()
    this.processes.delete(folder)
  }

  dispose(): void {
    for (const folder of [...this.processes.keys()]) {
      this.stop(folder)
    }
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.outputChannel.dispose()
  }
}

export const registerBuildOnSaveProvider = (): coc.Disposable => new BuildOnSaveProvider()
