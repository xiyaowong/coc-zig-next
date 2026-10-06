import { spawn } from 'node:child_process'
import path from 'node:path'
import * as coc from 'coc.nvim'
import semver from 'semver'
import { zigProvider } from './zigSetup'
import { getClient } from './zls'

const AST_CHECK_ZON_SUPPORT = new semver.SemVer('0.14.0-dev.2508+7e8be2136')
const THROTTLE_MS = 16
const AST_CHECK_TIMEOUT = 5000

const throttle = <T extends unknown[]>(func: (...args: T) => void, wait: number): ((...args: T) => void) => {
  let timer: NodeJS.Timeout | undefined
  let pending: T | undefined

  return (...args: T) => {
    pending = args
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const current = pending
      pending = undefined
      if (current) func(...current)
    }, wait)
  }
}

const runAstCheck = (zigPath: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve) => {
    const child = spawn(zigPath, args, { windowsHide: true })
    const timeout = setTimeout(() => child.kill(), AST_CHECK_TIMEOUT)
    let stderr = ''

    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })

    const finish = (value: string): void => {
      clearTimeout(timeout)
      resolve(value)
    }

    child.on('error', () => finish(''))
    child.on('close', () => finish(stderr))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })

const collectAstCheckDiagnostics = async (
  collection: coc.DiagnosticCollection,
  document: coc.LinesTextDocument,
): Promise<void> => {
  const zigPath = zigProvider.getZigPath()
  const zigVersion = zigProvider.getZigVersion()
  if (!zigPath || !zigVersion) return

  const args = ['ast-check']
  if (path.extname(document.uri) === '.zon' && semver.gte(zigVersion, AST_CHECK_ZON_SUPPORT)) {
    args.push('--zon')
  }

  const stderr = await runAstCheck(zigPath, args, document.getText())
  if (stderr.length === 0) {
    collection.delete(document.uri)
    return
  }

  const diagnostics: coc.Diagnostic[] = []
  const regex = /(\S.*):(\d*):(\d*): ([^:]*): (.*)/g

  for (let match = regex.exec(stderr); match; match = regex.exec(stderr)) {
    const line = Math.min(Math.max(Number.parseInt(match[2], 10) - 1, 0), document.lineCount - 1)
    const column = Math.max(Number.parseInt(match[3], 10) - 1, 0)
    const type = match[4].trim().toLowerCase()
    const message = match[5]

    const severity = type === 'error' ? coc.DiagnosticSeverity.Error : coc.DiagnosticSeverity.Information
    const range = coc.Range.create(line, column, line, document.lineAt(line).text.length)
    diagnostics.push(coc.Diagnostic.create(range, message, severity, undefined, 'zig'))
  }

  if (diagnostics.length === 0) {
    collection.delete(document.uri)
    return
  }

  collection.set(document.uri, diagnostics)
}

export const registerDiagnosticsProvider = (): coc.Disposable => {
  const disposables: coc.Disposable[] = []
  const diagnosticCollection = coc.languages.createDiagnosticCollection('zig')
  disposables.push(diagnosticCollection)

  const throttledCollect = throttle(
    (document: coc.LinesTextDocument) => void collectAstCheckDiagnostics(diagnosticCollection, document),
    THROTTLE_MS,
  )

  coc.workspace.onDidChangeTextDocument((change) => {
    if (change.document.languageId !== 'zig') return

    if (getClient()) {
      diagnosticCollection.clear()
      return
    }

    throttledCollect(change.document)
  }, undefined, disposables)

  coc.workspace.onDidCloseTextDocument((document) => {
    if (document.languageId !== 'zig') return
    diagnosticCollection.delete(document.uri)
  }, undefined, disposables)

  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose()
      }
    },
  }
}
