import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  Activity, ArrowUp, Bot, BookOpen, Braces, Check, ChevronDown, ChevronRight,
  CircleAlert, CircleCheck, Code2, Command, Copy, File, FileCode2,
  FilePlus2, FileText, Folder, FolderOpen, FolderPlus, GitBranch, GitCommitHorizontal, GitCompare,
  HardDrive, History, LoaderCircle, MessageSquare, MoreHorizontal,
  PanelLeftClose, PanelRightClose, PanelTopClose, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Sparkles, Square, SquareTerminal, Trash2, WandSparkles, X, Zap
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { dismissSplash } from './splash'

const Editor = lazy(() => import('./monaco').then(module => ({ default: module.Editor })))
const DiffEditor = lazy(() => import('./monaco').then(module => ({ default: module.DiffEditor })))
const EditorLoading = () => <div className="editor-loading"><LoaderCircle size={16} className="spin"/> Loading editor…</div>

const agentCatalog = [
  { id: 'codex', name: 'OpenAI Codex', label: 'Codex', color: '#A99AFF', mark: 'C', description: 'OpenAI coding agent' },
  { id: 'claude', name: 'Claude Code', label: 'Claude', color: '#E3A77E', mark: 'A', description: 'Anthropic coding agent' },
  { id: 'gemini', name: 'Gemini CLI', label: 'Gemini', color: '#84B6FF', mark: '✦', description: 'Google coding agent' },
  { id: 'copilot', name: 'GitHub Copilot', label: 'Copilot', color: '#D7DCE8', mark: '⌘', description: 'GitHub coding agent' },
] as const
type AgentId = typeof agentCatalog[number]['id']
type Agent = typeof agentCatalog[number]
type Usage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; totalTokens?: number; costUsd?: number; contextWindow?: number; model?: string }
type RateLimit = { status?: string; type?: string; resetsAt?: number; utilization?: number; at?: number }
type Message = { id: string; role: 'user' | 'assistant'; content: string; agent: AgentId; createdAt: number; status?: 'running' | 'complete' | 'error' | 'cancelled'; runId?: string; usage?: Usage; activity?: Activity[]; finishedAt?: number }
type Activity = { kind: 'thinking' | 'step' | 'note'; text: string }
type Conversation = { id: string; title: string; projectPath: string; agent: AgentId; agents?: AgentId[]; updatedAt: number; messages: Message[] }
type AgentHealth = { id: AgentId; installed: boolean; command?: string; error?: string }
type FileNode = { name: string; path: string; type: 'file' | 'directory'; children?: FileNode[] }
type FileTab = { path: string; content: string; dirty: boolean; language: string }
type GitFile = { code: string; path: string; staged: boolean; unstaged: boolean; untracked: boolean }
type GitStatus = { branch: string; files: GitFile[]; diff: string; stagedDiff: string; log: string[]; ahead: number; behind: number; upstream?: string; remotes: string[] }
type GhStatus = { installed: boolean; authenticated: boolean; user?: string; error?: string }
type GitFileDiff = { original: string; modified: string }
type ActiveRun = { runId: string; messageId: string; conversationId: string; agent: AgentId }
type Panel = 'explorer' | 'git'
const makeId = () => crypto.randomUUID()
const basename = (value: string) => value.split('/').filter(Boolean).pop() || value
const timestamp = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const languageFor = (filePath: string) => {
  const extension = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', py: 'python', html: 'html', css: 'css', scss: 'scss', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', xml: 'xml', toml: 'ini', env: 'ini', dockerfile: 'dockerfile', vue: 'vue', svelte: 'svelte', graphql: 'graphql' }
  return map[extension || ''] || (basename(filePath).toLowerCase() === 'dockerfile' ? 'dockerfile' : 'plaintext')
}
const fmtTokens = (value = 0) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))
const totalOf = (usage?: Usage) => usage ? (usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))) : 0
function sumUsage(messages: Message[], agent: AgentId) {
  const sum = { input: 0, output: 0, total: 0, cost: 0, runs: 0 }
  for (const message of messages) {
    if (message.agent !== agent || !message.usage) continue
    sum.input += message.usage.inputTokens ?? 0; sum.output += message.usage.outputTokens ?? 0; sum.total += totalOf(message.usage); sum.cost += message.usage.costUsd ?? 0; sum.runs += 1
  }
  return sum
}
const limitLabel = (limit?: RateLimit) => {
  if (!limit) return ''
  const names: Record<string, string> = { five_hour: '5h window', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', overage: 'Overage' }
  const parts = [limit.type ? names[limit.type] ?? limit.type : 'Limit']
  if (limit.utilization !== undefined) parts.push(`${Math.round(limit.utilization * (limit.utilization <= 1 ? 100 : 1))}% used`)
  else if (limit.status) parts.push(limit.status.replace(/_/g, ' '))
  if (limit.resetsAt) parts.push(`resets ${new Date(limit.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`)
  return parts.join(' · ')
}
const contextPrefix = 'You are continuing a conversation in NEXUS AI.'
// Text streamed before a tool call is narration, not the answer: move it into the activity log.
function applyActivity(message: Message, items: { kind: Activity['kind']; text: string; fresh?: boolean }[]): Message {
  let content = message.content
  const activity = [...(message.activity ?? [])]
  for (const item of items) {
    if (item.kind === 'thinking') {
      const last = activity[activity.length - 1]
      if (!item.fresh && last?.kind === 'thinking') activity[activity.length - 1] = { kind: 'thinking', text: (last.text + item.text).slice(-6000) }
      else activity.push({ kind: 'thinking', text: item.text })
      continue
    }
    const narration = content.trim()
    if (narration) { content = ''; if (!(item.kind === 'note' && item.text.trim() === narration)) activity.push({ kind: 'note', text: narration.slice(0, 2000) }) }
    activity.push({ kind: item.kind, text: item.kind === 'note' ? item.text.trim().slice(0, 2000) : item.text })
  }
  return { ...message, content, activity: activity.filter((entry, index) => entry.text.trim() || index === activity.length - 1).slice(-150) }
}
function applyFinal(message: Message, text: string): Message {
  const current = message.content.trim()
  const activity = current && current !== text.trim() && !text.trim().startsWith(current) ? [...(message.activity ?? []), { kind: 'note' as const, text: current.slice(0, 2000) }] : message.activity
  return { ...message, content: text, activity }
}
const formatSize = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`

function App() {
  const [projects, setProjects] = useState<string[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [agentsHealth, setAgentsHealth] = useState<AgentHealth[]>([])
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(() => { try { const v = JSON.parse(localStorage.getItem('nexus.selectedAgents') || '[]'); return Array.isArray(v) && v.length ? v : ['claude'] } catch { return ['claude'] } })
  const activeAgent: AgentId = selectedAgents[0] ?? 'claude'
  const [limits, setLimits] = useState<Partial<Record<AgentId, RateLimit>>>(() => { try { return JSON.parse(localStorage.getItem('nexus.limits') || '{}') } catch { return {} } })
  const [usageOpen, setUsageOpen] = useState(true)
  const [runs, setRuns] = useState<Record<string, ActiveRun>>({})
  const [prompt, setPrompt] = useState('')
  const [panel, setPanel] = useState<Panel>('explorer')
  const [tree, setTree] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [fileSearch, setFileSearch] = useState('')
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [activeTabPath, setActiveTabPath] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const [showChat, setShowChat] = useState(true)
  const [dockTab, setDockTab] = useState<'terminal' | 'output'>('terminal')
  const [terminalLines, setTerminalLines] = useState<string[]>(['NEXUS AI terminal ready. Select a project to start a shell session.'])
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitError, setGitError] = useState('')
  const [diffPath, setDiffPath] = useState('')
  const [diffValue, setDiffValue] = useState<GitFileDiff>({ original: '', modified: '' })
  const [diffStaged, setDiffStaged] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [branchMenu, setBranchMenu] = useState(false)
  const [topBranchMenu, setTopBranchMenu] = useState(false)
  const [userMenu, setUserMenu] = useState(false)
  const [projectAnchor, setProjectAnchor] = useState<HTMLElement | null>(null)
  const [topBranchAnchor, setTopBranchAnchor] = useState<HTMLElement | null>(null)
  const [gitBranchAnchor, setGitBranchAnchor] = useState<HTMLElement | null>(null)
  const [userAnchor, setUserAnchor] = useState<HTMLElement | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [home, setHome] = useState('')
  const [gitBusy, setGitBusy] = useState<'' | 'push' | 'pull' | 'fetch' | 'commit'>('')
  const [prOpen, setPrOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [existingPr, setExistingPr] = useState<{ url: string; number: number; state: string } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(258)
  const [chatWidth, setChatWidth] = useState(390)
  const [resizing, setResizing] = useState<'sidebar' | 'chat' | null>(null)

  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('.popover-zone')) return
      setProjectMenuOpen(false); setBranchMenu(false); setTopBranchMenu(false); setUserMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setProjectMenuOpen(false); setBranchMenu(false); setTopBranchMenu(false); setUserMenu(false); setSettingsOpen(false); setNewItemOpen(false); setNewProjectOpen(false); setPrOpen(false); setConnectOpen(false) }
    }
    document.addEventListener('mousedown', closeMenus)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('mousedown', closeMenus); document.removeEventListener('keydown', closeOnEscape) }
  }, [])

  useEffect(() => {
    if (!resizing) return
    const onMove = (event: MouseEvent) => {
      if (resizing === 'sidebar') setSidebarWidth(Math.min(420, Math.max(200, event.clientX)))
      else setChatWidth(Math.min(Math.max(320, window.innerWidth - 420), Math.max(300, window.innerWidth - event.clientX)))
    }
    const stop = () => setResizing(null)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
    }
  }, [resizing])
  const [searchChats, setSearchChats] = useState('')
  const [collapsedSidebar, setCollapsedSidebar] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [notice, setNotice] = useState('')
  const [activeView, setActiveView] = useState<'editor' | 'diff'>('editor')
  const [newItemOpen, setNewItemOpen] = useState(false)
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file')
  const [newItemPath, setNewItemPath] = useState('')
  const messageEndRef = useRef<HTMLDivElement>(null)
  const runIds = Object.keys(runs)
  const activeConversation = conversations.find(item => item.id === activeConversationId)
  const currentMessages = activeConversation?.messages ?? []
  const activeTab = tabs.find(tab => tab.path === activeTabPath)
  const activeCount = runIds.length
  const filteredChats = useMemo(() => conversations.filter(item => item.title.toLowerCase().includes(searchChats.toLowerCase()) || basename(item.projectPath).toLowerCase().includes(searchChats.toLowerCase())), [conversations, searchChats])
  const installedCount = agentsHealth.filter(agent => agent.installed).length

  const saveConversation = useCallback((conversation: Conversation) => {
    void window.nexus.saveConversation(conversation).catch(error => pushOutput(`Could not save conversation: ${errorMessage(error)}`))
  }, [])

  function pushOutput(line: string) {
    setTerminalLines(current => [...current, line].slice(-350))
  }

  useEffect(() => {
    let mounted = true
    Promise.all([window.nexus.getState(), window.nexus.checkAgents()]).then(([state, health]) => {
      if (!mounted) return
      const saved = (state.conversations as Conversation[]).map(conversation => ({
        ...conversation,
        messages: conversation.messages.map(message => message.status === 'running'
          ? { ...message, status: 'error' as const, content: message.content || 'Run interrupted because NEXUS AI was closed.' }
          : message),
      }))
      for (const conversation of saved) {
        if (conversation.messages.some(message => message.content === 'Run interrupted because NEXUS AI was closed.')) void window.nexus.saveConversation(conversation)
      }
      setProjects(state.projects)
      setAppVersion(state.version || '')
      setHome(state.home || '')
      setConversations(saved)
      setAgentsHealth(health)
      const initialProject = state.recentProject || saved[0]?.projectPath || state.projects[0] || ''
      setSelectedProject(initialProject)
      if (saved[0]) {
        setActiveConversationId(saved[0].id)
        if (!localStorage.getItem('nexus.selectedAgents')) setSelectedAgents(saved[0].agents?.length ? saved[0].agents : [saved[0].agent])
      }
      setLoading(false)
    }).catch(error => { if (mounted) { setLoading(false); pushOutput(errorMessage(error)) } })

    const offChunk = window.nexus.onChunk(({ runId, text }) => {
      setConversations(current => {
        let changed: Conversation | undefined
        const next = current.map(conversation => {
          if (!conversation.messages.some(message => message.id === runId)) return conversation
          changed = { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map(message => message.id === runId ? { ...message, content: message.content + text } : message) }
          return changed
        })
        return next
      })
      pushOutput(text)
    })
    const offDone = window.nexus.onDone(({ runId, code, error }) => {
      let completed: Conversation | undefined
      setConversations(current => current.map(conversation => {
        if (!conversation.messages.some(message => message.id === runId)) return conversation
        completed = { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map(message => message.id === runId ? { ...message, finishedAt: Date.now(), status: code === 0 ? 'complete' : code === -2 ? 'cancelled' : 'error', content: message.content || (code === 0 ? [...(message.activity ?? [])].reverse().find(entry => entry.kind === 'note')?.text : '') || error || (code === 0 ? 'Completed without a text response.' : code === -2 ? 'Stopped by user.' : `Process exited with code ${code}.`) } : message) }
        return completed
      }))
      setRuns(current => { const next = { ...current }; delete next[runId]; return next })
      pushOutput(`Agent finished · ${code === 0 ? 'success' : `exit ${code}`}${error ? ` · ${error}` : ''}`)
      window.setTimeout(() => {
        setConversations(current => {
          const latest = current.find(conversation => conversation.messages.some(message => message.id === runId))
          if (latest) saveConversation(latest)
          return current
        })
      }, 50)
    })
    const updateMessage = (runId: string, update: (message: Message) => Message) => setConversations(current => current.map(conversation => conversation.messages.some(message => message.id === runId)
      ? { ...conversation, updatedAt: Date.now(), messages: conversation.messages.map(message => message.id === runId ? update(message) : message) }
      : conversation))
    const offActivity = window.nexus.onActivity(({ runId, items }) => updateMessage(runId, message => applyActivity(message, items)))
    const offFinal = window.nexus.onFinal(({ runId, text }) => updateMessage(runId, message => applyFinal(message, text)))
    const offUsage = window.nexus.onUsage(({ runId, agent, usage, rateLimit }) => {
      if (usage) setConversations(current => current.map(conversation => conversation.messages.some(message => message.id === runId)
        ? { ...conversation, messages: conversation.messages.map(message => message.id === runId ? { ...message, usage: { ...message.usage, ...usage } } : message) }
        : conversation))
      if (rateLimit) setLimits(current => {
        const next = { ...current, [agent as AgentId]: { ...rateLimit, at: Date.now() } }
        try { localStorage.setItem('nexus.limits', JSON.stringify(next)) } catch { /* storage unavailable */ }
        return next
      })
    })
    const offStderr = window.nexus.onStderr(({ agent, text }) => pushOutput(`[${agent}] ${text.trimEnd()}`))
    const hideTerminal = () => setShowTerminal(false)
    window.addEventListener('nexus:hide-terminal', hideTerminal)
    return () => { mounted = false; offChunk(); offDone(); offActivity(); offFinal(); offUsage(); offStderr(); window.removeEventListener('nexus:hide-terminal', hideTerminal) }
  }, [saveConversation])

  useEffect(() => { if (!loading) requestAnimationFrame(() => requestAnimationFrame(dismissSplash)) }, [loading])

  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [currentMessages])

  useEffect(() => {
    if (!selectedProject) { setTree([]); setGitStatus(null); setBranches([]); return }
    void refreshFiles()
    void refreshGit()
    void window.nexus.selectProject(selectedProject)
  }, [selectedProject])

  useEffect(() => {
    if (!selectedProject || activeCount > 0) return
    void refreshFiles()
    void refreshGit()
  }, [activeCount, selectedProject])

  async function refreshFiles() {
    if (!selectedProject) return
    try {
      const nextTree = await window.nexus.listFiles(selectedProject)
      setTree(nextTree)
    } catch (error) { setNotice(errorMessage(error)) }
  }

  useEffect(() => {
    setExistingPr(null)
    if (!selectedProject || !gitStatus?.remotes.length || !gitStatus.upstream) return
    let cancelled = false
    window.nexus.ghPrView({ projectPath: selectedProject }).then(pr => { if (!cancelled) setExistingPr(pr) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedProject, gitStatus?.branch, gitStatus?.upstream, gitStatus?.ahead])

  async function refreshGit() {
    if (!selectedProject) return
    try {
      const [status, nextBranches] = await Promise.all([window.nexus.gitStatus(selectedProject), window.nexus.gitBranches(selectedProject)])
      setGitStatus(status)
      setBranches(nextBranches)
      setGitError('')
    } catch (error) {
      setGitStatus(null)
      setBranches([])
      setGitError(errorMessage(error))
    }
  }

  async function openProject() {
    if (tabs.some(tab => tab.dirty) && !window.confirm('Discard unsaved editor changes before opening another project?')) return
    const projectPath = await window.nexus.openProject()
    if (!projectPath) return
    setProjects(current => [projectPath, ...current.filter(item => item !== projectPath)])
    setProjectMenuOpen(false)
    setSelectedProject(projectPath)
    setActiveConversationId('')
    setTabs([])
    setActiveTabPath('')
    setDiffPath('')
  }

  function activateProject(projectPath: string) {
    setProjects(current => [projectPath, ...current.filter(item => item !== projectPath)])
    setProjectMenuOpen(false)
    setSelectedProject(projectPath)
    setActiveConversationId('')
    setTabs([])
    setActiveTabPath('')
    setDiffPath('')
  }

  async function createProject(parent: string, name: string, initGit: boolean) {
    if (tabs.some(tab => tab.dirty) && !window.confirm('Discard unsaved editor changes before opening the new project?')) return
    const projectPath = await window.nexus.createProject({ parent, name, initGit })
    setNewProjectOpen(false)
    activateProject(projectPath)
  }

  async function createBranch(name: string) {
    if (!selectedProject) return
    try { await window.nexus.gitCreateBranch({ projectPath: selectedProject, branch: name }); setBranchMenu(false); setTopBranchMenu(false); await refreshGit() }
    catch (error) { setNotice(errorMessage(error)) }
  }

  function selectProject(projectPath: string) {
    if (tabs.some(tab => tab.dirty) && !window.confirm('Discard unsaved editor changes before switching projects?')) return
    setProjects(current => [projectPath, ...current.filter(item => item !== projectPath)])
    setProjectMenuOpen(false)
    setSelectedProject(projectPath)
    setActiveConversationId('')
    setTabs([])
    setActiveTabPath('')
    setDiffPath('')
  }

  function createConversation() {
    if (!selectedProject) { void openProject(); return }
    const agents = [...selectedAgents]
    const conversation: Conversation = { id: makeId(), title: 'New conversation', projectPath: selectedProject, agent: activeAgent, agents, updatedAt: Date.now(), messages: [] }
    setConversations(current => [conversation, ...current])
    setActiveConversationId(conversation.id)
    setShowChat(true)
    saveConversation(conversation)
  }

  function selectConversation(conversation: Conversation) {
    if (conversation.projectPath !== selectedProject && tabs.some(tab => tab.dirty) && !window.confirm('Discard unsaved editor changes before switching to this conversation?')) return
    if (conversation.projectPath !== selectedProject) { setTabs([]); setActiveTabPath(''); setDiffPath('') }
    setProjects(current => [conversation.projectPath, ...current.filter(item => item !== conversation.projectPath)])
    setActiveConversationId(conversation.id)
    setProjectMenuOpen(false)
    setSelectedProject(conversation.projectPath)
    setShowChat(true)
  }

  function toggleAgent(agentId: AgentId) {
    const next = selectedAgents.includes(agentId)
      ? (selectedAgents.length === 1 ? selectedAgents : selectedAgents.filter(item => item !== agentId))
      : [...selectedAgents, agentId]
    setSelectedAgents(next)
    localStorage.setItem('nexus.selectedAgents', JSON.stringify(next))
    const current = conversations.find(item => item.id === activeConversationId)
    if (current) {
      const updated = { ...current, agents: next }
      setConversations(items => items.map(item => item.id === updated.id ? updated : item))
      saveConversation(updated)
    }
  }

  async function openFile(relativePath: string) {
    if (!selectedProject) return
    const existing = tabs.find(tab => tab.path === relativePath)
    if (existing) { setActiveTabPath(relativePath); setActiveView('editor'); return }
    try {
      const result = await window.nexus.readFile({ projectPath: selectedProject, relativePath })
      setTabs(current => [...current, { path: relativePath, content: result.content, dirty: false, language: languageFor(relativePath) }])
      setActiveTabPath(relativePath)
      setActiveView('editor')
    } catch (error) { setNotice(errorMessage(error)) }
  }

  function updateEditor(value: string | undefined) {
    if (value === undefined) return
    setTabs(current => current.map(tab => tab.path === activeTabPath ? { ...tab, content: value, dirty: true } : tab))
  }

  async function saveActiveFile() {
    if (!activeTab || !selectedProject) return
    try {
      await window.nexus.writeFile({ projectPath: selectedProject, relativePath: activeTab.path, content: activeTab.content })
      setTabs(current => current.map(tab => tab.path === activeTab.path ? { ...tab, dirty: false } : tab))
      pushOutput(`Saved ${activeTab.path}`)
      void refreshGit()
    } catch (error) { setNotice(errorMessage(error)) }
  }

  function closeTab(pathToClose: string) {
    const targetTab = tabs.find(tab => tab.path === pathToClose)
    if (targetTab?.dirty && !window.confirm(`Discard unsaved changes in ${basename(pathToClose)}?`)) return
    const currentIndex = tabs.findIndex(tab => tab.path === pathToClose)
    const next = tabs.filter(tab => tab.path !== pathToClose)
    setTabs(next)
    if (activeTabPath === pathToClose) setActiveTabPath(next[Math.max(0, currentIndex - 1)]?.path || '')
  }

  async function createItem() {
    const relativePath = newItemPath.trim().replace(/^\/+/, '')
    if (!selectedProject || !relativePath) return
    try {
      await window.nexus.createFile({ projectPath: selectedProject, relativePath, kind: newItemType })
      setNewItemOpen(false); setNewItemPath('')
      await refreshFiles()
      if (newItemType === 'file') void openFile(relativePath)
    } catch (error) { setNotice(errorMessage(error)) }
  }

  async function deleteSelectedFile(relativePath: string) {
    if (!selectedProject) return
    const targetTab = tabs.find(tab => tab.path === relativePath)
    const warning = targetTab?.dirty
      ? `Delete ${relativePath} and discard its unsaved editor changes? This cannot be undone.`
      : `Delete ${relativePath}? This cannot be undone.`
    if (!window.confirm(warning)) return
    try {
      await window.nexus.deleteFile({ projectPath: selectedProject, relativePath })
      const remaining = tabs.filter(tab => tab.path !== relativePath)
      setTabs(remaining)
      if (activeTabPath === relativePath) setActiveTabPath(remaining[remaining.length - 1]?.path || '')
      await refreshFiles()
      void refreshGit()
    } catch (error) { setNotice(errorMessage(error)) }
  }

  async function loadDiff(file: GitFile, staged = false) {
    if (!selectedProject) return
    try {
      const value = await window.nexus.gitFileDiff({ projectPath: selectedProject, relativePath: file.path, staged })
      setDiffPath(file.path)
      setDiffValue(value)
      setDiffStaged(staged)
      setActiveView('diff')
      setPanel('git')
    } catch (error) { setNotice(errorMessage(error)) }
  }

  async function stageFile(file: GitFile) {
    if (!selectedProject) return
    try { await window.nexus.gitStage({ projectPath: selectedProject, paths: [file.path] }); await refreshGit() }
    catch (error) { setNotice(errorMessage(error)) }
  }
  async function unstageFile(file: GitFile) {
    if (!selectedProject) return
    try { await window.nexus.gitUnstage({ projectPath: selectedProject, paths: [file.path] }); await refreshGit() }
    catch (error) { setNotice(errorMessage(error)) }
  }
  async function commitChanges(andPush = false) {
    if (!selectedProject || !commitMessage.trim() || gitBusy) return
    setGitBusy(andPush ? 'push' : 'commit')
    try {
      const result = await window.nexus.gitCommit({ projectPath: selectedProject, message: commitMessage })
      setCommitMessage(''); pushOutput(result || 'Commit created.')
      if (andPush) { pushOutput(await window.nexus.gitPush({ projectPath: selectedProject })); setNotice('✓ Committed and pushed') }
      await refreshGit()
    } catch (error) { setNotice(errorMessage(error)); await refreshGit() }
    finally { setGitBusy('') }
  }
  async function gitSync(kind: 'push' | 'pull' | 'fetch') {
    if (!selectedProject || gitBusy) return
    setGitBusy(kind)
    try {
      if (kind === 'push') pushOutput(await window.nexus.gitPush({ projectPath: selectedProject }))
      else if (kind === 'pull') pushOutput(await window.nexus.gitPull({ projectPath: selectedProject }))
      else await window.nexus.gitFetch({ projectPath: selectedProject })
      setNotice(`✓ ${kind === 'push' ? 'Pushed' : kind === 'pull' ? 'Pulled latest changes' : 'Fetched'} successfully`)
      await refreshGit()
    } catch (error) { setNotice(errorMessage(error)) }
    finally { setGitBusy('') }
  }
  async function createPullRequest(input: { title: string; body: string; base: string; draft: boolean }) {
    const url = await window.nexus.ghCreatePr({ projectPath: selectedProject, ...input })
    setPrOpen(false)
    setNotice(`✓ Pull request created${url ? `: ${url}` : ''}`)
    if (/^https:\/\//.test(url)) void window.nexus.openExternal(url)
    await refreshGit()
  }
  async function connectRemote(mode: 'url' | 'create', value: string, isPrivate: boolean) {
    if (mode === 'url') await window.nexus.gitAddRemote({ projectPath: selectedProject, url: value })
    else await window.nexus.ghCreateRepo({ projectPath: selectedProject, name: value, isPrivate })
    setConnectOpen(false)
    setNotice(mode === 'url' ? '✓ Remote connected. You can push now.' : '✓ GitHub repository created and pushed')
    await refreshGit()
  }
  async function checkoutBranch(branch: string) {
    if (!selectedProject) return
    if (gitStatus?.files.length && !window.confirm('There are uncommitted changes. Switching branches may fail. Continue?')) return
    try { await window.nexus.gitCheckout({ projectPath: selectedProject, branch }); setBranchMenu(false); setTopBranchMenu(false); await refreshGit() }
    catch (error) { setNotice(errorMessage(error)) }
  }

  async function sendPrompt() {
    const value = prompt.trim()
    if (!value || !selectedProject || selectedAgents.length === 0) return
    let conversation = conversations.find(item => item.id === activeConversationId)
    if (!conversation) {
      conversation = { id: makeId(), title: value.slice(0, 54), projectPath: selectedProject, agent: activeAgent, updatedAt: Date.now(), messages: [] }
      setActiveConversationId(conversation.id)
    }
    const userMessage: Message = { id: makeId(), role: 'user', content: value, agent: activeAgent, createdAt: Date.now() }
    const selected = [...selectedAgents]
    const assistantMessages = selected.map(agent => { const messageId = makeId(); return { id: messageId, role: 'assistant' as const, content: '', agent, createdAt: Date.now(), status: 'running' as const, runId: messageId } })
    const updated: Conversation = {
      ...conversation,
      title: conversation.title === 'New conversation' ? value.slice(0, 54) : conversation.title,
      agent: activeAgent,
      agents: selected,
      updatedAt: Date.now(),
      messages: [...conversation.messages, userMessage, ...assistantMessages],
    }
    setConversations(current => [updated, ...current.filter(item => item.id !== updated.id)])
    saveConversation(updated)
    setPrompt('')
    setShowChat(true)
    const context = conversation.messages.filter(message => message.role === 'user' || (message.status === 'complete' && message.content.trim() && !message.content.startsWith(contextPrefix))).slice(-12).map(message => `${message.role === 'user' ? 'User' : agentCatalog.find(agent => agent.id === message.agent)?.label ?? message.agent}: ${message.content.slice(0, 4500)}`).join('\n\n')
    for (const assistant of assistantMessages) {
      const agent = assistant.agent
      const runId = assistant.runId!
      const task = context ? `${contextPrefix} Recent context:\n${context}\n\nCurrent user request:\n${value}` : value
      setRuns(current => ({ ...current, [runId]: { runId, messageId: assistant.id, conversationId: updated.id, agent } }))
      pushOutput(`Starting ${agent} in ${selectedProject}`)
      window.nexus.runAgent({ runId, agent, prompt: task, cwd: selectedProject }).catch(error => {
        const message = errorMessage(error)
        setRuns(current => { const next = { ...current }; delete next[runId]; return next })
        setConversations(current => {
          const next = current.map(item => item.id !== updated.id ? item : { ...item, messages: item.messages.map(entry => entry.id === assistant.id ? { ...entry, content: message, status: 'error' as const } : entry), updatedAt: Date.now() })
          const completed = next.find(item => item.id === updated.id)
          if (completed) saveConversation(completed)
          return next
        })
        pushOutput(`[${agent}] ${message}`)
      })
    }
  }

  async function stopAgent(runId: string) {
    await window.nexus.stopAgent(runId)
    pushOutput('Stop requested.')
  }
  async function stopAllAgents() { await Promise.all(runIds.map(id => window.nexus.stopAgent(id))) }
  async function removeConversation(id: string) {
    if (!window.confirm('Delete this conversation?')) return
    await window.nexus.deleteConversation(id)
    setConversations(current => current.filter(item => item.id !== id))
    if (activeConversationId === id) setActiveConversationId('')
  }

  function expandDirectory(relativePath: string) {
    setExpanded(current => { const next = new Set(current); next.has(relativePath) ? next.delete(relativePath) : next.add(relativePath); return next })
  }

  const keyHandler = useCallback((event: KeyboardEvent) => {
    const isMeta = event.metaKey || event.ctrlKey
    if (isMeta && event.key.toLowerCase() === 's') { event.preventDefault(); void saveActiveFile() }
    if (isMeta && event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject() }
    if (isMeta && event.key.toLowerCase() === 'k') { event.preventDefault(); createConversation() }
    if (isMeta && event.key.toLowerCase() === 'j') { event.preventDefault(); setShowTerminal(value => !value) }
    if (isMeta && event.key === '1') { event.preventDefault(); setPanel('explorer') }
    if (isMeta && event.key === '2') { event.preventDefault(); setPanel('git'); void refreshGit() }
    if (event.key === 'Escape' && notice) setNotice('')
  }, [activeTab, selectedProject, notice, selectedAgents, activeConversationId, tabs])
  useEffect(() => { window.addEventListener('keydown', keyHandler); return () => window.removeEventListener('keydown', keyHandler) }, [keyHandler])

  const visibleTree = useMemo(() => {
    if (!fileSearch.trim()) return tree
    const needle = fileSearch.toLowerCase()
    const filterNodes = (nodes: FileNode[]): FileNode[] => nodes.flatMap(node => {
      if (node.type === 'file') return node.path.toLowerCase().includes(needle) ? [node] : []
      const children = filterNodes(node.children || [])
      return children.length || node.path.toLowerCase().includes(needle) ? [{ ...node, children }] : []
    })
    return filterNodes(tree)
  }, [tree, fileSearch])

  if (loading) return null

  return <div className="app-shell">
    <aside className={`sidebar ${collapsedSidebar ? 'sidebar-collapsed' : ''}`} style={collapsedSidebar ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="brandbar"><div className="brand-symbol"><LogoMark/></div>{!collapsedSidebar && <><span className="brand-name">NEXUS <b>AI</b></span>{appVersion && <span className="version-tag">{appVersion}</span>}</>}<button className="bare-icon sidebar-collapse" title="Collapse sidebar" onClick={() => setCollapsedSidebar(value => !value)}><PanelLeftClose size={15}/></button></div>
      <div className="project-switcher-wrap popover-zone">
        <button ref={setProjectAnchor} className="project-switcher" onClick={() => setProjectMenuOpen(value => !value)} title="Switch project"><div className="project-icon"><FolderOpen size={16}/></div>{!collapsedSidebar && <div className="project-switcher-copy"><span>WORKSPACE</span><b>{selectedProject ? basename(selectedProject) : 'Open a project'}</b></div>}<ChevronDown size={13}/></button>
        <Popover open={projectMenuOpen && !collapsedSidebar} anchor={projectAnchor} width={Math.max(300, sidebarWidth - 20)}><div className="project-menu"><div className="project-menu-heading">RECENT PROJECTS</div>{projects.length ? projects.map(project => <div className={`project-menu-row ${project === selectedProject ? 'active' : ''}`} key={project}><button className="project-menu-select" onClick={() => selectProject(project)}><Folder size={13}/><span><b>{basename(project)}</b><small>{project}</small></span>{project === selectedProject && <Check size={12}/>}</button><button className="project-menu-remove" title="Remove from recent projects" onClick={() => { void window.nexus.removeProject(project); setProjects(current => current.filter(item => item !== project)) }}><X size={12}/></button></div>) : <div className="project-menu-empty">No recent projects yet.</div>}<button className="project-menu-open" onClick={() => { setProjectMenuOpen(false); void openProject() }}><FolderOpen size={13}/> Open existing folder…</button><button className="project-menu-open" onClick={() => { setProjectMenuOpen(false); setNewProjectOpen(true) }}><FolderPlus size={13}/> New project…</button></div></Popover>
      </div>
      {!collapsedSidebar && <>
        <div className="sidebar-section-label">DEVELOP</div>
        <button className={`side-nav ${panel === 'explorer' ? 'chosen' : ''}`} onClick={() => setPanel('explorer')}><Folder size={16}/> Explorer <span className="side-kbd">⌘ 1</span></button>
        <button className={`side-nav ${panel === 'git' ? 'chosen' : ''}`} onClick={() => { setPanel('git'); void refreshGit() }}><GitBranch size={16}/> Source control {gitStatus?.files.length ? <span className="count-pill">{gitStatus.files.length}</span> : null}<span className="side-kbd">⌘ 2</span></button>
        <button className="side-nav" onClick={() => setShowTerminal(value => !value)}><SquareTerminal size={16}/> Terminal <span className="side-kbd">⌘ J</span></button>
        <div className="sidebar-divider"/>
        <div className="section-row"><span>{panel === 'explorer' ? 'PROJECT FILES' : 'SOURCE CONTROL'}</span><div className="section-actions">{panel === 'explorer' && <><button className="bare-icon" title="New file" onClick={() => { setNewItemType('file'); setNewItemOpen(true) }}><FilePlus2 size={14}/></button><button className="bare-icon" title="New folder" onClick={() => { setNewItemType('directory'); setNewItemOpen(true) }}><FolderPlus size={14}/></button></>}<button className="bare-icon" title="Refresh" onClick={() => panel === 'explorer' ? void refreshFiles() : void refreshGit()}><RefreshCw size={13}/></button></div></div>
        {panel === 'explorer' ? <>
          <div className="file-search"><Search size={13}/><input value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Filter files"/></div>
          <div className="explorer-tree">{selectedProject ? visibleTree.map(node => <FileTreeNode key={node.path} node={node} depth={0} expanded={expanded} onExpand={expandDirectory} onOpen={openFile} activePath={activeTabPath} onContextDelete={deleteSelectedFile}/>) : <div className="sidebar-empty">Open a local project to browse its files.</div>}</div>
        </> : <GitPanel
          status={gitStatus} error={gitError} branchMenu={branchMenu} setBranchMenu={setBranchMenu} branchRef={setGitBranchAnchor} onRefresh={refreshGit}
          onStage={stageFile} onUnstage={unstageFile} onDiff={loadDiff}
          commitMessage={commitMessage} setCommitMessage={setCommitMessage} onCommit={commitChanges} busy={gitBusy} onSync={gitSync} onConnect={() => setConnectOpen(true)} onPullRequest={() => setPrOpen(true)} existingPr={existingPr}
        />}
        <BranchPopover open={branchMenu} anchor={gitBranchAnchor} branches={branches} current={gitStatus?.branch} onCheckout={checkoutBranch} onCreate={createBranch}/>
        <div className="sidebar-divider recent-divider"/>
        <div className="section-row"><span>RECENT CONVERSATIONS</span><button className="bare-icon" title="New conversation" onClick={() => createConversation()}><Plus size={14}/></button></div>
        <div className="chat-search"><Search size={12}/><input value={searchChats} onChange={event => setSearchChats(event.target.value)} placeholder="Search conversations"/></div>
        <div className="recent-chats">{filteredChats.map(conversation => <div key={conversation.id} className={`recent-chat ${activeConversationId === conversation.id ? 'active' : ''}`}><button onClick={() => selectConversation(conversation)}><MessageSquare size={13}/><span>{conversation.title}</span></button><button className="chat-delete" onClick={() => void removeConversation(conversation.id)} title="Delete conversation"><X size={12}/></button></div>)}{filteredChats.length === 0 && <div className="empty-recent">No saved conversations.</div>}</div>
      </>}
      <div className="sidebar-footer"><div className="provider-health"><span className={`health-light ${installedCount ? 'online' : ''}`}/>{!collapsedSidebar && <span>{installedCount}/4 CLIs available</span>}</div><button className="side-nav settings-nav" onClick={() => setSettingsOpen(true)}><Settings2 size={15}/>{!collapsedSidebar && 'Settings'}</button><div ref={setUserAnchor} className="user-strip popover-zone" role="button" tabIndex={0} onClick={() => setUserMenu(value => !value)}><div className="user-avatar">N</div>{!collapsedSidebar && <div><b>Local environment</b><span>macOS workspace</span></div>}<MoreHorizontal size={15}/><Popover open={userMenu} anchor={userAnchor} width={220}><div className="user-menu"><button onClick={() => { setUserMenu(false); setSettingsOpen(true) }}><Settings2 size={13}/> Settings</button><button onClick={() => { setUserMenu(false); void openProject() }}><FolderOpen size={13}/> Open project…</button><button onClick={() => { setUserMenu(false); setNewProjectOpen(true) }}><FolderPlus size={13}/> New project…</button><button onClick={() => { setUserMenu(false); setShowTerminal(true) }}><SquareTerminal size={13}/> Open terminal</button></div></Popover></div></div>
    </aside>
    {!collapsedSidebar && <div className={`resizer ${resizing === 'sidebar' ? 'active' : ''}`} onMouseDown={event => { event.preventDefault(); setResizing('sidebar') }}/>}

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><span className="crumb-muted">NEXUS AI</span><ChevronRight size={13}/><strong>{selectedProject ? basename(selectedProject) : 'Workspace'}</strong>{selectedProject && <><span className="topbar-dot">·</span><div className="branch-anchor popover-zone"><button ref={setTopBranchAnchor} className="branch-trigger" onClick={() => setTopBranchMenu(value => !value)}><GitBranch size={13}/>{gitStatus?.branch || 'No Git branch'}<ChevronDown size={12}/></button><BranchPopover open={topBranchMenu} anchor={topBranchAnchor} branches={branches} current={gitStatus?.branch} onCheckout={checkoutBranch} onCreate={createBranch}/></div></>}</div>
        <div className="topbar-actions"><div className="runtime-indicator"><span className="runtime-dot"/>LOCAL RUNTIME</div><button className="bare-icon" title="Open project" onClick={openProject}><FolderOpen size={15}/></button><button className="bare-icon" title="Toggle chat panel" onClick={() => setShowChat(value => !value)}><PanelRightClose size={15}/></button><button className="bare-icon" title="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={15}/></button></div>
      </header>

      {!selectedProject ? <WelcomeScreen onOpen={openProject} onNew={() => setNewProjectOpen(true)} agentsHealth={agentsHealth} onSelectAgent={toggleAgent} selectedAgents={selectedAgents}/> : <>
        <div className={`workspace-grid ${showChat ? '' : 'chat-hidden'}`}>
          <section className="editor-column">
            <div className="editor-toolbar"><div className="view-tabs"><button className={`view-tab ${activeView === 'editor' ? 'active' : ''}`} onClick={() => setActiveView('editor')}><Code2 size={14}/> Editor</button>{activeView === 'diff' && <button className="view-tab active"><GitCompare size={14}/> Diff</button>}</div><div className="editor-actions">{activeTab && <><span className="file-language">{activeTab.language}</span>{activeTab.dirty && <span className="dirty-dot" title="Unsaved changes"/>}<button className="editor-action" onClick={() => void saveActiveFile()} disabled={!activeTab.dirty}><Check size={13}/> Save <kbd>⌘S</kbd></button></>}<button className="editor-action" onClick={() => setShowTerminal(value => !value)}><SquareTerminal size={14}/> Terminal</button></div></div>
            <div className="tab-strip">{tabs.map(tab => <div className={`file-tab ${activeTabPath === tab.path && activeView === 'editor' ? 'selected' : ''}`} key={tab.path}><button onClick={() => { setActiveTabPath(tab.path); setActiveView('editor') }}><FileCode2 size={13}/><span>{basename(tab.path)}</span>{tab.dirty && <i/>}</button><button className="tab-close" onClick={() => closeTab(tab.path)}><X size={12}/></button></div>)}{diffPath && activeView === 'diff' && <div className="file-tab selected"><button><GitCompare size={13}/><span>{basename(diffPath)}</span></button></div>}<div className="tab-spacer"/><button className="bare-icon" title="Refresh project files" onClick={() => void refreshFiles()}><RefreshCw size={13}/></button></div>
            <div className="editor-stage">
              {activeView === 'diff' ? <DiffWorkspace diff={diffValue} path={diffPath} staged={diffStaged}/> : activeTab ? <Suspense fallback={<EditorLoading/>}><Editor height="100%" theme="nexus-glass" language={activeTab.language} value={activeTab.content} onChange={updateEditor} options={{ fontSize: 11, lineHeight: 17, fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Monaco, monospace', minimap: { enabled: true, scale: 0.8 }, padding: { top: 18 }, smoothScrolling: true, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderWhitespace: 'selection', wordWrap: 'off', bracketPairColorization: { enabled: true }, guides: { indentation: true, bracketPairs: true }, cursorSmoothCaretAnimation: 'on', cursorBlinking: 'smooth', roundedSelection: true, fontLigatures: true }} /></Suspense> : <EditorWelcome project={selectedProject} onOpen={openProject} onCreate={() => { setNewItemType('file'); setNewItemOpen(true) }} onTerminal={() => setShowTerminal(true)} gitCount={gitStatus?.files.length ?? 0}/>}
            </div>
            <TerminalDock visible={showTerminal} projectPath={selectedProject} lines={terminalLines} onOutput={pushOutput} activeTab={dockTab} setActiveTab={setDockTab}/>
            <footer className="statusbar"><div><span className="status-ready"><CircleCheck size={12}/> Workspace ready</span><span className="status-divider"/><span><GitBranch size={12}/>{gitStatus?.branch || 'No Git'}</span><span><FileCode2 size={12}/>{activeTab ? activeTab.path : 'No file selected'}</span></div><div><span>{activeTab?.language || 'Plain workspace'}</span><span>UTF-8</span><span>Spaces: 2</span><span>⌘S to save</span></div></footer>
          </section>
          {showChat && <><div className={`resizer ${resizing === 'chat' ? 'active' : ''}`} onMouseDown={event => { event.preventDefault(); setResizing('chat') }}/><aside className="ai-panel" style={{ width: chatWidth, minWidth: 300, maxWidth: 'none' }}>
            <div className="ai-panel-header"><div className="ai-panel-title"><div className="ai-title-icon"><Sparkles size={15}/></div><div><b>AI WORKSPACE</b><span>{activeCount ? `${activeCount} agent${activeCount > 1 ? 's' : ''} running` : 'Your coding agents'}</span></div></div><div className="ai-header-actions"><button className="bare-icon" title="New conversation" onClick={() => createConversation()}><Plus size={14}/></button><button className="bare-icon" title="Hide chat" onClick={() => setShowChat(false)}><PanelRightClose size={14}/></button></div></div>
            <div className="agent-picker"><div className="picker-label"><span>SELECT AGENTS</span><span>{selectedAgents.length} selected</span></div><div className="agent-picker-grid">{agentCatalog.map(agent => <button key={agent.id} className={`agent-select ${selectedAgents.includes(agent.id) ? 'selected' : ''}`} onClick={() => toggleAgent(agent.id)} title={agent.description}><span className="agent-mark" style={{ color: agent.color, borderColor: `${agent.color}4a`, background: `${agent.color}12` }}>{agent.mark}</span><span>{agent.label}</span>{agentsHealth.find(item => item.id === agent.id)?.installed ? <i className="agent-online"/> : <i className="agent-offline"/>}<span className="agent-select-check">{selectedAgents.includes(agent.id) ? <Check size={11}/> : null}</span></button>)}</div></div>
            <UsageStrip open={usageOpen} onToggle={() => setUsageOpen(value => !value)} agents={selectedAgents} messages={currentMessages} all={conversations} limits={limits}/>
            <div className="chat-context"><span><Folder size={12}/>{basename(selectedProject)}</span><span className="context-separator"/><span><ShieldCheck size={12}/>Provider permissions</span></div>
            <div className="chat-messages">
              {currentMessages.length === 0 ? <ChatEmpty activeAgent={activeAgent} onPrompt={setPrompt} /> : <div className="message-stack">{currentMessages.map(message => <ChatMessage key={message.id} message={message} onStop={stopAgent}/>)}<div ref={messageEndRef}/></div>}
            </div>
            <div className="chat-composer-wrap"><div className="chat-composer"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() } }} placeholder={`Ask ${selectedAgents.length > 1 ? `${selectedAgents.length} agents` : agentCatalog.find(agent => agent.id === activeAgent)?.label} anything...`} rows={3}/><div className="composer-bottom"><div className="composer-extras"><span><HardDrive size={12}/> Local project</span><span className="composer-hint">↵ send · ⇧↵ newline</span></div><div className="composer-buttons">{activeCount > 0 && <button className="stop-all-button" onClick={() => void stopAllAgents()}><Square size={11} fill="currentColor"/> Stop all</button>}<button className="send-button" onClick={() => void sendPrompt()} disabled={!prompt.trim() || selectedAgents.length === 0}><ArrowUp size={16}/></button></div></div></div><p className="composer-footnote">{selectedAgents.length > 1 ? 'Parallel agents share this project folder. Avoid assigning overlapping file edits.' : 'Agents use their own provider permissions. Review changes before committing.'}</p></div>
          </aside></>}
        </div>
        {!showChat && <button className="restore-chat" onClick={() => setShowChat(true)}><Sparkles size={14}/> Show AI workspace</button>}
      </>}
    </main>

    {settingsOpen && <SettingsModal agentsHealth={agentsHealth} appVersion={appVersion} conversations={conversations} limits={limits} onClose={() => setSettingsOpen(false)} onRefresh={() => window.nexus.checkAgents().then(setAgentsHealth)}/>}
    {prOpen && <PullRequestModal branch={gitStatus?.branch || ''} suggestion={gitStatus?.log[0]?.split('\t').slice(1).join(' ') || ''} defaultBase={branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : ''} onCreate={createPullRequest} onClose={() => setPrOpen(false)}/>}
    {connectOpen && <ConnectGitHubModal defaultName={basename(selectedProject)} onConnect={connectRemote} onClose={() => setConnectOpen(false)}/>}
    {newProjectOpen && <NewProjectModal defaultParent={selectedProject ? selectedProject.split('/').slice(0, -1).join('/') || home : home} onPick={() => window.nexus.pickProjectLocation()} onCreate={createProject} onClose={() => setNewProjectOpen(false)}/>}
    {newItemOpen && <div className="modal-backdrop" onClick={() => setNewItemOpen(false)}><div className="new-item-modal" onClick={event => event.stopPropagation()}><div className="modal-title"><b>Create in project</b><button className="bare-icon" onClick={() => setNewItemOpen(false)}><X size={15}/></button></div><div className="modal-tabs"><button className={newItemType === 'file' ? 'active' : ''} onClick={() => setNewItemType('file')}><FilePlus2 size={14}/> File</button><button className={newItemType === 'directory' ? 'active' : ''} onClick={() => setNewItemType('directory')}><Folder size={14}/> Folder</button></div><label className="modal-label">Relative path</label><input autoFocus value={newItemPath} onChange={event => setNewItemPath(event.target.value)} placeholder="src/components/NewComponent.tsx" onKeyDown={event => { if (event.key === 'Enter') void createItem() }}/><div className="modal-footer"><button className="secondary-button" onClick={() => setNewItemOpen(false)}>Cancel</button><button className="primary-button" onClick={() => void createItem()} disabled={!newItemPath.trim()}>Create {newItemType}</button></div></div></div>}
    {notice && <div className={`toast ${notice.startsWith('✓') ? 'ok' : ''}`} role="status">{notice.startsWith('✓') ? <CircleCheck size={15}/> : <CircleAlert size={15}/>}<span>{notice}</span><button onClick={() => setNotice('')}><X size={13}/></button></div>}
  </div>
}

function FileTreeNode({ node, depth, expanded, onExpand, onOpen, activePath, onContextDelete }: { node: FileNode; depth: number; expanded: Set<string>; onExpand: (path: string) => void; onOpen: (path: string) => void; activePath: string; onContextDelete: (path: string) => void }) {
  const isOpen = expanded.has(node.path)
  const icon = node.type === 'directory' ? (isOpen ? <FolderOpen size={14}/> : <Folder size={14}/>) : fileIcon(node.name)
  return <div className="tree-node-wrap"><div className={`tree-node ${activePath === node.path ? 'active' : ''}`} style={{ paddingLeft: 9 + depth * 13 }}><button className="tree-main" onClick={() => node.type === 'directory' ? onExpand(node.path) : onOpen(node.path)}>{node.type === 'directory' ? (isOpen ? <ChevronDown size={12}/> : <ChevronRight size={12}/>) : <span className="tree-indent"/>}<span className={`tree-icon ${node.type}`}>{icon}</span><span className="tree-name">{node.name}</span></button>{node.type === 'file' && <button className="tree-more" title="Delete file" onClick={() => onContextDelete(node.path)}><MoreHorizontal size={13}/></button>}</div>{node.type === 'directory' && isOpen && <div>{(node.children || []).map(child => <FileTreeNode key={child.path} node={child} depth={depth + 1} expanded={expanded} onExpand={onExpand} onOpen={onOpen} activePath={activePath} onContextDelete={onContextDelete}/>)}</div>}</div>
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'swift'].includes(ext || '')) return <FileCode2 size={13}/>
  if (['json', 'yml', 'yaml', 'toml', 'xml'].includes(ext || '')) return <Braces size={13}/>
  if (['md', 'txt', 'rst'].includes(ext || '')) return <FileText size={13}/>
  return <File size={13}/>
}

function GitPanel({ status, error, branchMenu, setBranchMenu, branchRef, onRefresh, onStage, onUnstage, onDiff, commitMessage, setCommitMessage, onCommit, busy, onSync, onConnect, onPullRequest, existingPr }: { status: GitStatus | null; error: string; branchMenu: boolean; setBranchMenu: (value: boolean) => void; branchRef: (element: HTMLElement | null) => void; onRefresh: () => void; onStage: (file: GitFile) => void; onUnstage: (file: GitFile) => void; onDiff: (file: GitFile, staged?: boolean) => void; commitMessage: string; setCommitMessage: (value: string) => void; onCommit: (andPush?: boolean) => void; busy: string; onSync: (kind: 'push' | 'pull' | 'fetch') => void; onConnect: () => void; onPullRequest: () => void; existingPr: { url: string; number: number; state: string } | null }) {
  const staged = status?.files.filter(file => file.staged) || []
  const changes = status?.files.filter(file => file.unstaged || file.untracked) || []
  return <div className="git-panel popover-zone"><div className="git-branch-box"><button ref={branchRef} onClick={() => setBranchMenu(!branchMenu)}><GitBranch size={14}/><span>{status?.branch || 'No repository'}</span><ChevronDown size={12}/></button><button className="bare-icon" title="Refresh Git status" onClick={onRefresh}><RefreshCw size={13}/></button></div>{!error && <GitSync status={status} busy={busy} onSync={onSync} onConnect={onConnect} onPullRequest={onPullRequest} existingPr={existingPr}/>}{error ? <div className="git-error"><CircleAlert size={14}/>{error}<small>Initialize Git or open a repository folder.</small></div> : <>
    <div className="git-group"><div className="git-group-heading"><b>Staged changes</b><span>{staged.length}</span></div>{staged.map(file => <GitFileRow key={`s-${file.path}`} file={file} staged onStage={onStage} onUnstage={onUnstage} onDiff={onDiff}/ >)}{!staged.length && <div className="git-empty">No staged changes.</div>}</div>
    <div className="git-group"><div className="git-group-heading"><b>Changes</b><span>{changes.length}</span></div>{changes.map(file => <GitFileRow key={`u-${file.path}`} file={file} staged={false} onStage={onStage} onUnstage={onUnstage} onDiff={onDiff}/ >)}{!changes.length && <div className="git-empty">Working tree clean.</div>}</div>
    <div className="commit-box"><label>Commit message</label><textarea value={commitMessage} onChange={event => setCommitMessage(event.target.value)} placeholder="Describe your changes..." rows={2}/><div className="commit-buttons"><button onClick={() => onCommit(false)} disabled={!commitMessage.trim() || !staged.length || !!busy}><GitCommitHorizontal size={14}/> Commit{staged.length ? ` (${staged.length})` : ''}</button><button onClick={() => onCommit(true)} disabled={!commitMessage.trim() || !staged.length || !!busy || !status?.remotes.length} title={status?.remotes.length ? 'Commit and push to the remote' : 'Connect a remote first'}><ArrowUp size={14}/> Commit &amp; Push</button></div>{!staged.length && <small>Stage changes before committing.</small>}</div>
    <div className="git-group history-group"><div className="git-group-heading"><b>Recent commits</b><History size={12}/></div>{status?.log.map((line, index) => { const [hash, ...rest] = line.split('\t'); return <div className="commit-row" key={`${hash}-${index}`}><code>{hash}</code><span>{rest.join(' ')}</span></div> })}{!status?.log.length && <div className="git-empty">No commits yet.</div>}</div>
  </>}</div>
}
function GitFileRow({ file, staged, onStage, onUnstage, onDiff }: { file: GitFile; staged: boolean; onStage: (file: GitFile) => void; onUnstage: (file: GitFile) => void; onDiff: (file: GitFile, staged?: boolean) => void }) {
  return <div className="git-file-row"><button className="git-file-main" onClick={() => onDiff(file, staged)}><FileCode2 size={13}/><span>{basename(file.path)}</span><small>{file.code.trim() || 'U'}</small></button><button className="git-file-action" title={staged ? 'Unstage' : 'Stage'} onClick={() => staged ? onUnstage(file) : onStage(file)}>{staged ? <MinusIcon/> : <Plus size={13}/>}</button></div>
}
function MinusIcon() { return <span className="minus-icon">−</span> }

function WelcomeScreen({ onOpen, onNew, agentsHealth, onSelectAgent, selectedAgents }: { onOpen: () => void; onNew: () => void; agentsHealth: AgentHealth[]; onSelectAgent: (id: AgentId) => void; selectedAgents: AgentId[] }) {
  return <div className="welcome-workspace"><div className="welcome-aura"/><div className="welcome-hero"><div className="welcome-symbol"><LogoMark/></div><div className="welcome-eyebrow">YOUR LOCAL AI DEVELOPMENT ENVIRONMENT</div><h1>One workspace.<br/><span>Four perspectives.</span></h1><p>Bring your coding agents, source code, terminal and Git workflow together in one focused desktop IDE.</p><button className="welcome-primary" onClick={onOpen}><FolderOpen size={16}/> Open a project <span>⌘ O</span></button> <button className="welcome-secondary" onClick={onNew}><FolderPlus size={16}/> New project</button><div className="welcome-provider-row">{agentCatalog.map(agent => { const health = agentsHealth.find(item => item.id === agent.id); return <button key={agent.id} onClick={() => onSelectAgent(agent.id)} className={selectedAgents.includes(agent.id) ? 'selected' : ''}><i style={{ background: agent.color }}/>{agent.label}<span className={health?.installed ? 'ready' : ''}>{health?.installed ? 'Installed' : 'Not installed'}</span></button> })}</div></div><div className="welcome-shortcuts"><div><Command size={14}/><b>⌘ K</b><span>New chat</span></div><div><Command size={14}/><b>⌘ S</b><span>Save file</span></div><div><Command size={14}/><b>⌘ J</b><span>Toggle terminal</span></div></div></div>
}
function EditorWelcome({ project, onOpen, onCreate, onTerminal, gitCount }: { project: string; onOpen: () => void; onCreate: () => void; onTerminal: () => void; gitCount: number }) {
  return <div className="editor-welcome"><div className="editor-welcome-card"><div className="editor-welcome-icon"><Code2 size={22}/></div><span className="editor-eyebrow">PROJECT WORKSPACE</span><h2>{basename(project)}</h2><p>Choose a file from the Explorer to start editing, or create something new.</p><div className="editor-welcome-actions"><button className="primary-button" onClick={onCreate}><FilePlus2 size={14}/> New file</button><button className="secondary-button" onClick={onTerminal}><SquareTerminal size={14}/> Open terminal</button><button className="secondary-button" onClick={onOpen}><FolderOpen size={14}/> Switch project</button></div><div className="workspace-stats"><span><GitBranch size={13}/> Git changes <b>{gitCount}</b></span><span><ShieldCheck size={13}/> Files stay local</span></div></div></div>
}
function ChatEmpty({ activeAgent, onPrompt }: { activeAgent: AgentId; onPrompt: (value: string) => void }) {
  const agent = agentCatalog.find(item => item.id === activeAgent)!
  const suggestions = [
    { icon: <BookOpen size={15}/>, title: 'Explore this codebase', description: 'Map architecture and entry points', prompt: 'Explore this codebase. Explain its architecture, important modules, and how to run and test it.' },
    { icon: <ShieldCheck size={15}/>, title: 'Review code quality', description: 'Find bugs and risky patterns', prompt: 'Review this codebase for bugs, security issues, performance risks, and technical debt. Prioritize actionable findings with file references.' },
    { icon: <WandSparkles size={15}/>, title: 'Plan an improvement', description: 'Propose the next useful feature', prompt: 'Inspect this project and propose the three most valuable improvements. Do not modify files yet; explain trade-offs and recommend one.' },
  ]
  return <div className="chat-empty-state"><div className="chat-empty-icon" style={{ color: agent.color }}><Sparkles size={19}/></div><h3>What should we work on?</h3><p>Send a task to {agent.label}, or select multiple agents to compare approaches in parallel.</p><div className="chat-suggestions">{suggestions.map(item => <button key={item.title} onClick={() => onPrompt(item.prompt)}><span className="suggestion-icon">{item.icon}</span><span><b>{item.title}</b><small>{item.description}</small></span><ArrowUp size={13}/></button>)}</div></div>
}
function ChatMessage({ message, onStop }: { message: Message; onStop: (runId: string) => void }) {
  const agent = agentCatalog.find(item => item.id === message.agent)!
  const [copied, setCopied] = useState(false)
  async function copyMessage() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { /* clipboard permission unavailable */ }
  }
  return <article className={`chat-message ${message.role}`}>
    <div className={`message-avatar ${message.role}`} style={message.role === 'assistant' ? { color: agent.color } : undefined}>{message.role === 'user' ? 'M' : agent.mark}</div>
    <div className="message-main"><div className="message-head"><b>{message.role === 'user' ? 'You' : agent.label}</b><time>{timestamp(message.createdAt)}</time>{message.usage && totalOf(message.usage) > 0 && <span className="message-usage" title={`Input ${message.usage.inputTokens ?? 0} · Output ${message.usage.outputTokens ?? 0}${message.usage.cachedTokens ? ` · Cached ${message.usage.cachedTokens}` : ''}${message.usage.costUsd ? ` · $${message.usage.costUsd.toFixed(4)}` : ''}`}><Zap size={9}/>{message.usage.inputTokens !== undefined && message.usage.outputTokens !== undefined ? `${fmtTokens(message.usage.inputTokens)} in · ${fmtTokens(message.usage.outputTokens)} out` : `${fmtTokens(totalOf(message.usage))} tokens`}</span>}{message.status === 'running' && <span className="message-running"><i/> Running</span>}{message.status === 'complete' && <span className="message-done"><Check size={10}/> Done</span>}{message.status === 'cancelled' && <span className="message-error">Stopped</span>}{message.status === 'error' && <span className="message-error">Failed</span>}<span className="message-spacer"/>{message.content && <button className="message-copy" title="Copy response" onClick={() => void copyMessage()}>{copied ? <Check size={12}/> : <Copy size={12}/>}</button>}{message.status === 'running' && message.runId && <button className="message-stop" title="Stop agent" onClick={() => onStop(message.runId!)}><Square size={10} fill="currentColor"/></button>}</div>
      {message.role === 'assistant' && <ActivityLog activity={message.activity ?? []} running={message.status === 'running'} startedAt={message.createdAt} finishedAt={message.finishedAt}/>}
      <div className="message-content">{message.role === 'assistant' && message.content ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div> : <div className="plain-message">{message.content || (message.status === 'running' && !message.activity?.length ? <span className="thinking-dots"><i/><i/><i/> Agent is working…</span> : '')}</div>}</div>
    </div>
  </article>
}
function ActivityLog({ activity, running, startedAt, finishedAt }: { activity: Activity[]; running: boolean; startedAt: number; finishedAt?: number }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [running])
  useEffect(() => { if (running && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [activity, running])
  if (!activity.length) return null
  const steps = activity.filter(entry => entry.kind === 'step').length
  const seconds = Math.max(1, Math.round(((running ? now : finishedAt ?? now) - startedAt) / 1000))
  const last = activity[activity.length - 1]
  const label = running ? (last.kind === 'step' ? last.text : last.kind === 'note' ? 'Working…' : 'Thinking…') : `Thought for ${seconds}s${steps ? ` · ${steps} step${steps > 1 ? 's' : ''}` : ''}`
  const entries = running ? activity.slice(-8) : activity
  return <div className={`activity ${running ? 'live' : ''} ${open ? 'open' : ''}`}>
    <button className="activity-head" onClick={() => { if (!running) setOpen(value => !value) }}>{running ? <LoaderCircle size={12} className="spin"/> : <Sparkles size={12}/>}<span>{label}</span>{running ? <time>{seconds}s</time> : <ChevronRight size={12} className="activity-chevron"/>}</button>
    {(running || open) && <div className="activity-body" ref={bodyRef}>{entries.map((entry, index) => <div key={index} className={`activity-item ${entry.kind}`}>{entry.kind === 'step' && <ChevronRight size={11}/>}<span>{entry.kind === 'thinking' && running && index === entries.length - 1 ? entry.text.slice(-480) : entry.text}</span></div>)}</div>}
  </div>
}
function DiffWorkspace({ diff, path, staged }: { diff: GitFileDiff; path: string; staged: boolean }) {
  return <div className="diff-workspace"><div className="diff-heading"><div><GitCompare size={15}/><b>{path || 'Git diff'}</b><span>{staged ? 'STAGED' : 'WORKING TREE'}</span></div><small>HEAD / index compared with local file</small></div><Suspense fallback={<EditorLoading/>}><DiffEditor height="calc(100% - 43px)" theme="nexus-glass" original={diff.original} modified={diff.modified} language={languageFor(path)} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 11, lineHeight: 17, automaticLayout: true, scrollBeyondLastLine: false, originalEditable: false }} /></Suspense></div>
}

function TerminalDock({ visible, projectPath, lines, onOutput, activeTab, setActiveTab }: { visible: boolean; projectPath: string; lines: string[]; onOutput: (line: string) => void; activeTab: 'terminal' | 'output'; setActiveTab: (tab: 'terminal' | 'output') => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalId = useMemo(() => makeId(), [])
  const readyRef = useRef(false)
  const visibleRef = useRef(visible)
  useEffect(() => { visibleRef.current = visible }, [visible])
  useEffect(() => {
    if (!projectPath || !hostRef.current) return
    const terminal = new XTerminal({ allowTransparency: true, theme: { background: '#00000000', foreground: '#C5CAD4', cursor: '#B8A7F5', selectionBackground: '#45405F', black: '#151924', red: '#E58D91', green: '#8BCDA8', yellow: '#E5C58A', blue: '#8FAFEA', magenta: '#B69CEB', cyan: '#84C5CC', white: '#C5CAD4' }, fontFamily: '"SFMono-Regular", Menlo, monospace', fontSize: 11, lineHeight: 1.45, cursorBlink: true, scrollback: 4000, convertEol: true })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostRef.current)
    terminalRef.current = terminal
    fitRef.current = fit
    const offData = window.nexus.onTerminalData(({ terminalId: id, data }) => { if (id === terminalId) terminal.write(data) })
    const offExit = window.nexus.onTerminalExit(({ terminalId: id, exitCode }) => { if (id === terminalId) { terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`); readyRef.current = false } })
    terminal.onData(data => { void window.nexus.writeTerminal({ terminalId, data }) })
    window.nexus.createTerminal({ terminalId, cwd: projectPath, cols: 100, rows: 24 }).then(() => {
      readyRef.current = true
      terminal.writeln('\x1b[90mNEXUS AI · local zsh session\x1b[0m')
      window.setTimeout(() => { try { fit.fit(); void window.nexus.resizeTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows }) } catch { /* panel can still be hidden */ } }, 100)
    }).catch(error => { terminal.writeln(`\x1b[31m${errorMessage(error)}\x1b[0m`); onOutput(errorMessage(error)) })
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return
      try { fit.fit(); if (readyRef.current) void window.nexus.resizeTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows }) } catch { /* hidden terminal */ }
    })
    resizeObserver.observe(hostRef.current)
    return () => {
      resizeObserver.disconnect(); offData(); offExit()
      void window.nexus.killTerminal(terminalId)
      terminal.dispose(); terminalRef.current = null; fitRef.current = null
    }
  }, [projectPath, terminalId])
  useEffect(() => { if (visible) window.setTimeout(() => { try { fitRef.current?.fit(); const terminal = terminalRef.current; if (terminal && readyRef.current) void window.nexus.resizeTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows }) } catch { /* no-op */ } }, 60) }, [visible, terminalId])
  return <div className={`terminal-dock ${visible ? 'visible' : 'hidden'}`}>
    <div className="dock-header"><div className="dock-tabs"><button className={activeTab === 'terminal' ? 'active' : ''} onClick={() => setActiveTab('terminal')}><SquareTerminal size={13}/> Terminal</button><button className={activeTab === 'output' ? 'active' : ''} onClick={() => setActiveTab('output')}><Activity size={13}/> Output</button></div><div className="dock-actions"><span>zsh · {basename(projectPath)}</span><button className="bare-icon" title="Hide terminal" onClick={() => window.dispatchEvent(new CustomEvent('nexus:hide-terminal'))}><PanelTopClose size={14}/></button></div></div>
    <div className={`terminal-host ${activeTab === 'terminal' ? '' : 'not-active'}`} ref={hostRef}/>
    {activeTab === 'output' && <div className="output-lines">{lines.slice(-180).map((line, index) => <div key={`${index}-${line.slice(0, 12)}`}>{line}</div>)}</div>}
  </div>
}

