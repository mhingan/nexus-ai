import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import * as pty from 'node-pty'

const execFileAsync = promisify(execFile)
type AgentId = 'codex' | 'claude' | 'gemini' | 'copilot'
type Message = { id: string; role: 'user' | 'assistant'; content: string; agent: AgentId; createdAt: number; status?: 'running' | 'complete' | 'error' | 'cancelled'; runId?: string }
type Conversation = { id: string; title: string; projectPath: string; agent: AgentId; updatedAt: number; messages: Message[] }
type WindowState = { x?: number; y?: number; width: number; height: number; maximized?: boolean }
type StoreShape = { projects: string[]; conversations: Conversation[]; recentProject?: string; windowState?: WindowState }
type AgentRunInput = { runId: string; agent: AgentId; prompt: string; cwd: string }
const allowedAgents: AgentId[] = ['codex', 'claude', 'gemini', 'copilot']
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage', '.venv', 'venv', '.idea', '.vscode'])
const maxFileBytes = 2 * 1024 * 1024
let persisted: StoreShape = { projects: [], conversations: [] }
let dataFile = ''
let mainWindow: BrowserWindow | null = null
let loginPath = process.env.PATH ?? ''
const activeProcesses = new Map<string, ReturnType<typeof spawn>>()
const cancelledRuns = new Set<string>()
const terminals = new Map<string, pty.IPty>()

