import * as coc from 'coc.nvim'

interface LineRange {
  document: coc.Document
  startLine: number
  endLine: number
}

/** The 0-based inclusive line range covered by the current (visual) selection. */
const getLineRange = async (): Promise<LineRange | undefined> => {
  const document = await coc.workspace.document
  if (!document || document.languageId !== 'zig') return undefined

  const nvim = coc.workspace.nvim
  const cursorLine = Number(await nvim.call('line', ['.'])) - 1

  let startLine = cursorLine
  let endLine = cursorLine

  const mode = String(await nvim.eval('mode()')).charAt(0)
  if (mode === 'v' || mode === 'V' || mode === '\u0016') {
    const visualStart = (await nvim.call('getpos', ['v'])) as number[]
    const visualEnd = (await nvim.call('getpos', ['.'])) as number[]
    startLine = Math.min(visualStart[1], visualEnd[1]) - 1
    endLine = Math.max(visualStart[1], visualEnd[1]) - 1
  }

  return { document, startLine, endLine }
}

export const toggleMultilineStringLiteral = async (): Promise<void> => {
  const selection = await getLineRange()
  if (!selection) return

  const { document, startLine, endLine } = selection
  const textDocument = document.textDocument
  const nonWhitespaceIndex = textDocument.lineAt(startLine).firstNonWhitespaceCharacterIndex

  let newText = ''
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const line = textDocument.lineAt(lineNumber)
    const indent = line.firstNonWhitespaceCharacterIndex
    const isMultilineStringLiteral = line.text.slice(indent).startsWith('\\\\')
    const breakpoint = Math.min(nonWhitespaceIndex, indent)

    const newLine = isMultilineStringLiteral
      ? line.text.slice(0, indent) + line.text.slice(indent).slice(2)
      : line.isEmptyOrWhitespace
        ? `${' '.repeat(nonWhitespaceIndex)}\\\\`
        : `${line.text.slice(0, breakpoint)}\\\\${line.text.slice(breakpoint)}`

    newText += newLine
    if (lineNumber < endLine) newText += '\n'
  }

  const range = coc.Range.create(startLine, 0, endLine, textDocument.lineAt(endLine).text.length)
  await document.applyEdits([coc.TextEdit.replace(range, newText)])
}

export const insertLineBreakWithoutContinuation = async (): Promise<void> => {
  const document = await coc.workspace.document
  if (!document || document.languageId !== 'zig') return

  const nvim = coc.workspace.nvim
  const [lineNumber, column] = (await nvim.call('getcurpos', [])) as number[]

  const line = document.textDocument.lineAt(lineNumber - 1)
  const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex)

  await nvim.call('nvim_buf_set_text', [
    0,
    lineNumber - 1,
    column - 1,
    lineNumber - 1,
    column - 1,
    ['', indent],
  ])
  await nvim.call('cursor', [lineNumber + 1, indent.length + 1]).catch(() => undefined)
}