function SettingsModal({ agentsHealth, appVersion, conversations, limits, onClose, onRefresh }: { agentsHealth: AgentHealth[]; appVersion: string; conversations: Conversation[]; limits: Partial<Record<AgentId, RateLimit>>; onClose: () => void; onRefresh: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="settings-modal" onClick={event => event.stopPropagation()}><div className="modal-title"><div><b>NEXUS AI settings</b><span>Local runtime and provider diagnostics</span></div><button className="bare-icon" onClick={onClose}><X size={15}/></button></div><div className="settings-section-title">CLI INSTALLATIONS</div><div className="settings-agent-list">{agentCatalog.map(agent => { const health = agentsHealth.find(item => item.id === agent.id); return <div className="settings-agent-row" key={agent.id}><div className="agent-mark" style={{ color: agent.color, borderColor: `${agent.color}4a`, background: `${agent.color}12` }}>{agent.mark}</div><div><b>{agent.name}</b><span>{health?.command || health?.error || 'Checking…'}</span></div><span className={`settings-status ${health?.installed ? 'connected' : 'disconnected'}`}>{health?.installed ? 'Installed' : 'Not installed'}</span></div> })}</div><button className="settings-refresh" onClick={onRefresh}><RefreshCw size={13}/> Recheck CLI installations</button><GitHubSettings/><div className="settings-section-title">TOKEN USAGE · ALL CONVERSATIONS</div><div className="settings-agent-list">{agentCatalog.map(agent => { const sum = sumUsage(conversations.flatMap(item => item.messages), agent.id); const limit = limitLabel(limits[agent.id]); return <div className="settings-agent-row" key={agent.id}><div className="agent-mark" style={{ color: agent.color, borderColor: `${agent.color}4a`, background: `${agent.color}12` }}>{agent.mark}</div><div><b>{agent.label}</b><span>{sum.runs ? `${fmtTokens(sum.input)} in · ${fmtTokens(sum.output)} out · ${sum.runs} run${sum.runs > 1 ? 's' : ''}${sum.cost ? ` · $${sum.cost.toFixed(2)}` : ''}` : 'No usage recorded yet'}{limit ? ` · ${limit}` : ''}</span></div></div> })}</div><div className="settings-info-row"><Activity size={14}/><span>Usage is read from each CLI's own report after every run. Remaining plan quota is shown only where the CLI exposes it (e.g. Claude's rate-limit window); check provider dashboards for exact balances.</span></div><div className="settings-section-title">LOCAL DATA & SECURITY</div><div className="settings-info-row"><ShieldCheck size={14}/><span>Conversations and project history are stored locally in Electron app data.</span></div><div className="settings-info-row"><HardDrive size={14}/><span>Project files stay on your Mac. NEXUS does not upload your source code itself.</span></div><div className="settings-info-row"><Bot size={14}/><span>This check confirms the CLI executable is present; sign-in, permissions and usage remain managed by that CLI.</span></div><div className="settings-footer"><span>NEXUS AI · Version {appVersion}</span><span>macOS desktop</span></div></div></div>
}

