import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, clipboard } from 'electron';
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
import { runCopierScan, startCopierSchedule } from './copierScanner';
import { openTerminal, runInventoryScript, runOpenScript } from './terminalInventory';
import { dispatch, keptSenderSetPath, openPositionsIn, runAttachScript, runSetInputScript, setLotFromInput, startCommandPoller } from './copierCommands';

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
  private stopCopierSchedule: (() => void) | null = null;
  private stopCommandPoller: (() => void) | null = null;
  /** Scans and lot changes both drive MT4/MT5 dialogs, so they run one after another. */
  private commandsReceivedAt = 0;
  private openRescan: NodeJS.Timeout | null = null;
  private copierQueue: Promise<unknown> = Promise.resolve();
  private registrationRetryTimeout: NodeJS.Timeout | null = null;
  /** Drives the staleness alarm and the tray colour. */
  private healthInterval: NodeJS.Timeout | null = null;
  /** Attention ids already notified, so one outage rings once, not every tick. */
  private notified = new Set<string>();
  /** Newest release the updater has seen, for the Health screen's build rows. */
  private latestVersion: string | null = null;
  private lastUpdateCheck: number | null = null;

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
        machineName: '',
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
      this.store.get('symbolMap') as SymbolMap,
      app.getVersion()
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
    this.startHealthMonitor();
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
          hostname: this.machineLabel(),
          platform: os.platform(),
          arch: os.arch(),
          version: os.release(),
          user: os.userInfo().username,
          uptime: os.uptime()
        };

        // app.getVersion() reads package.json at build time. This used to be
        // the literal '1.0.0', so every watcher on every PC reported the same
        // version regardless of what was installed — which made the fleet's
        // real versions unknowable and sent one investigation down a dead end.
        const registered = await this.apiClient.registerWatcher(this.watcherId, app.getVersion(), systemInfo);
        if (registered) {
          this.logger.info(`Watcher registered successfully with persistent ID: ${this.watcherId} on ${systemInfo.hostname}`);
          // Pull latest user symbol map so suffix/alias rules are fresh.
          await this.refreshSymbolMap();
          this.startHeartbeat();
          this.startCopierScans();
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

  /**
   * Copier management: 10 minutes after start (after the delayed terminal launcher settles), then daily, scan the
   * running MT4/MT5 terminals' copier settings and post them. Started once per process;
   * re-registration reuses it, since each run reads the current API client and label.
   */
  private startCopierScans(): void {
    if (this.stopCopierSchedule || process.platform !== 'win32') return;
    this.stopCopierSchedule = startCopierSchedule(() => this.copierScan(), 600_000);
    this.logger.info('Copier scan scheduled');
    // Not in the copier queue: it opens no window, and must keep reporting while a scan runs.
    startCopierSchedule(() => this.postTerminals(), 15_000, 60_000);
    this.startCommandPoller();
  }

  private copierScript(name: string): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'scripts', name)
      : path.join(__dirname, '..', 'scripts', name);
  }

  private copierExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.copierQueue.then(fn, fn);
    this.copierQueue = next.catch(() => undefined);
    return next;
  }

  private async postTerminals(): Promise<void> {
    try {
      const terminals = await runInventoryScript(this.copierScript('terminal-inventory.ps1'));
      await this.apiClient.postTerminals(this.watcherId, this.machineLabel(), terminals);
    } catch (error) {
      this.logger.debug(`Terminal inventory failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private copierScan(): Promise<void> {
    return this.copierExclusive(async () => {
      try {
        const endpoints = await runCopierScan(this.copierScript('copier-scan.ps1'), this.watcherId, this.machineLabel());
        const ok = await this.apiClient.postCopierScan(this.watcherId, endpoints);
        if (ok) this.logger.info(`Copier scan: ${endpoints.length} endpoints posted`);
        else this.logger.warn(`Copier scan: ${endpoints.length} endpoints found, post failed`);
      } catch (error) {
        this.logger.error(`Copier scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Dashboard commands (set receiver lot, rename, repair, rescan): polled every 5s, run one at a time, never retried. */
  private startCommandPoller(): void {
    if (this.stopCommandPoller) return;
    this.stopCommandPoller = startCommandPoller(
      async () => {
        const cmds = await this.apiClient.fetchCommands(this.watcherId);
        this.commandsReceivedAt = Date.now(); // this PC's clock; the next fetch waits for the whole batch
        return cmds;
      },
      async cmd => {
        const t0 = Date.now();
        const receivedAt = this.commandsReceivedAt;
        if (cmd.type === 'openTerminal' && this.openRescan) clearTimeout(this.openRescan);
        this.logger.info(`Command ${cmd.id} ${cmd.type} started`);
        await dispatch(cmd, {
          openPositions: async (login, ignore) => openPositionsIn(this.store.get('watchFolders') as string[], login, Date.now(), ignore),
          runSetLot: (channel, lot) => this.copierExclusive(() => runSetInputScript(this.copierScript('copier-set-input.ps1'),
            { role: 'receiver', channel, set: { UseFixedLotSize: lot.toFixed(2) } }).then(setLotFromInput)),
          runSetInput: args => this.copierExclusive(() => runSetInputScript(this.copierScript('copier-set-input.ps1'), args)),
          runAttach: args => this.copierExclusive(() => runAttachScript(this.copierScript('copier-attach.ps1'), args)),
          runOpenTerminal: login => this.copierExclusive(() => openTerminal(login, {
            inventory: () => runInventoryScript(this.copierScript('terminal-inventory.ps1')),
            start: (exe, l) => runOpenScript(this.copierScript('open-terminal.ps1'), exe, l),
            post: () => this.postTerminals(),
            expired: () => Date.now() - receivedAt > 90_000,
          })),
          wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
          keptSenderSet: login => keptSenderSetPath(login),
          // After an open, scan once things settle: the terminal is still loading its EAs, and a scan
          // (minutes) queued now would hold up the next terminal being opened.
          rescan: async () => {
            if (cmd.type !== 'openTerminal') return this.copierScan();
            if (this.openRescan) clearTimeout(this.openRescan);
            this.openRescan = setTimeout(() => void this.copierScan(), 20_000);
          },
          postResult: async (id, body) => {
            this.logger.info(`Command ${id} ${cmd.type} ${body.status}${body.error ? `: ${body.error}` : ''} in ${Date.now() - t0}ms`);
            return this.apiClient.postCommandResult(id, this.watcherId, body);
          },
        });
      },
    );
    this.logger.info('Copier command poller started');
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
          this.stopHealthMonitor();
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

  /** Operator-chosen label for this PC, falling back to the hostname. */
  private machineLabel(): string {
    const name = (this.store.get('machineName') as string | undefined)?.trim();
    return name && name.length > 0 ? name : os.hostname();
  }

  /**
   * Polls account health once a minute: raises a desktop notification the
   * first time an account goes stale, and keeps the tray tooltip current so
   * trouble is visible without opening the window.
   *
   * Notifications are keyed by attention id and cleared when the condition
   * resolves, so a terminal that is off overnight rings once rather than
   * hourly, and rings again if it fails a second time tomorrow.
   */
  private startHealthMonitor(): void {
    if (this.healthInterval) return;
    const tick = () => {
      try {
        const { open } = this.fileWatcher.getAttention();
        const openIds = new Set(open.map(i => i.id));
        for (const id of [...this.notified]) {
          if (!openIds.has(id)) this.notified.delete(id);
        }

        // A stopped watcher makes every feed go stale by definition. Ringing
        // about that would be the app complaining about something the
        // operator just did on purpose.
        if (this.store.get('notifications') && this.fileWatcher.isRunning()) {
          for (const item of open) {
            if (this.notified.has(item.id)) continue;
            this.notified.add(item.id);
            if (Notification.isSupported()) {
              new Notification({ title: item.title, body: item.detail }).show();
            }
          }
        }

        this.updateTrayHealth();
      } catch (error) {
        this.logger.debug(`Health monitor tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.healthInterval = setInterval(tick, 60 * 1000);
    tick();
  }

  private stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * The window spends its life minimised, so the tray carries the summary.
   * Only one icon ships, so the state is written into the tooltip (and the
   * title, on platforms that show one) rather than faked with a tinted image.
   */
  private updateTrayHealth(): void {
    if (!this.tray) return;
    try {
      const health = this.fileWatcher.getAccountHealth();
      const { feeding, total } = { feeding: health.filter(a => a.status === 'live').length, total: health.length };
      const bad = health.filter(a => a.status === 'down' || a.status === 'unmatched').length;
      const stale = health.filter(a => a.status === 'stale').length;

      const mark = bad > 0 ? '\u25cf' : stale > 0 ? '\u25d0' : '\u25cb';
      const state = !this.fileWatcher.isRunning()
        ? 'Stopped'
        : bad > 0
          ? `${bad} account${bad === 1 ? '' : 's'} down`
          : stale > 0
            ? `${stale} account${stale === 1 ? '' : 's'} stale`
            : 'All feeds current';

      this.tray.setToolTip(`PropFirm Trade Watcher — ${this.machineLabel()}\n${state} (${feeding}/${total} feeding)`);
      if (process.platform === 'darwin') this.tray.setTitle(total > 0 ? `${mark}` : '');
    } catch {
      // A tray label is never worth throwing over.
    }
  }

  /**
   * Everything a support conversation needs, in one paste: versions, settings
   * with the key redacted, feed health, endpoint health and recent logs.
   */
  private buildDiagnosticBundle(): string {
    const redact = (k: string) => (k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k ? '(set)' : '(none)');
    const health = this.fileWatcher.getAccountHealth();
    const endpoints = this.apiClient.getEndpointStats();
    const stats = this.fileWatcher.getStats();

    const lines: string[] = [];
    lines.push('=== PropFirm Trade Watcher diagnostics ===');
    lines.push(`generated   ${new Date().toISOString()}`);
    lines.push(`version     ${app.getVersion()}${this.latestVersion ? ` (latest ${this.latestVersion})` : ''}`);
    lines.push(`electron    ${process.versions.electron}  node ${process.versions.node}`);
    lines.push(`machine     ${this.machineLabel()}  ${os.platform()} ${os.release()} ${os.arch()}`);
    lines.push(`watcherId   ${this.watcherId}`);
    lines.push(`apiUrl      ${this.store.get('apiUrl')}`);
    lines.push(`apiKey      ${redact(this.store.get('apiKey') as string)}`);
    lines.push(`folders     ${(this.store.get('watchFolders') as string[]).join(', ')}`);
    lines.push(`running     ${this.fileWatcher.isRunning()}`);
    lines.push('');
    lines.push(`--- stats ---`);
    lines.push(
      `files ${stats.filesProcessed}  closed ${stats.tradesImported}  open ${stats.openTradesImported}  ` +
      `errors ${stats.errors}  truncated ${stats.truncatedFiles}  brokerTimeRejections ${stats.brokerTimeRejections}`
    );
    lines.push('');
    lines.push('--- accounts ---');
    for (const a of health) {
      const feeds = a.feeds.map(f => `${f.kind}=${formatAgeShort(f.age)}`).join(' ');
      lines.push(`${a.accountNumber.padEnd(12)} ${a.status.padEnd(9)} ${feeds}  ${a.accountName ?? '(unlinked)'}  ${a.reason}`);
    }
    lines.push('');
    lines.push('--- endpoints (24h) ---');
    for (const e of endpoints) {
      lines.push(
        `${e.path.padEnd(34)} calls=${String(e.calls24h).padStart(6)} fails=${String(e.fails24h).padStart(4)} ` +
        `lastOk=${formatAgeShort(e.lastOkAt === null ? null : Date.now() - e.lastOkAt)}` +
        `${e.neverCalled ? '  NEVER CALLED' : ''}${e.lastError ? `  lastError=${e.lastError}` : ''}`
      );
    }
    lines.push('');
    lines.push('--- recent logs ---');
    for (const l of this.logger.getRecentLogs(200)) {
      lines.push(typeof l === 'string' ? l : JSON.stringify(l));
    }
    return lines.join('\n');
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
        machineName: this.store.get('machineName'),
        isWatching: this.fileWatcher.isRunning(),
        watcherId: this.watcherId, // Include persistent watcher ID
        appVersion: app.getVersion(),
        defaultWatchFolder: getDefaultWatchFolder()
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
      this.store.set('machineName', settings.machineName ?? '');

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

    ipcMain.handle('get-symbols-seen', () => {
      return this.apiClient.getSymbolsSeen();
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
        this.lastUpdateCheck = Date.now();
        if (result?.updateInfo?.version) this.latestVersion = result.updateInfo.version;
        return { success: true, updateInfo: result?.updateInfo };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // --- Live screen -------------------------------------------------------

    ipcMain.handle('get-account-health', () => {
      return this.fileWatcher.getAccountHealth();
    });

    // --- Health screen -----------------------------------------------------

    ipcMain.handle('get-endpoint-stats', () => {
      return this.apiClient.getEndpointStats();
    });

    ipcMain.handle('get-build-info', () => {
      return {
        running: app.getVersion(),
        latest: this.latestVersion,
        lastCheckedAt: this.lastUpdateCheck,
        electron: process.versions.electron,
        node: process.versions.node,
        machine: this.machineLabel(),
        watcherId: this.watcherId,
        cachedAccounts: this.apiClient.accountCacheSize()
      };
    });

    // --- Attention screen --------------------------------------------------

    ipcMain.handle('get-attention', () => {
      return this.fileWatcher.getAttention();
    });

    ipcMain.handle('resolve-attention', (_, id: string) => {
      return { success: this.fileWatcher.resolveAttention(id) };
    });

    ipcMain.handle('mute-attention', (_, id: string, ms: number) => {
      this.fileWatcher.muteAttention(id, ms);
      return { success: true };
    });

    /**
     * The operator created or linked the account in the web app; drop the
     * cached miss and replay everything held while it was unlinked.
     */
    ipcMain.handle('relink-account', async (_, accountNumber: string) => {
      try {
        const replayed = this.fileWatcher.replayHeldFiles(accountNumber);
        return { success: true, replayed };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle('open-folder', async (_, folder: string) => {
      await shell.openPath(folder);
      return { success: true };
    });

    // --- Queue -------------------------------------------------------------

    ipcMain.handle('get-queue', () => {
      return this.fileWatcher.getQueue();
    });

    // --- Diagnostics -------------------------------------------------------

    ipcMain.handle('copy-diagnostics', () => {
      try {
        clipboard.writeText(this.buildDiagnosticBundle());
        return { success: true };
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
      if (info?.version) this.latestVersion = info.version;
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
    autoUpdater.on('update-not-available', (info: { version?: string }) => {
      // No newer build exists, so the running version IS the latest — the
      // Health screen needs that stated, not left blank.
      this.latestVersion = info?.version ?? app.getVersion();
      this.lastUpdateCheck = Date.now();
    });

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

/** Compact age for the diagnostic bundle's fixed-width columns. */
function formatAgeShort(ms: number | null): string {
  if (ms === null) return 'never';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}