function loadStore() {
  dataFile = path.join(app.getPath('userData'), 'nexus-state.json')
  try {
    const loaded = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Partial<StoreShape>
    persisted = { projects: Array.isArray(loaded.projects) ? loaded.projects : [], conversations: Array.isArray(loaded.conversations) ? loaded.conversations : [], recentProject: loaded.recentProject, windowState: loaded.windowState }
  } catch { /* first run */ }
}
function persist() {
  if (!dataFile) return
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  const temp = `${dataFile}.tmp`
  fs.writeFileSync(temp, JSON.stringify(persisted, null, 2), 'utf8')
  fs.renameSync(temp, dataFile)
}
function emit(channel: string, payload: unknown) { mainWindow?.webContents.send(channel, payload) }
function ensureAgent(agent: string): asserts agent is AgentId {
  if (!allowedAgents.includes(agent as AgentId)) throw new Error(`Unsupported agent: ${agent}`)
}
function ensureDirectory(dir: string) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('The selected project folder is unavailable.')
}
function safePath(root: string, relativePath: string) {
  ensureDirectory(root)
  const base = path.resolve(root)
  const candidate = path.resolve(base, relativePath || '.')
  if (candidate !== base && !candidate.startsWith(base + path.sep)) throw new Error('Path is outside the selected project.')
  // Refuse symlinks in a project path so renderer file operations cannot escape the workspace.
  const parts = path.relative(base, candidate).split(path.sep).filter(Boolean)
  let cursor = base
  for (const part of parts) {
    cursor = path.join(cursor, part)
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are not opened by the workspace file browser.') } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  }
  return candidate
}
const iconPath = path.join(__dirname, '../../build/icon.png')
// First launch opens at a comfortable Slack-like size; afterwards the last size/position is restored
// (only if it is still on a connected display).
function initialWindowState(): WindowState {
  const saved = persisted.windowState
  const primary = screen.getPrimaryDisplay().workArea
  const fallback = { width: Math.min(1280, primary.width - 80), height: Math.min(820, primary.height - 60) }
  if (!saved?.width || !saved?.height) return fallback
  const area = screen.getDisplayMatching({ x: saved.x ?? primary.x, y: saved.y ?? primary.y, width: saved.width, height: saved.height }).workArea
  const width = Math.min(Math.max(saved.width, 960), area.width)
  const height = Math.min(Math.max(saved.height, 640), area.height)
  const onScreen = saved.x !== undefined && saved.y !== undefined
    && saved.x < area.x + area.width - 120 && saved.x + width > area.x + 120
    && saved.y >= area.y - 20 && saved.y < area.y + area.height - 120
  return onScreen ? { x: saved.x, y: saved.y, width, height, maximized: saved.maximized } : { width, height, maximized: saved.maximized }
}
function createWindow() {
  const state = initialWindowState()
  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, minWidth: 960, minHeight: 640,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : { center: true }),
    title: 'NEXUS AI', show: false, icon: iconPath,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 },
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' } : { backgroundColor: '#090b10' }),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWindow.once('ready-to-show', () => { if (state.maximized) mainWindow?.maximize(); mainWindow?.show() })
  mainWindow.on('close', () => {
    if (!mainWindow) return
    persisted.windowState = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }
    persist()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) void shell.openExternal(parsed.toString()) } catch { /* reject malformed urls */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (allowed && url.startsWith(allowed)) return
    if (!allowed && url.startsWith('file://')) return
    event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

async function loginShellValue(script: string) {
  const { stdout } = await execFileAsync('/bin/zsh', ['-lc', script], { timeout: 7000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
// Apps launched from Finder/Dock get a minimal PATH and `zsh -l` skips ~/.zshrc, where Homebrew,
// nvm, npm-global etc. are usually configured. Build the PATH from an interactive login shell plus
// the well-known install locations, so CLIs resolve the same way they do in Terminal.
const pathMarker = '__NEXUS_PATH__'
function knownBinDirectories() {
  const home = os.homedir()
  const dirs = [`${home}/homebrew/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.npm/bin`, `${home}/.bun/bin`, `${home}/.volta/bin`, `${home}/.cargo/bin`, `${home}/Library/pnpm`, `${home}/.yarn/bin`, `${home}/bin`]
  try {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
    const versions = fs.readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    dirs.push(...versions.map(version => path.join(nvmRoot, version, 'bin')))
  } catch { /* nvm not installed */ }
  return dirs
}
async function shellPath(args: string[]) {
  const shell = process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const { stdout } = await execFileAsync(shell, [...args, `printf '${pathMarker}%s${pathMarker}' "$PATH"`], { timeout: 8000, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: 'dumb' } })
  return stdout.split(pathMarker)[1] ?? ''
}
async function detectLoginPath() {
  const fromShell = await shellPath(['-ilc']).catch(() => shellPath(['-lc'])).catch(() => '')
  const seen = new Set<string>()
  const dirs = [...fromShell.split(':'), ...(process.env.PATH ?? '').split(':'), ...knownBinDirectories(), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return dirs.filter(dir => {
    if (!dir || seen.has(dir)) return false
    seen.add(dir)
    try { return fs.statSync(dir).isDirectory() } catch { return false }
  }).join(':')
}
let loginPathReady: Promise<string> = Promise.resolve(loginPath)
function refreshLoginPath() {
  loginPathReady = detectLoginPath().then(value => { loginPath = value || loginPath; return loginPath }).catch(() => loginPath)
  return loginPathReady
}
function findExecutable(name: string, searchPath: string) {
  for (const dir of searchPath.split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
  }
  return undefined
}
async function resolveCli(id: string): Promise<string> {
  const found = findExecutable(id, await loginPathReady) ?? findExecutable(id, await refreshLoginPath())
  if (!found) throw new Error(`${id} CLI was not found. Install it (or check it runs in Terminal with "which ${id}"), then use "Recheck CLI installations" in Settings.`)
  return found
}
function commandFor(agent: AgentId, prompt: string): { args: string[] } {
  switch (agent) {
    case 'codex': return { args: ['exec', '--json', '--skip-git-repo-check', prompt] }
    case 'claude': return { args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'] }
    case 'gemini': return { args: ['-p', prompt, '--output-format', 'stream-json'] }
    case 'copilot': return { args: ['-p', prompt, '--output-format', 'json', '--assisted-approval'] }
  }
}
function stringifyMaybe(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => stringifyMaybe(item)).filter(Boolean).join('')
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text
  return ''
}
type AgentActivity = { kind: 'thinking' | 'step' | 'note'; text: string; fresh?: boolean }
type ParsedOutput = { text?: string; final?: string; activity?: AgentActivity[]; error?: string }
const clip = (value: string, max = 160) => value.length > max ? `${value.slice(0, max - 1)}…` : value
function parseArgs(value: unknown) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
function describeToolInput(input: any): string {
  if (input == null) return ''
  if (typeof input !== 'object') return clip(String(input).replace(/\s+/g, ' '))
  const value = input.command ?? input.cmd ?? input.file_path ?? input.filePath ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt
  if (Array.isArray(value)) return clip(value.join(' '))
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' '))
  try { return clip(JSON.stringify(input)) } catch { return '' }
}
// Turns each CLI's JSON events into: live answer text, the final answer, and "activity"
// (thinking, tool calls, narration) that the UI shows live and collapses when the run ends.
function createOutputParser(agent: AgentId) {
  let reasoningDeltas = false
  const seenTools = new Set<string>()
  const step = (name: string, input?: unknown, id?: string): AgentActivity[] => {
    if (id) { if (seenTools.has(id)) return []; seenTools.add(id) }
    const detail = describeToolInput(parseArgs(input))
    return [{ kind: 'step', text: detail ? `${name} · ${detail}` : name }]
  }
  return (event: any): ParsedOutput => {
    if (!event || typeof event !== 'object') return {}
    if (agent === 'claude') {
      if (event.type === 'stream_event') {
        const inner = event.event
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') return { text: stringifyMaybe(inner.delta.text) }
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') return { activity: [{ kind: 'thinking', text: stringifyMaybe(inner.delta.thinking) }] }
        if (inner?.type === 'content_block_start' && inner.content_block?.type === 'thinking') return { activity: [{ kind: 'thinking', text: '', fresh: true }] }
        return {}
      }
      if (event.type === 'assistant') {
        const tools = (event.message?.content ?? []).filter((item: any) => item?.type === 'tool_use')
        return tools.length ? { activity: tools.flatMap((tool: any) => step(tool.name ?? 'Tool', tool.input, tool.id)) } : {}
      }
      if (event.type === 'result') return event.is_error ? { error: stringifyMaybe(event.result) || 'Claude reported an error.' } : { final: stringifyMaybe(event.result) }
      return {}
    }
    if (agent === 'codex') {
      const item = event.item
      if (event.type === 'item.started' && item?.type === 'command_execution') return { activity: step('Run', item.command, item.id) }
      if (event.type === 'item.started' && item?.type === 'mcp_tool_call') return { activity: step(`${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`, item.arguments, item.id) }
      if (event.type === 'item.started' && item?.type === 'web_search') return { activity: step('Search', item.query, item.id) }
      if (event.type === 'item.completed' && item?.type === 'file_change') return { activity: step('Edit', (item.changes ?? []).map((change: any) => change?.path).filter(Boolean).join(', '), item.id) }
      if (event.type === 'item.completed' && item?.type === 'reasoning') return { activity: [{ kind: 'thinking', text: stringifyMaybe(item.text), fresh: true }] }
      if (event.type === 'item.completed' && item?.type === 'agent_message') return { final: stringifyMaybe(item.text) }
      if (event.type === 'turn.failed' || event.type === 'error') return { error: event.error?.message ?? event.message ?? 'Codex reported an error.' }
      return {}
    }
    if (agent === 'gemini') {
      if (event.type === 'message' && event.role !== 'user') {
        const text = stringifyMaybe(event.content) || stringifyMaybe(event.message)
        return event.delta ? { text } : { final: text }
      }
      if (event.type === 'tool_use') return { activity: step(event.tool_name ?? event.name ?? 'Tool', event.parameters ?? event.args, event.tool_id) }
      if (event.type === 'result' && event.response) return { final: stringifyMaybe(event.response) }
      if (event.type === 'error') return { error: stringifyMaybe(event.message) || stringifyMaybe(event.error?.message) || 'Gemini reported an error.' }
      return {}
    }
    // Copilot emits JSONL envelopes; event names vary slightly between CLI releases.
    const type = String(event.type ?? '').toLowerCase()
    const data = event.data ?? {}
    if (type.startsWith('user') || type.startsWith('session') || type.startsWith('system')) return {} // never echo the prompt back
    if (type.includes('reasoning') && type.includes('delta')) { reasoningDeltas = true; return { activity: [{ kind: 'thinking', text: stringifyMaybe(data.deltaContent) || stringifyMaybe(data.content) }] } }
    if (type.includes('reasoning')) return reasoningDeltas ? {} : { activity: [{ kind: 'thinking', text: stringifyMaybe(data.content), fresh: true }] }
    if (type.includes('message') && type.includes('delta')) return { text: stringifyMaybe(data.deltaContent) || stringifyMaybe(data.content) }
    if (type.startsWith('tool') && type.includes('start')) return { activity: step(data.toolName ?? data.name ?? 'Tool', data.arguments, data.toolCallId) }
    if (type === 'assistant.message') {
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests : []
      const content = stringifyMaybe(data.content)
      if (requests.length) return { activity: [...(content.trim() ? [{ kind: 'note' as const, text: content }] : []), ...requests.flatMap((request: any) => step(request.name ?? request.toolName ?? 'Tool', request.arguments, request.toolCallId))] }
      return content.trim() ? { final: content } : {}
    }
    if (type.includes('error')) return { error: stringifyMaybe(data.message) || stringifyMaybe(event.message) || 'Copilot reported an error.' }
    return {}
  }
}
type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; totalTokens?: number; costUsd?: number; contextWindow?: number; model?: string }
type RateLimit = { status?: string; type?: string; resetsAt?: number; utilization?: number }
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
function extractUsage(agent: AgentId, event: any): { usage?: Usage; rateLimit?: RateLimit } {
  if (!event || typeof event !== 'object') return {}
  if (agent === 'claude') {
    if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const info = event.rate_limit_info
      return { rateLimit: { status: info.status, type: info.rateLimitType, resetsAt: num(info.resetsAt), utilization: num(info.utilization) } }
    }
    if (event.type === 'result' && event.usage) {
      const u = event.usage
      const models = event.modelUsage && typeof event.modelUsage === 'object' ? Object.entries(event.modelUsage) as [string, any][] : []
      const main = models.sort((a, b) => (num(b[1]?.outputTokens) ?? 0) - (num(a[1]?.outputTokens) ?? 0))[0]
      return { usage: { inputTokens: (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0), outputTokens: num(u.output_tokens), cachedTokens: num(u.cache_read_input_tokens), costUsd: num(event.total_cost_usd), contextWindow: num(main?.[1]?.contextWindow), model: main?.[0] } }
    }
  }
  if (agent === 'codex' && event.type === 'turn.completed' && event.usage) {
    return { usage: { inputTokens: num(event.usage.input_tokens), outputTokens: num(event.usage.output_tokens), cachedTokens: num(event.usage.cached_input_tokens) } }
  }
  if (agent === 'gemini' && event.type === 'result' && event.stats) {
    const s = event.stats
    return { usage: { inputTokens: num(s.input_tokens) ?? num(s.input), outputTokens: num(s.output_tokens) ?? num(s.candidates), cachedTokens: num(s.cached), totalTokens: num(s.total_tokens) ?? num(s.total) } }
  }
  if (agent === 'copilot') {
    const data = event.data ?? event
    const input = num(data?.inputTokens) ?? num(data?.usage?.input_tokens) ?? num(data?.usage?.inputTokens)
    const output = num(data?.outputTokens) ?? num(data?.usage?.output_tokens) ?? num(data?.usage?.outputTokens)
    if (input !== undefined || output !== undefined) return { usage: { inputTokens: input, outputTokens: output } }
  }
  return {}
}
function safeConversation(input: Conversation): Conversation {
  if (!input || typeof input.id !== 'string' || typeof input.projectPath !== 'string' || !Array.isArray(input.messages)) throw new Error('Invalid conversation payload.')
  ensureDirectory(input.projectPath)
  return input
}

