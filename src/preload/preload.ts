import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  analyze: (days: number) => ipcRenderer.invoke('analyze', days),
  coach: () => ipcRenderer.invoke('coach'),
  copy: (text: string) => ipcRenderer.invoke('copy', text),
  history: () => ipcRenderer.invoke('history'),
  snapshot: (date: string) => ipcRenderer.invoke('snapshot', date),
  onProgress: (cb: (p: unknown) => void) => {
    ipcRenderer.on('progress', (_e, p) => cb(p));
  },
});