const NEXUS_N = 'M491,308 L633,308 L906,628 L906,308 L1004,308 L1004,734 L869,734 L584,402 L584,704 L491,704Z'
const NEXUS_SWOOSH = 'M682,309 L724,305 L763,294 L802,286 L841,279 L878,274 L914,271 L948,270 L980,271 L1010,274 L1037,279 L1060,286 L1081,294 L1097,303 L1110,312 L1119,322 L1125,332 L1129,342 L1130,353 L1130,365 L1127,378 L1122,394 L1113,412 L1101,430 L1086,450 L1067,471 L1046,492 L1021,513 L994,534 L965,555 L934,575 L900,594 L866,612 L830,629 L793,644 L756,658 L719,671 L682,681 L646,690 L610,696 L576,701 L544,704 L513,705 L485,703 L459,700 L436,695 L416,689 L399,681 L386,671 L375,661 L367,649 L361,636 L358,621 L359,604 L362,585 L369,565 L380,543 L394,521 L412,497 L432,474 L451,445 L451,445 L420,461 L396,484 L375,506 L358,529 L344,552 L333,575 L326,598 L323,621 L324,644 L330,666 L340,686 L355,704 L373,720 L395,734 L420,745 L448,754 L478,760 L510,764 L545,765 L581,765 L619,761 L658,756 L698,749 L738,739 L779,728 L820,714 L860,699 L899,682 L937,663 L974,644 L1009,622 L1042,600 L1073,577 L1101,553 L1127,528 L1149,503 L1168,477 L1184,451 L1196,424 L1205,397 L1208,370 L1207,344 L1201,318 L1189,295 L1173,274 L1152,257 L1129,244 L1104,233 L1076,226 L1046,221 L1014,219 L980,219 L945,222 L909,227 L871,234 L833,244 L794,255 L756,269 L717,285 L682,309Z'
function LogoMark({ animated = false }: { animated?: boolean }) {
  return <svg className={`logo-mark ${animated ? 'logo-animated' : ''}`} viewBox="265 0 1000 1000" role="img" aria-label="NEXUS AI">
    <defs><linearGradient id="nexus-swoosh" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#5f2fe0"/><stop offset="1" stopColor="#b08cff"/></linearGradient></defs>
    <path className="logo-n-fill" d={NEXUS_N} fill="#fff" stroke="#fff" strokeWidth="32" strokeLinejoin="round"/>
    {animated && <path className="logo-n-draw" d={NEXUS_N} pathLength="1" fill="none" stroke="#fff" strokeWidth="6" strokeLinejoin="round"/>}
    <path className="logo-swoosh" d={NEXUS_SWOOSH} fill="url(#nexus-swoosh)"/>
  </svg>
}