ipcMain.handle('app:get-state', () => ({ ...persisted, platform: process.platform, version: app.getVersion(), home: os.homedir() }))
ipcMain.handle('project:open', async () => {
  const options: Electron.OpenDialogOptions = { title: 'Open project folder', properties: ['openDirectory', 'createDirectory'] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const selected = result.filePaths[0]
  persisted.projects = [...new Set([selected, ...persisted.projects])]
  persisted.recentProject = selected
  persist()
  return selected
})
ipcMain.handle('project:select', (_event, projectPath: string) => {
  ensureDirectory(projectPath)
  persisted.projects = [...new Set([projectPath, ...persisted.projects])]
  persisted.recentProject = projectPath
  persist()
  return true
})
ipcMain.handle('project:pick-location', async () => {
  const options: Electron.OpenDialogOptions = { title: 'Choose where to create the project', properties: ['openDirectory', 'createDirectory'] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
})
ipcMain.handle('project:create', async (_event, input: { parent: string; name: string; initGit?: boolean }) => {
  const name = (input.name ?? '').trim()
  if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) throw new Error('Enter a valid project name (no slashes or special characters).')
  ensureDirectory(input.parent)
  const target = path.join(input.parent, name)
  if (fs.existsSync(target)) throw new Error(`"${name}" already exists in that location.`)
  await fsp.mkdir(target)
  if (input.initGit) await git(target, ['init']).catch(() => undefined)
  persisted.projects = [...new Set([target, ...persisted.projects])]
  persisted.recentProject = target
  persist()
  return target
})
ipcMain.handle('project:remove', (_event, projectPath: string) => {
  persisted.projects = persisted.projects.filter(p => p !== projectPath)
  if (persisted.recentProject === projectPath) persisted.recentProject = persisted.projects[0]
  persist()
  return true
})
ipcMain.handle('conversation:save', (_event, input: Conversation) => {
  const conversation = safeConversation(input)
  const remaining = persisted.conversations.filter(c => c.id !== conversation.id)
  persisted.conversations = [conversation, ...remaining].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 150)
  persist()
  return true
})
ipcMain.handle('conversation:delete', (_event, id: string) => {
  persisted.conversations = persisted.conversations.filter(c => c.id !== id)
  persist()
  return true
})

