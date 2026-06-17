import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  analyze: (days: number) => ipcRenderer.invoke('analyze', days),
  analyzeCodex: (days: number) => ipcRenderer.invoke('analyzeCodex', days),
  coach: () => ipcRenderer.invoke('coach'),
  copy: (text: string) => ipcRenderer.invoke('copy', text),
  history: () => ipcRenderer.invoke('history'),
  snapshot: (date: string, source: 'claude' | 'codex' = 'claude') => ipcRenderer.invoke('snapshot', date, source),
  rank: () => ipcRenderer.invoke('rank'),
  latestRank: () => ipcRenderer.invoke('latestRank'),
  leaderboard: () => ipcRenderer.invoke('leaderboard'),
  getNickname: () => ipcRenderer.invoke('getNickname'),
  setNickname: (name: string) => ipcRenderer.invoke('setNickname', name),
  chooseClaudeDir: () => ipcRenderer.invoke('chooseClaudeDir'),
  claudeAccess: () => ipcRenderer.invoke('claudeAccess'),
  onProgress: (cb: (p: unknown) => void) => {
    ipcRenderer.on('progress', (_e, p) => cb(p));
  },
});
