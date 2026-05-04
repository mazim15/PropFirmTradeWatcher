import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import Store from 'electron-store';
import { autoUpdater } from 'electron-updater';
import { FileWatcher } from './fileWatcher';
import { ApiClient } from './apiClient';
import { Logger, LogLevel } from './logger';
import { SymbolMap } from './symbolNormaliser';

// Resolves the platform-appropriate default watch folder. The MT4/MT5 EAs
// write to the terminal common folder (FILE_COMMON), which on Windows is
// %APPDATA%\MetaQuotes\Terminal\Common\Files.
function getDefaultWatchFolder(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'MetaQuotes', 'Terminal', 'Common', 'Files');
  }
  // Other platforms (rare for MT4/5): user must configure manually.
  return path.join(os.homedir(), 'MetaQuotes', 'Terminal', 'Common', 'Files');
}

class TradeWatcherApp {
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private fileWatcher: FileWatcher;
  private apiClient: ApiClient;
  private logger: Logger;
  private store: Store<Record<string, unknown>>;
  private watcherId: string = '';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private registrationRetryTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.store = new Store<Record<string, unknown>>({
      defaults: {
        watchFolders: [getDefaultWatchFolder()],
        apiUrl: 'http://localhost:3000',
        apiKey: '',
        autoStart: false,
        notifications: true,
        logLevel: 'info',
        watcherId: '',
        symbolMap: {} as SymbolMap
      }
    });

    this.logger = new Logger(this.store.get('logLevel', 'info') as LogLevel);

    // Generate or retrieve persistent watcher ID
    this.watcherId = this.getOrGenerateWatcherId();