ipcMain.handle('files:tree', async (_event, projectPath: string) => {
  ensureDirectory(projectPath)
  const walk = async (dir: string, depth: number): Promise<any[]> => {
    if (depth > 5) return []
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const result: any[] = []
    for (const entry of entries.slice(0, 1200)) {
      if (entry.name.startsWith('.') && ['.git', '.next'].includes(entry.name)) continue
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
      const absolutePath = path.join(dir, entry.name)
      const relativePath = path.relative(projectPath, absolutePath)
      if (entry.isDirectory()) result.push({ name: entry.name, path: relativePath, type: 'directory', children: await walk(absolutePath, depth + 1) })
      else if (entry.isFile()) result.push({ name: entry.name, path: relativePath, type: 'file' })
    }
    return result
  }
  return walk(projectPath, 0)
})
ipcMain.handle('files:read', async (_event, input: { projectPath: string; relativePath: string }) => {
  const target = safePath(input.projectPath, input.relativePath)
  const stat = await fsp.stat(target)
  if (!stat.isFile()) throw new Error('Selected item is not a file.')
  if (stat.size > maxFileBytes) throw new Error('File is larger than the 2 MB editor limit.')
  const buffer = await fsp.readFile(target)
  if (buffer.includes(0)) throw new Error('Binary files cannot be opened in the text editor.')
  return { content: buffer.toString('utf8'), size: stat.size, relativePath: input.relativePath }
})
ipcMain.handle('files:write', async (_event, input: { projectPath: string; relativePath: string; content: string }) => {
  const target = safePath(input.projectPath, input.relativePath)
  if (Buffer.byteLength(input.content, 'utf8') > maxFileBytes) throw new Error('File exceeds the 2 MB editor limit.')
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, input.content, 'utf8')
  return { saved: true, modifiedAt: Date.now() }
})
ipcMain.handle('files:create', async (_event, input: { projectPath: string; relativePath: string; kind: 'file' | 'directory' }) => {
  const target = safePath(input.projectPath, input.relativePath)
  if (fs.existsSync(target)) throw new Error('A file or folder with this name already exists.')
  if (input.kind === 'directory') await fsp.mkdir(target, { recursive: false })
  else { await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, '', { flag: 'wx' }) }
  return true
})
ipcMain.handle('files:delete', async (_event, input: { projectPath: string; relativePath: string }) => {
  const target = safePath(input.projectPath, input.relativePath)
  if (target === path.resolve(input.projectPath)) throw new Error('The project root cannot be deleted from the file explorer.')
  const stat = await fsp.lstat(target)
  if (stat.isDirectory()) await fsp.rmdir(target)
  else await fsp.unlink(target)
  return true
})

