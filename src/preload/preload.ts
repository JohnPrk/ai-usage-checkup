import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  analyze: (days: number) => ipcRenderer.invoke('analyze', days),
  analyzeCodex: (days: number) => ipcRenderer.invoke('analyzeCodex', days),
  coach: () => ipcRenderer.invoke('coach'),
  copy: (text: string) => ipcRenderer.invoke('copy', text),
  saveReportPdf: (suggestedName: string, layout?: { width: number; height: number }) =>
    ipcRenderer.invoke('saveReportPdf', suggestedName, layout),
  history: () => ipcRenderer.invoke('history'),
  snapshot: (date: string, source: 'claude' | 'codex' = 'claude') => ipcRenderer.invoke('snapshot', date, source),
  rank: () => ipcRenderer.invoke('rank'),
  latestRank: () => ipcRenderer.invoke('latestRank'),
  leaderboard: (page = 0, source: 'claude' | 'codex' = 'claude') =>
    ipcRenderer.invoke('leaderboard', page, source),
  getNickname: () => ipcRenderer.invoke('getNickname'),
  setNickname: (name: string) => ipcRenderer.invoke('setNickname', name),
  checkNickname: (name: string) => ipcRenderer.invoke('checkNickname', name),
  getRankConsent: () => ipcRenderer.invoke('getRankConsent'),
  setRankConsent: (agree: boolean) => ipcRenderer.invoke('setRankConsent', agree),
  submitCurrent: () => ipcRenderer.invoke('submitCurrent'),
  chooseClaudeDir: () => ipcRenderer.invoke('chooseClaudeDir'),
  chooseCodexDir: () => ipcRenderer.invoke('chooseCodexDir'),
  claudeAccess: () => ipcRenderer.invoke('claudeAccess'),
  access: () => ipcRenderer.invoke('access'),
  onProgress: (cb: (p: unknown) => void) => {
    ipcRenderer.on('progress', (_e, p) => cb(p));
  },
});
