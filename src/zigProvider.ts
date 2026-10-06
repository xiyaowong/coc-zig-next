import type semver from 'semver'
import * as coc from 'coc.nvim'
import { getConfiguration, resolveExePathAndVersion, updateConfiguration } from './util'

export interface ExeWithVersion {
  exe: string
  version: semver.SemVer
}

export class ZigProvider {
  onChange = new coc.Emitter<ExeWithVersion | null>()
  private value: ExeWithVersion | null

  constructor() {
    this.value = this.resolveZigPathConfigOption() ?? null
  }

  /** Returns the version of the Zig executable that is currently being used. */
  getZigVersion(): semver.SemVer | null {
    return this.value?.version ?? null
  }

  /** Returns the path to the Zig executable that is currently being used. */
  getZigPath(): string | null {
    return this.value?.exe ?? null
  }

  /** Set the Zig executable. The `zig.path` config option is ignored. */
  set(value: ExeWithVersion | null): void {
    if (value === null && this.value === null) return
    if (value !== null && this.value !== null && value.version.compare(this.value.version) === 0) return
    this.value = value
    this.onChange.fire(value)
  }

  /** Set the Zig executable and save it in the `zig.path` config option. */
  async setAndSave(zigPath: string | null): Promise<void> {
    if (!zigPath) {
      await updateConfiguration(getConfiguration(), 'path', undefined)
      return
    }

    const resolved = this.resolveZigPathConfigOption(zigPath)
    if (!resolved) return

    await updateConfiguration(getConfiguration(), 'path', resolved.exe)
    this.set(resolved)
  }

  /** Resolves the `zig.path` config option. */
  resolveZigPathConfigOption(zigPath?: string): ExeWithVersion | null | undefined {
    zigPath ??= getConfiguration().get<string>('path', '')
    if (!zigPath) return null

    const result = resolveExePathAndVersion(zigPath, 'version')
    if ('message' in result) {
      void coc.window
        .showErrorMessage(`Unexpected 'zig.path': ${result.message}`, 'install Zig', 'open settings')
        .then(async (response) => {
          switch (response) {
            case 'install Zig':
              await updateConfiguration(getConfiguration(), 'path', undefined)
              break
            case 'open settings':
              await coc.commands.executeCommand('workbench.action.openSettingsJson')
              break
          }
        })
      return undefined
    }

    return result
  }
}