function friendlyCommandError(command: string, error: any): string {
  const raw = (error?.stderr?.toString?.().trim() || error?.stdout?.toString?.().trim() || error?.message || `${command} failed.`) as string
  if (error?.code === 'ENOENT') return command === 'gh' ? 'GitHub CLI (gh) is not installed. Install it with "brew install gh", then run "gh auth login" in Terminal.' : `${command} was not found.`
  if (error?.killed || error?.signal === 'SIGTERM') return `${command} timed out. Check your connection and try again.`
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|authentication required|HTTP 401|gh auth login/i.test(raw)) return `GitHub authentication is required. Run "gh auth login" then "gh auth setup-git" in Terminal (or use an SSH remote), then try again.\n\n${raw}`
  if (/Permission denied \(publickey\)/i.test(raw)) return `SSH key rejected by the remote. Add your key to GitHub or use an HTTPS remote.\n\n${raw}`
  return raw
}
async function run(command: string, args: string[], cwd: string, timeout = 15000) {
  ensureDirectory(cwd)
  await loginPathReady
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env: { ...process.env, PATH: loginPath || process.env.PATH, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout, maxBuffer: 6 * 1024 * 1024, encoding: 'utf8' })
    return { stdout, stderr }
  } catch (error: any) {
    throw new Error(friendlyCommandError(command, error))
  }
}
const git = (projectPath: string, args: string[], timeout = 15000) => run('git', args, projectPath, timeout)
ipcMain.handle('git:status', async (_event, projectPath: string) => {
  const { stdout } = await git(projectPath, ['status', '--porcelain=v1', '-z', '--branch'])
  const entries = stdout.split('\0')
  const branchLine = entries.shift() ?? ''
  const files: { code: string; path: string; staged: boolean; unstaged: boolean; untracked: boolean }[] = []
  while (entries.length) {
    const entry = entries.shift()
    if (!entry) continue
    const code = entry.slice(0, 2)
    if (code[0] === 'R' || code[0] === 'C') entries.shift() // original path of a rename/copy
    files.push({ code, path: entry.slice(3), staged: code[0] !== ' ' && code[0] !== '?', unstaged: code[1] !== ' ', untracked: code === '??' })
  }
  const rawBranch = branchLine.replace(/^##\s*/, '')
  const branch = /^No commits yet on /.test(rawBranch) ? rawBranch.replace(/^No commits yet on /, '') : rawBranch.startsWith('HEAD (no branch)') ? 'HEAD (detached)' : rawBranch.split('...')[0] || 'HEAD'
  const tracking = /^[^\s]+\.\.\.(\S+)(?: \[(.*)\])?$/.exec(rawBranch)
  const ahead = Number(/ahead (\d+)/.exec(tracking?.[2] ?? '')?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(tracking?.[2] ?? '')?.[1] ?? 0)
  const remotes = await git(projectPath, ['remote']).then(r => r.stdout.split('\n').filter(Boolean)).catch(() => [] as string[])
  const [diff, stagedDiff, log] = await Promise.all([
    git(projectPath, ['diff', '--no-ext-diff', '--', '.']).then(r => r.stdout).catch(() => ''),
    git(projectPath, ['diff', '--cached', '--no-ext-diff', '--', '.']).then(r => r.stdout).catch(() => ''),
    git(projectPath, ['log', '-5', '--pretty=format:%h%x09%s']).then(r => r.stdout).catch(() => ''),
  ])
  return { branch, files, diff, stagedDiff, log: log.split('\n').filter(Boolean), ahead, behind, upstream: tracking?.[1], remotes }
})
ipcMain.handle('git:file-diff', async (_event, input: { projectPath: string; relativePath: string; staged?: boolean }) => {
  const target = safePath(input.projectPath, input.relativePath)
  const readText = async (filePath: string) => {
    try { const stat = await fsp.stat(filePath); if (stat.size > maxFileBytes) return '[File exceeds the 2 MB diff preview limit.]'; const data = await fsp.readFile(filePath); return data.includes(0) ? '[Binary file]' : data.toString('utf8') } catch { return '' }
  }
  const show = async (revisionPath: string) => git(input.projectPath, ['show', revisionPath]).then(result => result.stdout).catch(() => '')
  if (input.staged) {
    const [original, modified] = await Promise.all([show(`HEAD:${input.relativePath}`), show(`:${input.relativePath}`)])
    return { original, modified }
  }
  const [indexVersion, headVersion, modified] = await Promise.all([show(`:${input.relativePath}`), show(`HEAD:${input.relativePath}`), readText(target)])
  return { original: indexVersion || headVersion, modified }
})
ipcMain.handle('git:stage', async (_event, input: { projectPath: string; paths: string[] }) => { await git(input.projectPath, ['add', '--', ...input.paths]); return true })
ipcMain.handle('git:unstage', async (_event, input: { projectPath: string; paths: string[] }) => { await git(input.projectPath, ['restore', '--staged', '--', ...input.paths]); return true })
ipcMain.handle('git:commit', async (_event, input: { projectPath: string; message: string }) => {
  if (!input.message.trim()) throw new Error('Commit message is required.')
  const { stdout } = await git(input.projectPath, ['commit', '-m', input.message.trim()])
  return stdout
})
ipcMain.handle('git:branches', async (_event, projectPath: string) => {
  const { stdout } = await git(projectPath, ['branch', '--format=%(refname:short)'])
  return stdout.split('\n').filter(line => line && !line.startsWith('('))
})
function validBranchName(branch: unknown): branch is string {
  return typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.includes('@{') && !branch.endsWith('/') && !branch.endsWith('.') && !branch.split('/').some(part => part.endsWith('.lock') || part === '')
}
ipcMain.handle('git:create-branch', async (_event, input: { projectPath: string; branch: string }) => {
  if (!validBranchName(input.branch)) throw new Error('Invalid branch name. Use letters, numbers, ".", "_", "-" or "/".')
  await git(input.projectPath, ['switch', '-c', input.branch])
  return true
})
ipcMain.handle('git:checkout', async (_event, input: { projectPath: string; branch: string }) => {
  if (!validBranchName(input.branch)) throw new Error('Invalid branch name.')
  await git(input.projectPath, ['switch', input.branch])
  return true
})

async function pushCurrent(projectPath: string) {
  const remotes = (await git(projectPath, ['remote'])).stdout.split('\n').filter(Boolean)
  if (!remotes.length) throw new Error('No remote configured. Use "Connect GitHub" in Source control first.')
  const branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (branch === 'HEAD') throw new Error('You are on a detached HEAD. Switch to a branch before pushing.')
  const hasUpstream = await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then(() => true).catch(() => false)
  const args = hasUpstream ? ['push'] : ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], branch]
  const result = await git(projectPath, args, 120000)
  return (result.stderr || result.stdout).trim() || 'Pushed.'
}
ipcMain.handle('git:push', (_event, input: { projectPath: string }) => pushCurrent(input.projectPath))
ipcMain.handle('git:pull', async (_event, input: { projectPath: string }) => (await git(input.projectPath, ['pull', '--ff-only'], 120000)).stdout.trim() || 'Already up to date.')
ipcMain.handle('git:fetch', async (_event, input: { projectPath: string }) => { await git(input.projectPath, ['fetch', '--prune'], 120000); return true })
ipcMain.handle('git:add-remote', async (_event, input: { projectPath: string; url: string }) => {
  const url = (input.url ?? '').trim()
  if (!/^(https:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/.test(url)) throw new Error('Enter a valid remote URL, e.g. https://github.com/you/repo.git or git@github.com:you/repo.git')
  const existing = (await git(input.projectPath, ['remote'])).stdout.split('\n').filter(Boolean)
  if (existing.includes('origin')) await git(input.projectPath, ['remote', 'set-url', 'origin', url])
  else await git(input.projectPath, ['remote', 'add', 'origin', url])
  return true
})
ipcMain.handle('gh:status', async () => {
  try {
    const { stdout, stderr } = await run('gh', ['auth', 'status'], os.homedir(), 10000)
    const text = `${stdout}\n${stderr}`
    return { installed: true, authenticated: true, user: /account (\S+)/.exec(text)?.[1] ?? /as (\S+)/.exec(text)?.[1] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { installed: !/not installed/.test(message), authenticated: false, error: message }
  }
})
ipcMain.handle('gh:create-repo', async (_event, input: { projectPath: string; name: string; isPrivate: boolean }) => {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(input.name ?? '')) throw new Error('Invalid repository name.')
  const hasCommit = await git(input.projectPath, ['rev-parse', 'HEAD']).then(() => true).catch(() => false)
  if (!hasCommit) throw new Error('Make a first commit before creating the GitHub repository.')
  const { stdout, stderr } = await run('gh', ['repo', 'create', input.name, input.isPrivate ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], input.projectPath, 120000)
  return (stdout || stderr).trim().split('\n').pop() || 'Repository created.'
})
ipcMain.handle('gh:pr-create', async (_event, input: { projectPath: string; title: string; body?: string; base?: string; draft?: boolean }) => {
  if (!input.title?.trim()) throw new Error('A pull request title is required.')
  if (input.base && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.base)) throw new Error('Invalid base branch name.')
  await pushCurrent(input.projectPath)
  const args = ['pr', 'create', '--title', input.title.trim(), '--body', input.body ?? '']
  if (input.base) args.push('--base', input.base)
  if (input.draft) args.push('--draft')
  const { stdout } = await run('gh', args, input.projectPath, 120000)
  return stdout.trim().split('\n').pop() ?? ''
})
ipcMain.handle('gh:pr-view', async (_event, input: { projectPath: string }) => {
  try {
    const { stdout } = await run('gh', ['pr', 'view', '--json', 'url,number,state,title'], input.projectPath, 20000)
    return JSON.parse(stdout)
  } catch { return null }
})

