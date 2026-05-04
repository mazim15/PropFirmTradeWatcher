import { contextBridge, ipcRenderer } from 'electron';

// Define the API that will be exposed to the renderer process
export interface WatcherAPI {
  // Settings management
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<any>;
  
  // File watcher control
  startWatching: () => Promise<any>;
  stopWatching: () => Promise<any>;
  
  // Utility functions
  selectFolder: () => Promise<any>;
  testApi: (apiUrl: string, apiKey: string) => Promise<any>;
  
  // Monitoring
  getLogs: () => Promise<any>;
  getStats: () => Promise<any>;
  
  // Watcher management
  registerWatcher: () => Promise<any>;

  // Symbol map
  getSymbolMap: () => Promise<any>;
  saveSymbolMap: (map: any) => Promise<any>;

  // Updates
  checkForUpdates: () => Promise<any>;

  // Event listeners
  onShowSettings: (callback: () => void) => void;
  onWatcherStatus: (callback: (status: any) => void) => void;
  onUpdateAvailable: (callback: (info: any) => void) => void;
  onUpdateDownloaded: (callback: (info: any) => void) => void;
}

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('watcherAPI', {
  // Settings management
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  
  // File watcher control
  startWatching: () => ipcRenderer.invoke('start-watching'),
  stopWatching: () => ipcRenderer.invoke('stop-watching'),
  
  // Utility functions
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  testApi: (apiUrl: string, apiKey: string) => ipcRenderer.invoke('test-api', apiUrl, apiKey),
  
  // Monitoring
  getLogs: () => ipcRenderer.invoke('get-logs'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  
  // Watcher management
  registerWatcher: () => ipcRenderer.invoke('register-watcher'),

  // Symbol map
  getSymbolMap: () => ipcRenderer.invoke('get-symbol-map'),
  saveSymbolMap: (map: any) => ipcRenderer.invoke('save-symbol-map', map),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // Event listeners
  onShowSettings: (callback: () => void) => {
    ipcRenderer.on('show-settings', callback);
  },
  onWatcherStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('watcher-status', (_, status) => callback(status));
  },
  onUpdateAvailable: (callback: (info: any) => void) => {
    ipcRenderer.on('update-available', (_, info) => callback(info));
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    ipcRenderer.on('update-downloaded', (_, info) => callback(info));
  },

  // Remove event listeners
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('show-settings');
    ipcRenderer.removeAllListeners('watcher-status');
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.removeAllListeners('update-downloaded');
  }
} as WatcherAPI);

// Also expose some utility functions
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron
});