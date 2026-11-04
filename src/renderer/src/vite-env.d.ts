/// <reference types="vite/client" />

type AgentId = 'codex' | 'claude' | 'gemini' | 'copilot'
interface NexusAPI {
  getState(): Promise<{ projects: string[]; conversations: any[]; recentProject?: string; platform: string; version: string; home: string }>
  openProject(): Promise<string | null>
  selectProject(projectPath: string): Promise<boolean>
  pickProjectLocation(): Promise<string | null>
  createProject(input: { parent: string; name: string; initGit?: boolean }): Promise<string>
  removeProject(projectPath: string): Promise<boolean>
  saveConversation(conversation: any): Promise<boolean>
  deleteConversation(id: string): Promise<boolean>
  listFiles(projectPath: string): Promise<any[]>
  readFile(input: { projectPath: string; relativePath: string }): Promise<{ content: string; size: number; relativePath: string }>
  writeFile(input: { projectPath: string; relativePath: string; content: string }): Promise<{ saved: boolean; modifiedAt: number }>
  createFile(input: { projectPath: string; relativePath: string; kind: 'file' | 'directory' }): Promise<boolean>
  deleteFile(input: { projectPath: string; relativePath: string }): Promise<boolean>
  gitStatus(projectPath: string): Promise<any>
  gitFileDiff(input: { projectPath: string; relativePath: string; staged?: boolean }): Promise<{ original: string; modified: string }>
  gitStage(input: { projectPath: string; paths: string[] }): Promise<boolean>
  gitUnstage(input: { projectPath: string; paths: string[] }): Promise<boolean>
  gitCommit(input: { projectPath: string; message: string }): Promise<string>
  gitBranches(projectPath: string): Promise<string[]>
  gitCreateBranch(input: { projectPath: string; branch: string }): Promise<boolean>
  gitCheckout(input: { projectPath: string; branch: string }): Promise<boolean>
  gitPush(input: { projectPath: string }): Promise<string>
  gitPull(input: { projectPath: string }): Promise<string>
  gitFetch(input: { projectPath: string }): Promise<boolean>
  gitAddRemote(input: { projectPath: string; url: string }): Promise<boolean>
  ghStatus(): Promise<{ installed: boolean; authenticated: boolean; user?: string; error?: string }>
  ghCreateRepo(input: { projectPath: string; name: string; isPrivate: boolean }): Promise<string>
  ghCreatePr(input: { projectPath: string; title: string; body?: string; base?: string; draft?: boolean }): Promise<string>
  ghPrView(input: { projectPath: string }): Promise<{ url: string; number: number; state: string; title: string } | null>
  checkAgents(): Promise<{ id: AgentId; installed: boolean; command?: string; error?: string }[]>
  runAgent(input: any): Promise<{ runId: string; pid?: number }>
  stopAgent(runId: string): Promise<boolean>
  createTerminal(input: any): Promise<{ terminalId: string; pid: number }>
  writeTerminal(input: any): Promise<boolean>
  resizeTerminal(input: any): Promise<boolean>
  killTerminal(terminalId: string): Promise<boolean>
  reveal(target: string): Promise<void>
  openExternal(url: string): Promise<void>
  onChunk(callback: (data: { runId: string; text: string }) => void): () => void
  onDone(callback: (data: { runId: string; code: number; error?: string }) => void): () => void
  onActivity(callback: (data: { runId: string; items: { kind: 'thinking' | 'step' | 'note'; text: string; fresh?: boolean }[] }) => void): () => void
  onFinal(callback: (data: { runId: string; text: string }) => void): () => void
  onUsage(callback: (data: { runId: string; agent: string; usage?: any; rateLimit?: any }) => void): () => void
  onStderr(callback: (data: { runId: string; agent: string; text: string }) => void): () => void
  onTerminalData(callback: (data: { terminalId: string; data: string }) => void): () => void
  onTerminalExit(callback: (data: { terminalId: string; exitCode: number; signal?: number }) => void): () => void
}
declare global { interface Window { nexus: NexusAPI } }
export {}