ipcMain.handle('agent:check', async () => { await refreshLoginPath(); return Promise.all(allowedAgents.map(async id => {
  try { const command = await resolveCli(id); return { id, installed: true, command } }
  catch (error) { return { id, installed: false, error: error instanceof Error ? error.message : 'Not found' } }
})) })
ipcMain.handle('agent:run', async (_event, input: AgentRunInput) => {
  const { runId, agent, prompt, cwd } = input
  ensureAgent(agent)
  ensureDirectory(cwd)
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is empty.')
  if (activeProcesses.has(runId)) throw new Error('This run ID is already active.')
  const resolvedCommand = await resolveCli(agent)
  const { args } = commandFor(agent, prompt)
  const child = spawn(resolvedCommand, args, { cwd, detached: process.platform !== 'win32', env: { ...process.env, PATH: loginPath || process.env.PATH, FORCE_COLOR: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  activeProcesses.set(runId, child)
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let emittedText = false
  let settled = false
  const finish = (code: number, error?: string) => {
    if (settled) return
    settled = true
    activeProcesses.delete(runId)
    emit('agent:done', { runId, code, error })
  }
  const parse = createOutputParser(agent)
  let reportedError = ''
  const handleOutputLine = (line: string) => {
    if (!line.trim()) return
    let event: any
    try { event = JSON.parse(line) } catch { emit('agent:chunk', { runId, text: `${line}\n` }); return }
    const parsed = parse(event)
    const activity = parsed.activity?.filter(item => item.text || item.fresh)
    if (activity?.length) emit('agent:activity', { runId, items: activity })
    if (parsed.text) emit('agent:chunk', { runId, text: parsed.text })
    if (parsed.final?.trim()) emit('agent:final', { runId, text: parsed.final })
    if (parsed.error) reportedError = parsed.error
    const { usage, rateLimit } = extractUsage(agent, event)
    if (usage || rateLimit) emit('agent:usage', { runId, agent, usage, rateLimit })
  }
  child.stdout?.on('data', chunk => {
    stdoutBuffer += chunk.toString()
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) handleOutputLine(line)
  })
  child.stderr?.on('data', chunk => { const text = chunk.toString(); stderrBuffer = (stderrBuffer + text).slice(-32_000); emit('agent:stderr', { runId, agent, text }) })
  child.on('error', error => { cancelledRuns.delete(runId); finish(-1, error.message) })
  child.on('close', (code, signal) => {
    if (stdoutBuffer.trim()) handleOutputLine(stdoutBuffer)
    const wasCancelled = cancelledRuns.delete(runId)
    const exitCode = wasCancelled ? -2 : (code ?? 128)
    const error = wasCancelled ? 'Stopped by user.' : (exitCode !== 0 ? (reportedError || stderrBuffer.trim() || (signal ? `Process terminated (${signal}).` : undefined)) : undefined)
    finish(exitCode, error)
  })
  return { runId, pid: child.pid }
})
ipcMain.handle('agent:stop', (_event, runId: string) => {
  const child = activeProcesses.get(runId)
  if (!child) return false
  cancelledRuns.add(runId)
  if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
  else child.kill('SIGTERM')
  return true
})

ipcMain.handle('terminal:create', async (_event, input: { terminalId: string; cwd: string; cols?: number; rows?: number }) => {
  ensureDirectory(input.cwd)
  if (terminals.has(input.terminalId)) throw new Error('Terminal already exists.')
  const terminalPath = await loginPathReady
  const terminal = pty.spawn('/bin/zsh', ['-l'], {
    name: 'xterm-256color', cwd: input.cwd, cols: input.cols ?? 100, rows: input.rows ?? 28,
    env: { ...process.env, PATH: terminalPath, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })
  terminals.set(input.terminalId, terminal)
  terminal.onData(data => emit('terminal:data', { terminalId: input.terminalId, data }))
  terminal.onExit(({ exitCode, signal }) => { terminals.delete(input.terminalId); emit('terminal:exit', { terminalId: input.terminalId, exitCode, signal }) })
  return { terminalId: input.terminalId, pid: terminal.pid }
})
ipcMain.handle('terminal:write', (_event, input: { terminalId: string; data: string }) => { terminals.get(input.terminalId)?.write(input.data); return true })
ipcMain.handle('terminal:resize', (_event, input: { terminalId: string; cols: number; rows: number }) => { terminals.get(input.terminalId)?.resize(Math.max(20, input.cols), Math.max(5, input.rows)); return true })
ipcMain.handle('terminal:kill', (_event, terminalId: string) => { const terminal = terminals.get(terminalId); terminal?.kill(); terminals.delete(terminalId); return Boolean(terminal) })
ipcMain.handle('shell:reveal', (_event, target: string) => shell.showItemInFolder(target))
ipcMain.handle('shell:open-external', (_event, url: string) => {
  const parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS links can be opened.')
  return shell.openExternal(parsed.toString())
})

app.setName('NEXUS AI')
if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })
app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) { try { app.dock.setIcon(iconPath) } catch { /* packaged builds use the bundle icon */ } }
  nativeTheme.themeSource = 'dark'
  loadStore()
  void refreshLoginPath()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  for (const child of activeProcesses.values()) {
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
    else child.kill('SIGTERM')
  }
  for (const terminal of terminals.values()) terminal.kill()
})