    // Initialize API client with stored settings
    this.apiClient = new ApiClient(
      this.store.get('apiUrl') as string,
      this.store.get('apiKey') as string,
      this.logger,
      this.store.get('symbolMap') as SymbolMap
    );
    this.fileWatcher = new FileWatcher(this.apiClient, this.logger, this.store);
  }

  private getOrGenerateWatcherId(): string {
    // Check if we already have a stored watcher ID
    const storedId = this.store.get('watcherId') as string;
    if (storedId && storedId.length > 0) {
      return storedId;
    }

    // Generate a new persistent watcher ID based on machine identity
    const machineId = [
      os.hostname(),
      os.userInfo().username,
      os.arch(),
      os.platform(),
      process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'
    ].join('-');

    // Create a hash to ensure consistent length and format
    const hash = crypto.createHash('md5').update(machineId).digest('hex');
    const newWatcherId = `watcher-${hash.substring(0, 16)}`;

    // Store the generated ID for future use
    this.store.set('watcherId', newWatcherId);
    
    this.logger.info(`Generated new persistent watcher ID: ${newWatcherId}`);
    return newWatcherId;
  }

  public async initialize(): Promise<void> {
    await app.whenReady();
    
    this.createTray();
    this.createWindow();
    this.setupIpcHandlers();
    
    // Log startup settings for debugging
    const apiKey = this.store.get('apiKey') as string;
    const apiUrl = this.store.get('apiUrl') as string;
    this.logger.info(`Starting up with API URL: ${apiUrl}, API Key: ${apiKey ? 'configured' : 'not configured'}`);
    
    // Try to register this watcher instance with the web app if API key is configured
    if (apiKey && apiKey.trim().length > 0) {
      this.logger.info('API key found on startup, attempting automatic registration...');
      await this.attemptWatcherRegistration();
    } else {
      this.logger.info('No API key configured on startup. Registration will be attempted when API key is configured.');
    }
    
    // Start file watching if auto-start is enabled
    if (this.store.get('autoStart')) {
      this.logger.info('Auto-start enabled, starting file watcher...');
      this.fileWatcher.start();
    }

    // Enable auto-start on system boot
    this.setupAutoStart();

    // Wire up electron-updater (no-op if offline / unsigned dev build).
    this.setupAutoUpdater();

    this.logger.info('PropFirm Trade Watcher initialized');
  }

  private async attemptWatcherRegistration(): Promise<void> {
    const apiKey = this.store.get('apiKey') as string;
    const apiUrl = this.store.get('apiUrl') as string;

    // Cancel any running heartbeat / pending retry — settings may have
    // changed and we're about to redo this from scratch.
    this.stopHeartbeat();
    if (this.registrationRetryTimeout) {
      clearTimeout(this.registrationRetryTimeout);
      this.registrationRetryTimeout = null;
    }

    // Check if API key is configured
    if (!apiKey || apiKey.trim().length === 0) {
      this.logger.warn('No API key configured. Watcher registration skipped. Please configure API key in settings.');
      return;
    }

    if (!apiUrl || apiUrl.trim().length === 0) {
      this.logger.warn('No API URL configured. Watcher registration skipped. Please configure API URL in settings.');
      return;
    }

    let succeeded = false;
    try {
      // Update API client with current settings before testing
      this.apiClient.updateConfig(apiUrl, apiKey);

      // Test API connection first
      const testResult = await this.apiClient.testConnection();
      if (!testResult.success) {
        this.logger.warn(`API connection test failed: ${testResult.error}. Watcher registration skipped.`);
      } else {
        const systemInfo = {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          version: os.release(),
          user: os.userInfo().username,
          uptime: os.uptime()
        };

        const registered = await this.apiClient.registerWatcher(this.watcherId, '1.0.0', systemInfo);
        if (registered) {
          this.logger.info(`Watcher registered successfully with persistent ID: ${this.watcherId} on ${systemInfo.hostname}`);
          // Pull latest user symbol map so suffix/alias rules are fresh.
          await this.refreshSymbolMap();
          this.startHeartbeat();
          succeeded = true;
        } else {
          this.logger.error('Failed to register watcher with web app.');
        }
      }
    } catch (error) {
      this.logger.error(`Error during watcher registration: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!succeeded) {
      // One automatic retry after 60s. If the user changes settings in the
      // meantime, save-settings calls this again and the timeout above is
      // cleared at the top of this method.
      this.registrationRetryTimeout = setTimeout(() => {
        this.registrationRetryTimeout = null;
        this.logger.info('Retrying watcher registration after earlier failure...');
        this.attemptWatcherRegistration();
      }, 60 * 1000);
    }
  }

  private setupAutoStart(): void {
    const enabled = Boolean(this.store.get('autoStart'));
    try {
      if (process.platform === 'win32') {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          path: process.execPath,
          args: ['--hidden']
        });
      } else if (process.platform === 'darwin') {
        app.setLoginItemSettings({ openAtLogin: enabled });
      }
      this.logger.info(`Auto-start ${enabled ? 'enabled' : 'disabled'} for ${process.platform}`);
    } catch (error) {
      this.logger.warn(`Failed to setup auto-start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startHeartbeat(): void {
    // Send heartbeat every 5 minutes to keep connection alive, and refresh
    // the symbol map on the same cadence so suffix-rule updates land.
    this.heartbeatInterval = setInterval(async () => {
      try {
        const stats = this.fileWatcher.getStats();
        const success = await this.apiClient.sendHeartbeat(this.watcherId, {
          ...stats,
          keyName: this.apiClient.getKeyName(),
          timestamp: new Date().toISOString()
        });

        if (success) {
          this.logger.debug('Heartbeat sent successfully');
        } else {
          this.logger.warn('Heartbeat failed');
        }

        await this.refreshSymbolMap();
      } catch (error) {
        this.logger.error(`Heartbeat error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 5 * 60 * 1000); // 5 minutes

    this.logger.info('Heartbeat system started');
  }

  private async refreshSymbolMap(): Promise<void> {
    try {
      const fresh = await this.apiClient.fetchSymbolMap();
      if (fresh) {
        this.store.set('symbolMap', fresh);
        this.apiClient.setSymbolMap(fresh);
        this.logger.debug(`Symbol map refreshed (${Object.keys(fresh).length} canonical entries)`);
      }
    } catch (err) {
      this.logger.debug(`Symbol map refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.info('Heartbeat system stopped');
    }
  }

  private createWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: 800,
      height: 600,
      icon: path.join(__dirname, '../assets/icon.ico'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      },
      show: false, // Start hidden (system tray app)
      title: 'PropFirm Trade Watcher'
    });

    // Load the HTML file
    this.mainWindow.loadFile(path.join(__dirname, '../assets/index.html'));

    // Handle window closed
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Hide to tray instead of closing
    this.mainWindow.on('close', (event) => {
      if (!(app as any).isQuitting) {
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });
  }

  private createTray(): void {
    const iconPath = path.join(__dirname, '../assets/tray-icon.png');
    this.tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: () => {
          this.mainWindow?.show();
        }
      },
      {
        label: 'Start Watching',
        click: () => {
          this.fileWatcher.start();
        },
        enabled: !this.fileWatcher.isRunning()
      },
      {
        label: 'Stop Watching',
        click: () => {
          this.fileWatcher.stop();
        },
        enabled: this.fileWatcher.isRunning()
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          this.mainWindow?.show();
          this.mainWindow?.webContents.send('show-settings');
        }
      },
      {
        label: 'View Logs',
        click: () => {
          shell.openPath(this.logger.getLogFile());
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          (app as any).isQuitting = true;
          this.stopHeartbeat();
          if (this.registrationRetryTimeout) {
            clearTimeout(this.registrationRetryTimeout);
            this.registrationRetryTimeout = null;
          }
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
    this.tray.setToolTip('PropFirm Trade Watcher');
    
    // Double-click to show window
    this.tray.on('double-click', () => {
      this.mainWindow?.show();
    });
  }

  private setupIpcHandlers(): void {
    // Get current settings
    ipcMain.handle('get-settings', () => {
      return {
        watchFolders: this.store.get('watchFolders'),
        apiUrl: this.store.get('apiUrl'),
        apiKey: this.store.get('apiKey'),
        autoStart: this.store.get('autoStart'),
        notifications: this.store.get('notifications'),
        logLevel: this.store.get('logLevel'),
        isWatching: this.fileWatcher.isRunning(),
        watcherId: this.watcherId // Include persistent watcher ID
      };
    });

    // Save settings
    ipcMain.handle('save-settings', async (_, settings) => {
      const oldApiKey = this.store.get('apiKey') as string;
      const oldApiUrl = this.store.get('apiUrl') as string;
      
      this.logger.info(`Saving settings - Old API Key: ${oldApiKey ? 'exists' : 'none'}, New API Key: ${settings.apiKey ? 'exists' : 'none'}`);
      
      this.store.set('watchFolders', settings.watchFolders);
      this.store.set('apiUrl', settings.apiUrl);
      this.store.set('apiKey', settings.apiKey);
      this.store.set('autoStart', settings.autoStart);
      this.store.set('notifications', settings.notifications);
      this.store.set('logLevel', settings.logLevel);

      // Update API client
      this.apiClient.updateConfig(settings.apiUrl, settings.apiKey);

      // Update logger level
      this.logger.setLevel(settings.logLevel);

      // Apply the auto-start setting (without waiting for next launch).
      this.setupAutoStart();

      // Determine if we need to register the watcher
      const hadApiKey = oldApiKey && oldApiKey.trim().length > 0;
      const hasApiKey = settings.apiKey && settings.apiKey.trim().length > 0;
      const apiSettingsChanged = settings.apiKey !== oldApiKey || settings.apiUrl !== oldApiUrl;
      
      if (hasApiKey && apiSettingsChanged) {
        if (hadApiKey) {
          this.logger.info('API settings changed, attempting watcher re-registration...');
        } else {
          this.logger.info('API key configured for the first time, attempting watcher registration...');
        }
        await this.attemptWatcherRegistration();
      }

      return { success: true };
    });

    // Start file watching
    ipcMain.handle('start-watching', () => {
      try {
        this.fileWatcher.start();
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Stop file watching
    ipcMain.handle('stop-watching', () => {
      try {
        this.fileWatcher.stop();
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Select folder dialog
    ipcMain.handle('select-folder', async () => {
      const result = await dialog.showOpenDialog(this.mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select MT4 Export Folder'
      });

      if (result.canceled) {
        return { success: false };
      }

      return { success: true, path: result.filePaths[0] };
    });

    // Test API connection
    ipcMain.handle('test-api', async (_, apiUrl, apiKey) => {
      try {
        const testClient = new ApiClient(apiUrl, apiKey, this.logger);
        const result = await testClient.testConnection();
        return result;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Get recent logs
    ipcMain.handle('get-logs', () => {
      return this.logger.getRecentLogs(100);
    });

    // Get watcher statistics
    ipcMain.handle('get-stats', () => {
      return this.fileWatcher.getStats();
    });

    // Manual watcher registration
    ipcMain.handle('register-watcher', async () => {
      try {
        await this.attemptWatcherRegistration();
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Symbol map: { canonical: ['variant1', 'variant2'] }
    ipcMain.handle('get-symbol-map', () => {
      return this.store.get('symbolMap') as SymbolMap;
    });

    ipcMain.handle('save-symbol-map', (_, map: SymbolMap) => {
      this.store.set('symbolMap', map);
      this.apiClient.setSymbolMap(map);
      this.logger.info(`Symbol map updated (${Object.keys(map).length} canonical entries)`);
      return { success: true };
    });

    // Manual update check (auto-updater also runs at startup).
    ipcMain.handle('check-for-updates', async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, updateInfo: result?.updateInfo };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  public setupAutoUpdater(): void {
    autoUpdater.logger = {
      info: (m: string) => this.logger.info(`[updater] ${m}`),
      warn: (m: string) => this.logger.warn(`[updater] ${m}`),
      error: (m: string) => this.logger.error(`[updater] ${m}`),
      debug: (m: string) => this.logger.debug(`[updater] ${m}`)
    } as any;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: { version?: string }) => {
      this.logger.info(`Update available: ${info?.version ?? 'unknown'}`);
      this.mainWindow?.webContents.send('update-available', info);
    });

    autoUpdater.on('update-downloaded', (info: { version?: string }) => {
      this.logger.info(`Update downloaded: ${info?.version ?? 'unknown'}. Will install on next quit.`);
      this.mainWindow?.webContents.send('update-downloaded', info);
    });

    autoUpdater.on('error', (err: Error) => {
      this.logger.warn(`Auto-updater error: ${err.message}`);
    });

    // Don't fail startup if check throws (e.g. offline, unsigned dev build).
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      this.logger.debug(`Auto-update check skipped: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// Prevent multiple instances — bail out before constructing the app so a
// second launch doesn't briefly touch the store or open the log file.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  const tradeWatcher = new TradeWatcherApp();

  app.on('ready', () => {
    tradeWatcher.initialize();
  });

  app.on('window-all-closed', () => {
    // Keep app running in system tray
    if (process.platform !== 'darwin') {
      // Don't quit on macOS
    }
  });

  app.on('activate', () => {
    // Re-create window on macOS
    if (BrowserWindow.getAllWindows().length === 0) {
      tradeWatcher.initialize();
    }
  });

  // Handle protocol for potential future deep linking
  app.setAsDefaultProtocolClient('propfirm-watcher');

  app.on('second-instance', () => {
    // Focus the main window if someone tries to run another instance
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].show();
      windows[0].focus();
    }
  });
}