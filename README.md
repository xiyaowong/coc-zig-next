<div align="center">

# coc-zig-next

Zig support for [coc.nvim](https://github.com/neoclide/coc.nvim): toolchain management, the [Zig Language Server](https://github.com/zigtools/zls) (zls) and editor integrations.

[![coc.nvim](https://img.shields.io/badge/coc.nvim-%5E0.0.80-blue?style=flat-square)](https://github.com/neoclide/coc.nvim)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

## ✨ Features

- **Toolchain** — install zig and switch between versions.
- **Language server** — completions, hover, references and go-to-definition from zls.
- **Formatting** — `zig fmt` or zls, on demand or on save.
- **Diagnostics** — `zig ast-check`, plus build-on-save through `zig build --watch`.
- **Project commands** — `zig init`, build steps, and two text-editing commands for multiline string literals and `///` comments.

## 📋 Requirements

- [coc.nvim](https://github.com/neoclide/coc.nvim) 0.0.80 or newer
- [zig.vim](https://github.com/ziglang/zig.vim), for `.zig`/`.zon` filetype detection and syntax highlighting

Builds of zig and zls are published for x86_64/aarch64 Linux, x86_64/aarch64 macOS and x86/x86_64 Windows. Elsewhere, build them yourself and set `zig.path` and `zig.zls.path`.

## 📦 Install

```vim
:CocInstall coc-zig-next
```

## 💻 Usage

1. Open a Zig project and answer yes when asked to enable zls.
2. Format with coc's format action, or add `"zig"` to `coc.preferences.formatOnSaveFiletypes`.
3. Pick another zig version with `:CocCommand zig.install`.

## ⚙️ Settings

Set these in `coc-settings.json` (`:CocConfig`).

| Setting | Default | Values |
| --- | --- | --- |
| `zig.path` | `""` | Path to the zig executable, or `"zig"` for `PATH`. |
| `zig.version` | `null` | zig version to install. |
| `zig.libPath` | `null` | Zig library path. |
| `zig.formattingProvider` | `"zls"` | `off`, `extension` (`zig fmt`) or `zls`. |
| `zig.buildOnSaveProvider` | `"auto"` | `auto`, `off`, `extension` (`zig build --watch`) or `zls`. |
| `zig.buildOnSaveArgs` | `[]` | Extra arguments for `zig build` on save. |
| `zig.zls.enabled` | `"ask"` | `ask`, `off` or `on`. |
| `zig.zls.path` | `null` | Path to the zls executable, or `"zls"` for `PATH`. |
| `zig.zls.trace.server` | `"off"` | `off`, `messages` or `verbose`. |

Also available, with zls's defaults: `zig.zls.enableSnippets`, `enableArgumentPlaceholders`, `completionLabelDetails`, `semanticTokens`, the six `inlayHints*` options, `warnStyle`, `highlightGlobalVarDeclarations`, `skipStdReferences`, `preferAstCheckAsChildProcess`, `builtinPath`, `buildRunnerPath`, `globalCachePath`. Anything else goes into `zig.zls.additionalOptions`, e.g. `"zig.zls.forceAutofix": true`.

Values may use `${workspaceFolder}`, `${file}`, `${userHome}`, `${env:NAME}`, `${cwd}` and `${pathSeparator}`.

## ⌨️ Commands

| Command | Description |
| --- | --- |
| `zig.install` | Install or select a zig version. |
| `zig.createProject` | Create a project with `zig init` or `zig init --minimal`. |
| `zig.buildStep` | Pick a step from `zig build --list-steps` and run it. |
| `zig.toggleMultilineStringLiteral` | Add or remove `\\` on the current line or visual selection. |
| `zig.insertLineBreakWithoutContinuation` | Insert a line break without continuing a `///` comment or multiline string literal. |
| `zig.zls.enable` | Enable and install the language server. |
| `zig.zls.startRestart` | Start or restart the language server. |
| `zig.zls.stop` | Stop the language server. |

## 💾 Code actions on save

| Action | CocAction |
| --- | --- |
| `source.fixAll` | `fixAll` |
| `source.organizeImports` | `organizeImport` |

Neovim (`init.lua`):

```lua
vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = { "*.zig", "*.zon" },
  command = "call CocActionAsync('fixAll')"
})

vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = { "*.zig", "*.zon" },
  command = "call CocActionAsync('organizeImport')"
})
```

Vim (`init.vim` / `.vimrc`):

```vim
autocmd BufWritePre *.zig,*.zon call CocActionAsync('fixAll')
autocmd BufWritePre *.zig,*.zon call CocActionAsync('organizeImport')
```

## 📄 License

MIT