function useGhStatus() {
  const [status, setStatus] = useState<GhStatus | null>(null)
  const refresh = useCallback(() => { setStatus(null); window.nexus.ghStatus().then(setStatus).catch(() => setStatus({ installed: false, authenticated: false })) }, [])
  useEffect(() => { refresh() }, [refresh])
  return { status, refresh }
}
function ghHint(status: GhStatus | null) {
  if (!status) return 'Checking GitHub CLI…'
  if (!status.installed) return 'GitHub CLI not installed. Run: brew install gh'
  if (!status.authenticated) return 'Not signed in. Run in Terminal: gh auth login && gh auth setup-git'
  return `Signed in${status.user ? ` as ${status.user}` : ''}`
}
function GitHubSettings() {
  const { status, refresh } = useGhStatus()
  const ok = !!status?.authenticated
  return <><div className="settings-section-title">GITHUB</div><div className="settings-agent-list"><div className="settings-agent-row"><div className="agent-mark" style={{ color: '#d7dce8', borderColor: '#d7dce84a', background: '#d7dce812' }}><GitBranch size={11}/></div><div><b>GitHub CLI (gh)</b><span>{ghHint(status)}</span></div><span className={`settings-status ${ok ? 'connected' : 'disconnected'}`}>{ok ? 'Connected' : 'Not connected'}</span></div></div><button className="settings-refresh" onClick={refresh}><RefreshCw size={13}/> Recheck GitHub connection</button><div className="settings-info-row"><ShieldCheck size={14}/><span>NEXUS never stores GitHub tokens. Push, pull and pull requests use your own git credentials and the gh CLI.</span></div></>
}
function GitSync({ status, busy, onSync, onConnect, onPullRequest, existingPr }: { status: GitStatus | null; busy: string; onSync: (kind: 'push' | 'pull' | 'fetch') => void; onConnect: () => void; onPullRequest: () => void; existingPr: { url: string; number: number; state: string } | null }) {
  if (!status) return null
  if (!status.remotes.length) return <div className="git-sync"><div className="git-sync-note">No remote yet. Connect this project to GitHub to push and open pull requests.</div><button className="git-sync-primary" onClick={onConnect}><GitBranch size={13}/> Connect GitHub</button></div>
  const spin = (kind: string) => busy === kind ? <LoaderCircle size={13} className="spin"/> : null
  return <div className="git-sync"><div className="git-sync-buttons">
    <button onClick={() => onSync('pull')} disabled={!!busy} title="Pull (fast-forward only)">{spin('pull') || <ChevronDown size={13}/>}Pull{status.behind ? <i>{status.behind}</i> : null}</button>
    <button onClick={() => onSync('push')} disabled={!!busy} title={status.upstream ? 'Push to ' + status.upstream : 'Publish this branch'}>{spin('push') || <ArrowUp size={13}/>}{status.upstream ? 'Push' : 'Publish'}{status.ahead ? <i>{status.ahead}</i> : null}</button>
    <button onClick={() => onSync('fetch')} disabled={!!busy} title="Fetch from remote">{spin('fetch') || <RefreshCw size={12}/>}Fetch</button>
  </div>
  {existingPr ? <button className="git-sync-primary" onClick={() => void window.nexus.openExternal(existingPr.url)}><GitCompare size={13}/> PR #{existingPr.number} · {existingPr.state.toLowerCase()}</button> : <button className="git-sync-primary" onClick={onPullRequest} disabled={!!busy}><GitCompare size={13}/> Create pull request</button>}
  <div className="git-sync-note">{status.upstream ? `Tracking ${status.upstream}` : 'Branch not published yet'}</div></div>
}
function PullRequestModal({ branch, suggestion, defaultBase, onCreate, onClose }: { branch: string; suggestion: string; defaultBase: string; onCreate: (input: { title: string; body: string; base: string; draft: boolean }) => Promise<void>; onClose: () => void }) {
  const { status } = useGhStatus()
  const [title, setTitle] = useState(suggestion || branch)
  const [body, setBody] = useState('')
  const [base, setBase] = useState(defaultBase)
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (!title.trim() || busy) return
    setBusy(true); setError('')
    try { await onCreate({ title, body, base: base.trim(), draft }) } catch (caught) { setError(errorMessage(caught)); setBusy(false) }
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="new-item-modal pr-modal" onClick={event => event.stopPropagation()}>
    <div className="modal-title"><b>Create pull request</b><button className="bare-icon" onClick={onClose}><X size={15}/></button></div>
    <div className="pr-branch"><GitBranch size={12}/> {branch}{base ? <> <ChevronRight size={11}/> {base}</> : null}</div>
    {status && !status.authenticated && <div className="modal-error">{ghHint(status)}</div>}
    <label className="modal-label">Title</label>
    <input autoFocus value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void submit() }}/>
    <label className="modal-label" style={{ marginTop: 12 }}>Description</label>
    <textarea className="pr-body" value={body} onChange={event => setBody(event.target.value)} rows={5} placeholder="What does this change and why?"/>
    <label className="modal-label" style={{ marginTop: 12 }}>Base branch (optional)</label>
    <input value={base} onChange={event => setBase(event.target.value)} placeholder="repository default" spellCheck={false}/>
    <label className="modal-check"><input type="checkbox" checked={draft} onChange={event => setDraft(event.target.checked)}/> Open as draft</label>
    {error && <div className="modal-error">{error}</div>}
    <div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!title.trim() || busy} onClick={() => void submit()}>{busy ? 'Pushing & creating…' : 'Push & create PR'}</button></div>
  </div></div>
}
function ConnectGitHubModal({ defaultName, onConnect, onClose }: { defaultName: string; onConnect: (mode: 'url' | 'create', value: string, isPrivate: boolean) => Promise<void>; onClose: () => void }) {
  const { status } = useGhStatus()
  const [mode, setMode] = useState<'create' | 'url'>('create')
  const [name, setName] = useState(defaultName)
  const [url, setUrl] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const value = mode === 'create' ? name.trim() : url.trim()
  async function submit() {
    if (!value || busy) return
    setBusy(true); setError('')
    try { await onConnect(mode, value, isPrivate) } catch (caught) { setError(errorMessage(caught)); setBusy(false) }
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="new-item-modal" onClick={event => event.stopPropagation()}>
    <div className="modal-title"><b>Connect GitHub</b><button className="bare-icon" onClick={onClose}><X size={15}/></button></div>
    <div className="modal-tabs"><button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}><Plus size={14}/> Create new repo</button><button className={mode === 'url' ? 'active' : ''} onClick={() => setMode('url')}><GitBranch size={14}/> Existing repo URL</button></div>
    {mode === 'create' ? <>
      <label className="modal-label">Repository name</label>
      <input autoFocus value={name} onChange={event => setName(event.target.value)} spellCheck={false} onKeyDown={event => { if (event.key === 'Enter') void submit() }}/>
      <label className="modal-check"><input type="checkbox" checked={isPrivate} onChange={event => setIsPrivate(event.target.checked)}/> Private repository</label>
      <div className="pr-hint">{ghHint(status)}. Needs at least one commit; the current branch is pushed after creation.</div>
    </> : <>
      <label className="modal-label">Remote URL</label>
      <input autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/you/repo.git" spellCheck={false} onKeyDown={event => { if (event.key === 'Enter') void submit() }}/>
      <div className="pr-hint">Sets this as "origin". Pushing uses your git credentials (gh auth setup-git, keychain, or SSH key).</div>
    </>}
    {error && <div className="modal-error">{error}</div>}
    <div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!value || busy} onClick={() => void submit()}>{busy ? 'Connecting…' : mode === 'create' ? 'Create & push' : 'Connect'}</button></div>
  </div></div>
}

