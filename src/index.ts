import * as coc from 'coc.nvim'
import { insertLineBreakWithoutContinuation, toggleMultilineStringLiteral } from './commands'
import { errorMessage } from './util'
import { registerBuildOnSaveProvider } from './zigBuildOnSave'
import { registerBuildStepsCommand } from './zigBuildSteps'
import { registerDiagnosticsProvider } from './zigDiagnostics'
import { registerDocumentFormatting } from './zigFormat'
import { createZigProject } from './zigProject'
import { setupZig } from './zigSetup'
import { activateZls, deactivateZls } from './zls'

export function activate(context: coc.ExtensionContext): void {
  const zigSetupDone = setupZig(context)

  context.subscriptions.push(
    registerDiagnosticsProvider(),
    registerBuildOnSaveProvider(),
    registerDocumentFormatting(),
    coc.commands.registerCommand('zig.createProject', () => void createZigProject()),
    coc.commands.registerCommand('zig.toggleMultilineStringLiteral', () => void toggleMultilineStringLiteral()),
    coc.commands.registerCommand(
      'zig.insertLineBreakWithoutContinuation',
      () => void insertLineBreakWithoutContinuation(),
    ),
  )
  registerBuildStepsCommand(context)

  void zigSetupDone
    .catch((error: unknown) => {
      coc.window.showErrorMessage(`Zig setup failed: ${errorMessage(error)}`)
    })
    .then(() => activateZls(context))
    .catch((error: unknown) => {
      coc.window.showErrorMessage(`Zig language server setup failed: ${errorMessage(error)}`)
    })
}

export function deactivate(): void {
  void deactivateZls()
}
