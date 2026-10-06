import { spawn } from 'node:child_process'
import * as coc from 'coc.nvim'
import { getConfiguration } from './util'
import { zigProvider } from './zigSetup'
import { getClient } from './zls'

const ZIG_MODE: coc.DocumentSelector = ['zig']
const FORMAT_TIMEOUT = 60_000
const MAX_BUFFER = 10 * 1024 * 1024

/** Run `zig fmt --stdin` on the given input and return the formatted source. */
const runZigFmt = (zigPath: string, input: string, token: coc.CancellationToken): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(zigPath, ['fmt', '--stdin'], { windowsHide: true })
    const timeout = setTimeout(() => child.kill(), FORMAT_TIMEOUT)
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to run 'zig fmt': ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || `zig fmt exited with code ${code}`))
    })

    token.onCancellationRequested(() => {
      clearTimeout(timeout)
      child.kill()
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })

const formattingProvider = (): string => getConfiguration().get<string>('formattingProvider', 'zls')

/** Ensure that `zig fmt` has been JIT compiled. */
const preCompileZigFmt = (): void => {
  if (formattingProvider() === 'off') return

  const zigPath = zigProvider.getZigPath()
  if (!zigPath) return

  const child = spawn(zigPath, ['fmt', '--help'], { windowsHide: true })
  child.on('error', () => undefined)
  child.stdout.resume()
  child.stderr.resume()
}

const provideDocumentRangeFormattingEdits = async (
  document: coc.LinesTextDocument,
  _range: coc.Range,
  options: coc.FormattingOptions,
  token: coc.CancellationToken,
): Promise<coc.TextEdit[] | null> => {
  if (formattingProvider() === 'zls') {
    const client = getClient()
    if (client && client.isRunning()) {
      return await client.sendRequest<coc.TextEdit[]>('textDocument/formatting', {
        textDocument: { uri: document.uri },
        options,
      }, token)
    }
  }

  const zigPath = zigProvider.getZigPath()
  if (!zigPath) return null

  const stdout = await runZigFmt(zigPath, document.getText(), token)
  if (stdout.length === 0 || stdout.length > MAX_BUFFER) return null

  const lastLine = document.lineCount - 1
  const wholeDocument = coc.Range.create(0, 0, lastLine, document.lineAt(lastLine).text.length)
  return [coc.TextEdit.replace(wholeDocument, stdout)]
}

export const registerDocumentFormatting = (): coc.Disposable => {
  const disposables: coc.Disposable[] = []
  let registered: coc.Disposable | null = null

  const onFormattingProviderChange = (): void => {
    preCompileZigFmt()

    if (formattingProvider() === 'off') {
      registered?.dispose()
      registered = null
    } else {
      registered ??= coc.languages.registerDocumentRangeFormatProvider(ZIG_MODE, {
        provideDocumentRangeFormattingEdits,
      })
    }
  }

  onFormattingProviderChange()

  coc.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration('zig.formattingProvider')) {
      onFormattingProviderChange()
    }
  }, undefined, disposables)

  zigProvider.onChange.event(() => preCompileZigFmt(), undefined, disposables)

  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose()
      }
      registered?.dispose()
      registered = null
    },
  }
}