function Popover({ open, anchor, width = 260, align = 'start', children }: { open: boolean; anchor: HTMLElement | null; width?: number; align?: 'start' | 'end'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const gap = 6, margin = 10
      const popoverWidth = Math.min(width, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(align === 'end' ? rect.right - popoverWidth : rect.left, window.innerWidth - popoverWidth - margin))
      const below = window.innerHeight - rect.bottom - gap - margin
      const above = rect.top - gap - margin
      const height = ref.current?.scrollHeight ?? 0
      setStyle(height > below && above > below
        ? { left, width: popoverWidth, bottom: window.innerHeight - rect.top + gap, maxHeight: above, transformOrigin: `${rect.left + rect.width / 2 - left}px 100%` }
        : { left, width: popoverWidth, top: rect.bottom + gap, maxHeight: below, transformOrigin: `${rect.left + rect.width / 2 - left}px 0` })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchor, width, align, children])
  if (!open || !anchor) return null
  return createPortal(<div ref={ref} className="popover popover-zone" style={style} onClick={event => event.stopPropagation()}>{children}</div>, document.body)
}

const branchNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
function BranchPopover({ open, anchor, branches, current, onCheckout, onCreate }: { open: boolean; anchor: HTMLElement | null; branches: string[]; current?: string; onCheckout: (branch: string) => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  useEffect(() => { if (!open) setName('') }, [open])
  const trimmed = name.trim()
  const valid = branchNamePattern.test(trimmed) && !trimmed.includes('..') && !branches.includes(trimmed)
  return <Popover open={open} anchor={anchor} width={290}>
    <div className="popover-title">SWITCH BRANCH</div>
    <div className="branch-list">{branches.map(branch => <button key={branch} className="branch-item" onClick={() => onCheckout(branch)}><GitBranch size={13}/><span>{branch}</span>{branch === current && <Check size={13}/>}</button>)}{!branches.length && <div className="popover-empty">No branches found. Initialize Git or make a first commit.</div>}</div>
    <div className="branch-create"><Plus size={13}/><input value={name} onChange={event => setName(event.target.value)} placeholder="New branch name…" spellCheck={false} onKeyDown={event => { if (event.key === 'Enter' && valid) onCreate(trimmed) }}/><button disabled={!valid} onClick={() => onCreate(trimmed)}>Create</button></div>
  </Popover>
}

function NewProjectModal({ defaultParent, onPick, onCreate, onClose }: { defaultParent: string; onPick: () => Promise<string | null>; onCreate: (parent: string, name: string, initGit: boolean) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState(defaultParent)
  const [initGit, setInitGit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (!name.trim() || !parent || busy) return
    setBusy(true); setError('')
    try { await onCreate(parent, name.trim(), initGit) } catch (caught) { setError(errorMessage(caught).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); setBusy(false) }
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="new-item-modal" onClick={event => event.stopPropagation()}>
    <div className="modal-title"><b>New project</b><button className="bare-icon" onClick={onClose}><X size={15}/></button></div>
    <label className="modal-label" style={{ marginTop: 16 }}>Project name</label>
    <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="my-new-project" spellCheck={false} onKeyDown={event => { if (event.key === 'Enter') void submit() }}/>
    <label className="modal-label" style={{ marginTop: 12 }}>Location</label>
    <div className="location-row"><span title={parent}>{parent || 'Choose a folder…'}</span><button className="secondary-button" onClick={() => void onPick().then(value => { if (value) setParent(value) })}>Choose…</button></div>
    <label className="modal-check"><input type="checkbox" checked={initGit} onChange={event => setInitGit(event.target.checked)}/> Initialize a Git repository</label>
    {error && <div className="modal-error">{error}</div>}
    <div className="modal-footer"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!name.trim() || !parent || busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create project'}</button></div>
  </div></div>
}

function UsageStrip({ open, onToggle, agents, messages, all, limits }: { open: boolean; onToggle: () => void; agents: AgentId[]; messages: Message[]; all: Conversation[]; limits: Partial<Record<AgentId, RateLimit>> }) {
  const allMessages = useMemo(() => all.flatMap(item => item.messages), [all])
  const chatTotal = agents.reduce((total, agent) => total + sumUsage(messages, agent).total, 0)
  return <div className="usage-strip"><button className="usage-toggle" onClick={onToggle}><Zap size={11}/><span>TOKEN USAGE</span><b>{fmtTokens(chatTotal)} this chat</b><ChevronDown size={12} className={open ? '' : 'usage-closed'}/></button>
    {open && <div className="usage-rows">{agents.map(id => {
      const agent = agentCatalog.find(item => item.id === id)!
      const chat = sumUsage(messages, id), total = sumUsage(allMessages, id)
      const limit = limitLabel(limits[id])
      return <div className="usage-row" key={id}><span className="agent-mark" style={{ color: agent.color, borderColor: `${agent.color}4a`, background: `${agent.color}12` }}>{agent.mark}</span><div><b>{agent.label}</b><span>{chat.runs ? `Chat: ${fmtTokens(chat.input)} in · ${fmtTokens(chat.output)} out` : 'Chat: no usage yet'} · All: {fmtTokens(total.total)}{total.cost ? ` · $${total.cost.toFixed(2)}` : ''}</span>{limit && <span className="usage-limit">{limit}</span>}</div></div>
    })}</div>}
  </div>
}

function errorMessage(error: unknown) { return (error instanceof Error ? error.message : String(error || 'Unexpected error.')).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }

export default App
