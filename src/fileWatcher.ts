import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import csv from 'csv-parser';
import { app } from 'electron';
import { ApiClient } from './apiClient';
import { Logger } from './logger';
import Store from 'electron-store';

export interface TradeData {
  ticket: string;
  openTime: string;
  type: string;
  size: number;
  symbol: string;
  openPrice: number;
  stopLoss: number;
  takeProfit: number;
  closeTime: string;
  closePrice: number;
  commission: number;
  swap: number;
  profit: number;
  comment: string;
  magic?: number;
}

export interface OpenTradeData {
  ticket: string;
  openTime: string;
  type: string;
  size: number;
  symbol: string;
  openPrice: number;
  stopLoss: number;
  takeProfit: number;
  currentPrice: number;
  commission: number;
  swap: number;
  unrealizedPnl: number;
  comment: string;
  status: string;
  magic?: number;
}

export interface AccountInfo {
  accountNumber: string;
  accountName: string;
  accountCurrency: string;
  accountBalance: number;
  exportTime: string;
  brokerServerTime?: string;
}

export interface AccountStateData {
  accountNumber: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  profit: number;
  brokerServerTime?: string;
  exportTime?: string;
}

export interface FileWatcherStats {
  filesProcessed: number;
  tradesImported: number;
  openTradesImported: number;
  errors: number;
  lastProcessed: string;
  isRunning: boolean;
  watchedFolders: string[];
  truncatedFiles: number;
  brokerTimeRejections: number;
}

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private isWatchingActive = false;
  private stats: FileWatcherStats;
  private processedFiles = new Set<string>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private recentClosedTrades = new Map<string, any[]>(); // accountId -> recent closed trades
  private recentlyRemovedTrades = new Map<string, {trade: any, removedTime: number}[]>(); // accountId -> recently removed open trades with timestamp
  // Priority: 1=closed trades, 2=open trades, 3=account state.
  private processingQueue: {filePath: string, priority: number, timestamp: number}[] = [];
  private isProcessingQueue = false;
  private queueFilePath: string;

  constructor(
    private apiClient: ApiClient,
    private logger: Logger,
    private store: Store
  ) {
    this.stats = {
      filesProcessed: 0,
      tradesImported: 0,
      openTradesImported: 0,
      errors: 0,
      lastProcessed: '',
      isRunning: false,
      watchedFolders: [],
      truncatedFiles: 0,
      brokerTimeRejections: 0
    };

    // Persistent queue lives next to the log so a crash mid-import doesn't
    // lose pending files (the chokidar in-memory queue would otherwise drop).
    let userDataPath: string;
    try {
      userDataPath = app.getPath('userData');
    } catch {
      userDataPath = process.cwd();
    }
    this.queueFilePath = path.join(userDataPath, 'pending-queue.json');

    this.loadPersistedQueue();
  }

  private loadPersistedQueue(): void {
    try {
      if (!fs.existsSync(this.queueFilePath)) return;
      const raw = fs.readFileSync(this.queueFilePath, 'utf8');
      const items = JSON.parse(raw) as {filePath: string, priority: number, timestamp: number}[];
      const surviving = items.filter(i => fs.existsSync(i.filePath));
      this.processingQueue = surviving;
      this.logger.info(`Restored ${surviving.length} pending file(s) from persisted queue`);
    } catch (error) {
      this.logger.warn(`Failed to load persisted queue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistQueue(): void {
    try {
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.processingQueue), 'utf8');
    } catch (error) {
      this.logger.debug(`Failed to persist queue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public start(): void {
    if (this.isWatchingActive) {
      this.logger.warn('File watcher is already running');
      return;
    }

    const watchFolders = this.store.get('watchFolders') as string[];
    
    if (!watchFolders || watchFolders.length === 0) {
      this.logger.error('No watch folders configured');
      throw new Error('No watch folders configured');
    }

    // Validate folders exist
    const validFolders = watchFolders.filter(folder => {
      if (fs.existsSync(folder)) {
        return true;
      } else {
        this.logger.warn(`Watch folder does not exist: ${folder}`);
        return false;
      }
    });

    if (validFolders.length === 0) {
      throw new Error('No valid watch folders found');
    }

    this.stats.watchedFolders = validFolders;

    // Create file watcher - watch trade, open-trade and account-state files.
    this.watcher = chokidar.watch([
      ...validFolders.map(folder => path.join(folder, 'trades_*.csv')),
      ...validFolders.map(folder => path.join(folder, 'open_trades_*.csv')),
      ...validFolders.map(folder => path.join(folder, 'account_*_state.csv'))
    ], {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true, // Skip existing files on startup - only process new/changed files
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1 second after file stops changing
        pollInterval: 100 // Check every 100ms
      }
    });

    // Mark active immediately so a second start() call is rejected during
    // the brief window before chokidar's 'ready' handler fires.
    this.isWatchingActive = true;
    this.stats.isRunning = true;

    // Set up event handlers
    this.watcher
      .on('add', (filePath) => this.handleFileAdded(filePath))
      .on('change', (filePath) => this.handleFileChanged(filePath))
      .on('error', (error) => this.handleWatchError(error))
      .on('ready', () => {
        this.logger.info(`File watcher started, monitoring ${validFolders.length} folders`);
        this.logger.info(`Watched folders: ${validFolders.join(', ')}`);
      });

    // Start cleanup routine - run every 30 minutes. Owned by start()/stop()
    // so it survives stop/start cycles.
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupOldFiles();
      }, 30 * 60 * 1000);
    }
  }

  public stop(): void {
    if (!this.isWatchingActive || !this.watcher) {
      this.logger.warn('File watcher is not running');
      return;
    }

    this.watcher.close();
    this.watcher = null;
    this.isWatchingActive = false;
    this.stats.isRunning = false;

    // Drain pending work — anything still queued was accepted while watching;
    // the user has now asked us to stop, so don't keep importing.
    this.processingQueue = [];
    this.isProcessingQueue = false;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.logger.info('File watcher stopped');
  }

  public isRunning(): boolean {
    return this.isWatchingActive;
  }

  public getStats(): FileWatcherStats {
    return { ...this.stats };
  }

  private async cleanupOldFiles(): Promise<void> {
    try {
      this.logger.info('Starting cleanup of old export files...');
      
      const watchFolders = this.store.get('watchFolders') as string[];
      if (!watchFolders || watchFolders.length === 0) {
        return;
      }

      let totalDeleted = 0;

      for (const folder of watchFolders) {
        if (!fs.existsSync(folder)) {
          continue;
        }

        const files = fs.readdirSync(folder);
        const oldFiles: string[] = [];

        for (const file of files) {
          const filePath = path.join(folder, file);
          const stat = fs.statSync(filePath);

          // Only process CSV files that match old timestamped pattern
          if (file.endsWith('.csv') && stat.isFile()) {
            // Check if it's an old timestamped file (not the new _latest.csv files)
            const isOldTimestampedFile = /^(trades|open_trades)_\d+_\d{8}_\d{4}\.csv$/i.test(file);
            
            if (isOldTimestampedFile) {
              // Delete files older than 2 hours
              const fileAge = Date.now() - stat.mtime.getTime();
              const twoHours = 2 * 60 * 60 * 1000;
              
              if (fileAge > twoHours) {
                oldFiles.push(filePath);
              }
            }
          }
        }

        // Delete old files
        for (const filePath of oldFiles) {
          try {
            fs.unlinkSync(filePath);
            totalDeleted++;
            this.logger.debug(`Deleted old file: ${path.basename(filePath)}`);
          } catch (deleteError) {
            this.logger.warn(`Failed to delete file ${path.basename(filePath)}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
          }
        }
      }

      if (totalDeleted > 0) {
        this.logger.info(`Cleanup completed: deleted ${totalDeleted} old export files`);
      } else {
        this.logger.debug('Cleanup completed: no old files to delete');
      }
    } catch (error) {
      this.logger.error(`Error during file cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleFileAdded(filePath: string): Promise<void> {
    this.logger.info(`New file detected: ${filePath}`);
    await this.addToProcessingQueue(filePath);
  }

  private async handleFileChanged(filePath: string): Promise<void> {
    this.logger.info(`File changed: ${filePath}`);
    await this.addToProcessingQueue(filePath);
  }

  private handleWatchError(error: Error): void {
    this.logger.error(`File watcher error: ${error.message}`);
    this.stats.errors++;
  }

  private async addToProcessingQueue(filePath: string): Promise<void> {
    // Check if file is a valid MT4/MT5 export
    if (!this.isValidTradeExportFile(filePath)) {
      this.logger.debug(`Skipping non-MT4/MT5 export file: ${path.basename(filePath)}`);
      return;
    }

    // Priority: closed trades (1) > open trades (2) > account state (3).
    const base = path.basename(filePath);
    let priority = 1;
    if (this.isAccountStateFile(filePath)) priority = 3;
    else if (base.startsWith('open_trades_')) priority = 2;

    // Remove any existing entry for this file to prevent duplicates
    this.processingQueue = this.processingQueue.filter(item => item.filePath !== filePath);

    // Add to queue
    this.processingQueue.push({
      filePath,
      priority,
      timestamp: Date.now()
    });

    this.persistQueue();
    this.logger.debug(`Added to processing queue (priority ${priority}): ${base}`);

    // Start processing if not already running
    this.processQueue();
  }

  private isAccountStateFile(filePath: string): boolean {
    return /^account_\d+_state\.csv$/i.test(path.basename(filePath));
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    
    try {
      // Sort queue by priority (1=highest, 2=lowest) then by timestamp (oldest first)
      this.processingQueue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority; // Lower number = higher priority
        }
        return a.timestamp - b.timestamp; // Older files first
      });
      
      // Process files one by one to maintain proper order
      while (this.processingQueue.length > 0) {
        const item = this.processingQueue.shift();
        if (!item) break;

        this.logger.info(`Processing queued file (priority ${item.priority}): ${path.basename(item.filePath)}`);
        await this.processFile(item.filePath);
        this.persistQueue();

        // Small delay between processing to allow for proper sequencing
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      this.logger.error(`Error processing queue: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async processFile(filePath: string): Promise<void> {
    try {
      // Skip if already processed recently
      const fileKey = `${filePath}_${fs.statSync(filePath).mtime.getTime()}`;
      if (this.processedFiles.has(fileKey)) {
        this.logger.debug(`File already processed: ${path.basename(filePath)}`);
        return;
      }

      // Check if file is a valid MT4/MT5 export
      if (!this.isValidTradeExportFile(filePath)) {
        this.logger.debug(`Skipping non-MT4/MT5 export file: ${path.basename(filePath)}`);
        return;
      }

      this.logger.info(`Processing file: ${path.basename(filePath)}`);

      // Route to the right handler based on filename pattern.
      const base = path.basename(filePath);
      if (this.isAccountStateFile(filePath)) {
        await this.processAccountStateFile(filePath);
      } else if (base.startsWith('open_trades_')) {
        await this.processOpenTradesFile(filePath);
      } else {
        await this.processClosedTradesFile(filePath);
      }

      // Mark file as processed
      this.processedFiles.add(fileKey);
      this.stats.filesProcessed++;
      this.stats.lastProcessed = new Date().toISOString();

      // Clean up old processed file references (keep last 1000)
      if (this.processedFiles.size > 1000) {
        const keysToDelete = Array.from(this.processedFiles).slice(0, 500);
        keysToDelete.forEach(key => this.processedFiles.delete(key));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing file ${path.basename(filePath)}: ${errorMessage}`);
      this.stats.errors++;
    }
  }

  private async processClosedTradesFile(filePath: string): Promise<void> {
    // Parse CSV file for closed trades (existing logic)
    const { accountInfo, trades } = await this.parseCSVFile(filePath);

    if (!accountInfo) {
      this.logger.error(`Could not extract account info from: ${path.basename(filePath)}`);
      return;
    }

    if (trades.length === 0) {
      this.logger.info(`No trades found in: ${path.basename(filePath)}`);
      return;
    }

    // Find matching account in web app
    const matchedAccount = await this.apiClient.findAccountByNumber(accountInfo.accountNumber);
    
    if (!matchedAccount) {
      this.logger.warn(`No matching account found for: ${accountInfo.accountNumber}`);
      return;
    }

    // Check for duplicate trades
    const newTrades = await this.apiClient.filterNewTrades(matchedAccount.id, trades);
    
    if (newTrades.length === 0) {
      this.logger.info(`All trades already exist for account: ${accountInfo.accountNumber}`);
    } else {
      // Import new trades
      const importResult = await this.apiClient.importTrades(matchedAccount.id, newTrades);
      
      if (importResult.success) {
        this.logger.info(`Imported ${importResult.importedCount} trades for account: ${accountInfo.accountNumber}`);
        this.stats.tradesImported += importResult.importedCount || 0;
      } else {
        this.logger.error(`Failed to import trades: ${importResult.error}`);
        this.stats.errors++;
      }
    }

    // Store recent closed trades for this account to help with auto-closure timing
    const recentTrades = trades.map(trade => ({
      ticketNumber: trade.ticket,
      exitTime: trade.closeTime,
      exitPrice: trade.closePrice,
      netPnl: trade.profit
    }));
    
    this.recentClosedTrades.set(matchedAccount.id, recentTrades);
    
    // Check for recently removed open trades and update them with actual closed data
    await this.updateRecentlyRemovedTradesWithClosedData(matchedAccount.id, recentTrades);
    
    // Clean up old entries (keep only last 50 trades per account)
    const maxTrades = 50;
    if (recentTrades.length > maxTrades) {
      this.recentClosedTrades.set(matchedAccount.id, recentTrades.slice(-maxTrades));
    }
  }

  private async updateRecentlyRemovedTradesWithClosedData(accountId: string, closedTrades: any[]): Promise<void> {
    const removedTrades = this.recentlyRemovedTrades.get(accountId);
    if (!removedTrades || removedTrades.length === 0) {
      return;
    }

    this.logger.info(`Checking ${removedTrades.length} recently removed trades against ${closedTrades.length} new closed trades for account ${accountId}`);

    for (const closedTrade of closedTrades) {
      const matchingRemovedIndex = removedTrades.findIndex(
        rt => rt.trade.ticketNumber === closedTrade.ticketNumber
      );

      if (matchingRemovedIndex !== -1) {
        const removedTrade = removedTrades[matchingRemovedIndex];
        this.logger.info(`Found match! Updating trade ${closedTrade.ticketNumber} with actual closed data: exitPrice=${closedTrade.exitPrice}, netPnl=${closedTrade.netPnl}`);
        
        // Call API to update the trade with actual closed data
        try {
          const response = await this.apiClient.updateTradeWithClosedData(
            accountId,
            closedTrade.ticketNumber,
            {
              exitPrice: closedTrade.exitPrice,
              exitTime: closedTrade.exitTime,
              netPnl: closedTrade.netPnl,
              status: 'Closed'
            }
          );
          
          if (response.success) {
            this.logger.info(`Successfully updated trade ${closedTrade.ticketNumber} with actual closed data`);
            // Remove from recently removed trades since it's now properly closed
            removedTrades.splice(matchingRemovedIndex, 1);
          } else {
            this.logger.error(`Failed to update trade ${closedTrade.ticketNumber}: ${response.error}`);
          }
        } catch (error) {
          this.logger.error(`Error updating trade ${closedTrade.ticketNumber}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Drop entries older than 10 minutes and persist in one write.
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    const fresh = removedTrades.filter(rt => (now - rt.removedTime) < maxAge);
    this.recentlyRemovedTrades.set(accountId, fresh);
  }

  private async processOpenTradesFile(filePath: string): Promise<void> {
    // Parse CSV file for open trades 
    const { accountInfo, openTrades } = await this.parseOpenTradesCSVFile(filePath);

    if (!accountInfo) {
      this.logger.error(`Could not extract account info from: ${path.basename(filePath)}`);
      return;
    }

    this.logger.info(`Found ${openTrades.length} open trades in file`);

    // Find matching account in web app
    const matchedAccount = await this.apiClient.findAccountByNumber(accountInfo.accountNumber);
    
    if (!matchedAccount) {
      this.logger.warn(`No matching account found for: ${accountInfo.accountNumber}`);
      return;
    }

    // Get recent closed trades for this account to help with proper exit times
    const recentClosedTrades = this.recentClosedTrades.get(matchedAccount.id) || [];
    
    // Always call the API (even with empty trades) to trigger auto-closure
    // Pass account info to help with broker timezone calculation
    const importResult = await this.apiClient.importOpenTrades(matchedAccount.id, openTrades, recentClosedTrades, accountInfo);
    
    if (importResult.success) {
      const totalProcessed = (importResult.importedCount || 0) + (importResult.updatedCount || 0) + (importResult.closedCount || 0);
      
      if (importResult.importedCount && importResult.importedCount > 0) {
        this.logger.info(`Imported ${importResult.importedCount} new open trades for account: ${accountInfo.accountNumber}`);
      }
      if (importResult.updatedCount && importResult.updatedCount > 0) {
        this.logger.info(`Updated ${importResult.updatedCount} existing open trades for account: ${accountInfo.accountNumber}`);
      }
      if (importResult.closedCount && importResult.closedCount > 0) {
        this.logger.info(`Auto-closed ${importResult.closedCount} trades for account: ${accountInfo.accountNumber}`);
      }
      
      // Store auto-closed trades in recently removed trades map for potential updates with actual closed data
      if (importResult.autoClosedTrades && importResult.autoClosedTrades.length > 0) {
        this.logger.info(`Storing ${importResult.autoClosedTrades.length} auto-closed trades for potential updates with actual closed data`);
        
        const removedTrades = this.recentlyRemovedTrades.get(matchedAccount.id) || [];
        const currentTime = Date.now();
        
        // Convert auto-closed trades to our format and add them
        for (const autoClosedTrade of importResult.autoClosedTrades) {
          removedTrades.push({
            trade: {
              ticketNumber: autoClosedTrade.ticketNumber,
              exitPrice: autoClosedTrade.exitPrice,
              netPnl: autoClosedTrade.netPnl
            },
            removedTime: currentTime
          });
          
          this.logger.debug(`Added auto-closed trade to recently removed: ${autoClosedTrade.ticketNumber} (exitPrice: ${autoClosedTrade.exitPrice}, netPnl: ${autoClosedTrade.netPnl})`);
        }
        
        this.recentlyRemovedTrades.set(matchedAccount.id, removedTrades);
      }
      
      if (openTrades.length === 0 && (importResult.closedCount || 0) === 0) {
        this.logger.info(`No open trades for account: ${accountInfo.accountNumber}`);
      }
      
      this.stats.openTradesImported += importResult.importedCount || 0;
    } else {
      this.logger.error(`Failed to import open trades: ${importResult.error}`);
      this.stats.errors++;
    }
  }

  private async processAccountStateFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const stateData = this.parseAccountStateFile(content, path.basename(filePath));
      if (!stateData) {
        this.logger.warn(`Could not parse account state from ${path.basename(filePath)}`);
        return;
      }

      const matchedAccount = await this.apiClient.findAccountByNumber(stateData.accountNumber);
      if (!matchedAccount) {
        this.logger.debug(`Account state file for unknown account: ${stateData.accountNumber}`);
        return;
      }

      await this.apiClient.postAccountState(matchedAccount.id, stateData);
    } catch (error) {
      this.logger.warn(`Error handling account state file: ${error instanceof Error ? error.message : String(error)}`);
      this.stats.errors++;
    }
  }

  private parseAccountStateFile(content: string, fileName: string): AccountStateData | null {
    const lines = content.split('\n');
    let accountNumber = '';
    let brokerServerTime: string | undefined;
    let exportTime: string | undefined;
    let dataLineIndex = -1;
    let headerCols: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('# Account Number')) {
        const parts = trimmed.split(/[;,\t]|\s{2,}/);
        accountNumber = (parts[1] || '').trim();
      } else if (trimmed.startsWith('# Broker Server Time')) {
        const parts = trimmed.split(/[;,\t]|\s{2,}/);
        brokerServerTime = (parts[1] || '').trim();
      } else if (trimmed.startsWith('# Export Time')) {
        const parts = trimmed.split(/[;,\t]|\s{2,}/);
        exportTime = (parts[1] || '').trim();
      } else if (trimmed.startsWith('Balance')) {
        // Header row, separator detected from this line.
        const sep = trimmed.includes('\t') ? '\t' : (trimmed.includes(';') ? ';' : ',');
        headerCols = trimmed.split(sep).map(s => s.trim());
        dataLineIndex = i + 1;
        break;
      }
    }

    if (!accountNumber) {
      const m = fileName.match(/account_(\d+)_state\.csv/i);
      if (m) accountNumber = m[1];
    }
    if (!accountNumber || dataLineIndex < 0 || dataLineIndex >= lines.length) return null;

    const dataLine = lines[dataLineIndex].trim();
    const sep = dataLine.includes('\t') ? '\t' : (dataLine.includes(';') ? ';' : ',');
    const values = dataLine.split(sep).map(v => v.trim());

    const idx = (name: string) => headerCols.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const num = (i: number) => {
      if (i < 0 || i >= values.length) return 0;
      const n = parseFloat(values[i].replace(/[^\d.\-]/g, ''));
      return isNaN(n) ? 0 : n;
    };

    return {
      accountNumber,
      balance:     num(idx('Balance')),
      equity:      num(idx('Equity')),
      margin:      num(idx('Margin')),
      freeMargin:  num(idx('FreeMargin')),
      marginLevel: num(idx('MarginLevel')),
      profit:      num(idx('Profit')),
      brokerServerTime,
      exportTime
    };
  }

  private isValidTradeExportFile(filePath: string): boolean {
    const fileName = path.basename(filePath);

    // Three filename patterns for MT4 + MT5:
    //   trades_<n>_latest.csv          (closed)
    //   open_trades_<n>_latest.csv     (open)
    //   account_<n>_state.csv          (live equity/margin)
    const closedTradesPattern = /^trades_\d+_(latest|\d{8}_\d{4})\.csv$/i;
    const openTradesPattern   = /^open_trades_\d+_(latest|\d{8}_\d{4})\.csv$/i;
    const accountStatePattern = /^account_\d+_state\.csv$/i;

    return (closedTradesPattern.test(fileName)
         || openTradesPattern.test(fileName)
         || accountStatePattern.test(fileName))
        && path.extname(filePath).toLowerCase() === '.csv';
  }

  private async parseCSVFile(filePath: string): Promise<{ accountInfo: AccountInfo | null; trades: TradeData[] }> {
    try {
      const fileName = path.basename(filePath);
      this.logger.debug(`Parsing CSV file: ${fileName}`);
      
      // Check if file exists and is readable
      if (!fs.existsSync(filePath)) {
        this.logger.error(`File does not exist: ${fileName}`);
        return { accountInfo: null, trades: [] };
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        this.logger.warn(`File is empty: ${fileName}`);
        return { accountInfo: null, trades: [] };
      }

      if (stats.size > 50 * 1024 * 1024) { // 50MB limit
        this.logger.warn(`File is too large (${Math.round(stats.size / 1024 / 1024)}MB): ${fileName}`);
        return { accountInfo: null, trades: [] };
      }
      
      // First, read the file as text to extract account info from header comments
      let fileContent: string;
      try {
        // Try reading as UTF-8 first, then as UTF-16 if that fails
        fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Check for BOM or encoding issues and try alternative encoding
        if (fileContent.includes('\u0000') || fileContent.startsWith('\uFEFF') || fileContent.startsWith('��')) {
          this.logger.info(`File appears to be UTF-16 encoded, trying alternative encoding: ${fileName}`);
          fileContent = fs.readFileSync(filePath, 'utf16le');
          
          // Remove null bytes that might still be present
          fileContent = fileContent.replace(/\u0000/g, '');
        }
      } catch (readError) {
        this.logger.error(`Failed to read file ${fileName}: ${readError instanceof Error ? readError.message : String(readError)}`);
        return { accountInfo: null, trades: [] };
      }

      if (!fileContent || fileContent.trim().length === 0) {
        this.logger.warn(`File has no content: ${fileName}`);
        return { accountInfo: null, trades: [] };
      }

      const accountInfo = this.extractAccountInfoFromText(fileContent, fileName);
      const brokerOffsetMs = this.computeBrokerOffsetMs(accountInfo?.brokerServerTime);
      if (!accountInfo?.brokerServerTime) {
        this.logger.warn(`No broker server time in ${fileName}; trade timestamps will be treated as UTC.`);
      }

      // Then parse the trade data using CSV parser
      let trades: TradeData[] = [];
      try {
        trades = await this.parseTradeDataFromCSV(filePath, brokerOffsetMs);
      } catch (parseError) {
        this.logger.error(`Failed to parse trade data from ${fileName}: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        // Continue with empty trades array rather than failing completely
      }

      this.logger.debug(`Extracted account: ${accountInfo?.accountNumber || 'none'}, trades: ${trades.length}`);

      return { accountInfo, trades };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error parsing CSV file ${path.basename(filePath)}: ${errorMessage}`);
      // Return empty result instead of throwing to prevent file watcher from crashing
      return { accountInfo: null, trades: [] };
    }
  }

  private async parseOpenTradesCSVFile(filePath: string): Promise<{ accountInfo: AccountInfo | null; openTrades: OpenTradeData[] }> {
    try {
      const fileName = path.basename(filePath);
      this.logger.debug(`Parsing open trades CSV file: ${fileName}`);
      
      // Check if file exists and is readable
      if (!fs.existsSync(filePath)) {
        this.logger.error(`File does not exist: ${fileName}`);
        return { accountInfo: null, openTrades: [] };
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        this.logger.warn(`File is empty: ${fileName}`);
        return { accountInfo: null, openTrades: [] };
      }

      if (stats.size > 50 * 1024 * 1024) { // 50MB limit
        this.logger.warn(`File is too large (${Math.round(stats.size / 1024 / 1024)}MB): ${fileName}`);
        return { accountInfo: null, openTrades: [] };
      }
      
      // First, read the file as text to extract account info from header comments
      let fileContent: string;
      try {
        // Try reading as UTF-8 first, then as UTF-16 if that fails
        fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Check for BOM or encoding issues and try alternative encoding
        if (fileContent.includes('\u0000') || fileContent.startsWith('\uFEFF') || fileContent.startsWith('��')) {
          this.logger.info(`File appears to be UTF-16 encoded, trying alternative encoding: ${fileName}`);
          fileContent = fs.readFileSync(filePath, 'utf16le');
          
          // Remove null bytes that might still be present
          fileContent = fileContent.replace(/\u0000/g, '');
        }
      } catch (readError) {
        this.logger.error(`Failed to read file ${fileName}: ${readError instanceof Error ? readError.message : String(readError)}`);
        return { accountInfo: null, openTrades: [] };
      }

      if (!fileContent || fileContent.trim().length === 0) {
        this.logger.warn(`File has no content: ${fileName}`);
        return { accountInfo: null, openTrades: [] };
      }

      const accountInfo = this.extractAccountInfoFromText(fileContent, fileName);
      const brokerOffsetMs = this.computeBrokerOffsetMs(accountInfo?.brokerServerTime);
      if (!accountInfo?.brokerServerTime) {
        this.logger.warn(`No broker server time in ${fileName}; open-trade timestamps will be treated as UTC.`);
      }

      // Then parse the open trade data using CSV parser
      let openTrades: OpenTradeData[] = [];
      try {
        openTrades = await this.parseOpenTradesDataFromCSV(filePath, brokerOffsetMs);
      } catch (parseError) {
        this.logger.error(`Failed to parse open trade data from ${fileName}: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        // Continue with empty trades array rather than failing completely
      }

      this.logger.debug(`Extracted account: ${accountInfo?.accountNumber || 'none'}, open trades: ${openTrades.length}`);
      
      return { accountInfo, openTrades };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error parsing open trades CSV file ${path.basename(filePath)}: ${errorMessage}`);
      // Return empty result instead of throwing to prevent file watcher from crashing
      return { accountInfo: null, openTrades: [] };
    }
  }

  private async parseOpenTradesDataFromCSV(filePath: string, brokerOffsetMs: number = 0): Promise<OpenTradeData[]> {
    return new Promise((resolve, reject) => {
      const openTrades: OpenTradeData[] = [];
      let foundDataHeaders = false;
      let rowCount = 0;
      let errorCount = 0;
      let headerRow: string[] = [];

      try {
        // Read file content to manually find headers
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        
        // Find the header line (contains Ticket, Symbol, etc.)
        // Detect separator type (MT4 uses semicolon, MT5 uses tab or comma)
        let separator = ';'; // Default MT4
        let headerLineIndex = -1;
        
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i].trim();
          
          // Remove BOM and other potential invisible characters
          line = line.replace(/^\uFEFF/, '').replace(/[^\x20-\x7E\t]/g, '');
          
          if (line.includes('Ticket') && line.includes('Symbol') && line.includes('OpenTime') && line.includes('Status')) {
            // Detect separator
            if (line.includes('\t')) {
              separator = '\t'; // MT5 tab-separated
            } else if (line.includes(',') && line.split(',').length > line.split(';').length) {
              separator = ','; // MT5 comma-separated
            } else {
              separator = ';'; // MT4 semicolon-separated
            }
            
            headerRow = line.split(separator);
            headerLineIndex = i;
            foundDataHeaders = true;
            this.logger.info(`Found open trade data headers at line ${i + 1} (separator: '${separator}'): ${headerRow.join(', ')}`);
            break;
          }
        }

        if (!foundDataHeaders) {
          this.logger.warn(`No open trade data headers found in CSV file`);
          resolve([]);
          return;
        }

        const stream = fs.createReadStream(filePath)
          .pipe(csv({ 
            headers: headerRow,
            separator: separator  // Use detected separator (MT4: ';', MT5: '\t' or ',')
          }));

        const timeout = setTimeout(() => {
          stream.destroy();
          reject(new Error('CSV parsing timeout after 30 seconds'));
        }, 30000); // 30 second timeout

        stream.on('data', (row: any) => {
          rowCount++;
          
          // Limit processing to prevent memory issues. This is a real
          // truncation — bump stats so the heartbeat surfaces it.
          if (rowCount > 10000) {
            this.logger.warn(`Row limit exceeded (10000), stopping CSV parsing — file is TRUNCATED`);
            this.stats.truncatedFiles++;
            stream.destroy();
            return;
          }

          // Skip empty rows
          if (!row || Object.keys(row).length === 0) return;
          
          // Skip rows where all values are empty
          const hasContent = Object.values(row).some(value => 
            value && value.toString().trim() !== ''
          );
          if (!hasContent) return;

          // Skip comment lines (rows that start with #)
          const firstValue = Object.values(row)[0];
          if (firstValue && firstValue.toString().trim().startsWith('#')) {
            this.logger.debug(`Skipping comment row ${rowCount}`);
            return;
          }

          // Skip header row (when Ticket field contains "Ticket")
          if (row.Ticket && row.Ticket.toString().trim().toLowerCase() === 'ticket') {
            this.logger.debug(`Skipping header row ${rowCount}`);
            return;
          }

          try {
            this.logger.debug(`Processing open trade row ${rowCount}: ${JSON.stringify(row)}`);

            // Skip if no ticket data
            if (!row.Ticket || !row.Ticket.toString().trim()) {
              this.logger.debug(`Skipping row ${rowCount} - no ticket data: ${row.Ticket}`);
              return;
            }

            this.logger.debug(`Attempting to parse open trade data for ticket: ${row.Ticket}`);
            const openTrade = this.parseOpenTradeData(row, brokerOffsetMs);
            if (openTrade) {
              openTrades.push(openTrade);
              this.logger.debug(`Successfully parsed open trade: ${openTrade.ticket} - ${openTrade.symbol}`);
            } else {
              this.logger.warn(`Failed to parse open trade from row ${rowCount} - parseOpenTradeData returned null`);
            }
          } catch (error) {
            errorCount++;
            if (errorCount <= 5) { // Log only first 5 errors to prevent log spam
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.logger.warn(`Error parsing open trade row ${rowCount}: ${errorMessage}`);
            }
          }
        });

        stream.on('end', () => {
          clearTimeout(timeout);
          if (errorCount > 5) {
            this.logger.warn(`Open trades CSV parsing completed with ${errorCount} errors (showing only first 5)`);
          }
          this.logger.debug(`Parsed ${openTrades.length} open trades from ${rowCount} rows`);
          resolve(openTrades);
        });

        stream.on('error', (error: Error) => {
          clearTimeout(timeout);
          this.logger.error(`Open trades CSV stream error: ${error.message}`);
          reject(error);
        });
      } catch (streamError) {
        this.logger.error(`Failed to create open trades CSV stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
        reject(streamError);
      }
    });
  }

  private parseOpenTradeData(row: any, brokerOffsetMs: number = 0): OpenTradeData | null {
    try {
      this.logger.debug(`parseOpenTradeData input: ${JSON.stringify(row)}`);
      
      // Skip invalid or incomplete rows
      if (!row || typeof row !== 'object') {
        this.logger.debug(`parseOpenTradeData: Invalid row object`);
        return null;
      }

      if (!row.Ticket || !row.Symbol || !row.OpenTime) {
        this.logger.debug(`parseOpenTradeData: Missing required fields - Ticket: ${row.Ticket}, Symbol: ${row.Symbol}, OpenTime: ${row.OpenTime}`);
        return null;
      }

      // Validate required fields
      const ticket = row.Ticket ? row.Ticket.toString().trim() : '';
      const symbol = row.Symbol ? row.Symbol.toString().trim().toUpperCase() : '';
      const openTime = row.OpenTime ? row.OpenTime.toString().trim() : '';

      this.logger.debug(`parseOpenTradeData: Extracted - ticket: ${ticket}, symbol: ${symbol}, openTime: ${openTime}`);

      if (!ticket || !symbol || !openTime) {
        this.logger.debug(`parseOpenTradeData: Empty required fields after validation`);
        return null;
      }

      // Additional validation to filter out dummy/invalid trades and header rows
      if (ticket === 'Ticket00' || 
          ticket === 'Ticket' || 
          ticket.toLowerCase().includes('ticket') || 
          symbol === 'SYMBOL' || 
          symbol === 'Symbol' ||
          symbol.length < 2 ||
          parseFloat(row.Size || 0) <= 0 ||
          parseFloat(row.OpenPrice || 0) <= 0 ||
          // Check if this looks like a header row
          (ticket.toLowerCase() === 'ticket' && symbol.toLowerCase() === 'symbol')) {
        this.logger.debug(`parseOpenTradeData: Filtered out invalid/dummy/header trade - ticket: ${ticket}, symbol: ${symbol}, size: ${row.Size}, openPrice: ${row.OpenPrice}`);
        return null;
      }

      // Parse numeric fields with validation
      const parseNumeric = (value: any, defaultValue: number = 0): number => {
        if (value === null || value === undefined || value === '') {
          return defaultValue;
        }
        const parsed = parseFloat(value.toString().replace(/[^\d.-]/g, ''));
        return isNaN(parsed) ? defaultValue : parsed;
      };

      const openTradeData: OpenTradeData = {
        ticket,
        openTime: this.convertMT4TimeToISO(openTime, brokerOffsetMs),
        type: row.Type ? row.Type.toString().trim() : '',
        size: parseNumeric(row.Size),
        symbol,
        openPrice: parseNumeric(row.OpenPrice),
        stopLoss: parseNumeric(row.StopLoss),
        takeProfit: parseNumeric(row.TakeProfit),
        currentPrice: parseNumeric(row.CurrentPrice),
        commission: parseNumeric(row.Commission),
        swap: parseNumeric(row.Swap),
        unrealizedPnl: parseNumeric(row.UnrealizedPnl),
        comment: row.Comment ? row.Comment.toString().trim() : '',
        status: row.Status ? row.Status.toString().trim() : 'OPEN',
        magic: parseNumeric(row.Magic)
      };

      this.logger.debug(`parseOpenTradeData: Successfully created open trade object: ${JSON.stringify(openTradeData)}`);
      return openTradeData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error parsing open trade data: ${errorMessage}`);
      return null;
    }
  }

  private extractAccountInfoFromText(fileContent: string, fileName: string): AccountInfo | null {
    try {
      const lines = fileContent.split('\n');
      let accountNumber = '';
      let accountName = '';
      let accountCurrency = 'USD';
      let accountBalance = 0;
      let exportTime = new Date().toISOString();
      let brokerServerTime: string | undefined;

      // Detect file format (MT4 uses semicolons, MT5 uses tabs)
      const isMT5Format = fileContent.includes('# Account Number\t') || 
                         fileContent.includes('# Account Number    ');
      
      this.logger.debug(`Detected file format: ${isMT5Format ? 'MT5' : 'MT4'}`);

      // Parse account info from comment lines
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        // MT5 format uses tab or multiple spaces, MT4 uses semicolon
        const separator = isMT5Format ? /\s{2,}|\t/ : ';';
        const parts = trimmedLine.split(separator);
        
        if (trimmedLine.startsWith('# Account Number')) {
          accountNumber = parts[1]?.trim() || '';
        } else if (trimmedLine.startsWith('# Account Name')) {
          accountName = parts[1]?.trim() || '';
        } else if (trimmedLine.startsWith('# Account Currency')) {
          accountCurrency = parts[1]?.trim() || 'USD';
        } else if (trimmedLine.startsWith('# Account Balance')) {
          const balanceStr = parts[1]?.trim();
          if (balanceStr) {
            const balance = parseFloat(balanceStr);
            if (!isNaN(balance)) {
              accountBalance = balance;
            }
          }
        } else if (trimmedLine.startsWith('# Broker Server Time')) {
          const timeStr = parts[1]?.trim();
          if (timeStr) {
            const brokerLocalAsUtcMs = this.parseBrokerLocalToUtcMs(timeStr);
            if (brokerLocalAsUtcMs != null) {
              // Encode broker wall-clock as ISO (treated as UTC-rebased).
              // Callers compare against Date.now() to derive the real offset.
              brokerServerTime = new Date(brokerLocalAsUtcMs).toISOString();
            } else {
              this.logger.warn(`Could not parse broker server time: ${timeStr}`);
            }
          }
        } else if (trimmedLine.startsWith('# Export Time')) {
          const timeStr = parts[1]?.trim();
          if (timeStr) {
            const exportAsUtcMs = this.parseBrokerLocalToUtcMs(timeStr);
            if (exportAsUtcMs != null) {
              exportTime = new Date(exportAsUtcMs).toISOString();
            } else {
              this.logger.debug(`Could not parse export time: ${timeStr}`);
            }
          }
        }
        
        // Stop parsing when we reach the data headers (for both MT4 and MT5)
        if ((trimmedLine.includes('Ticket;') && trimmedLine.includes('Symbol;')) ||
            (trimmedLine.includes('Ticket\t') && trimmedLine.includes('Symbol')) ||
            (trimmedLine.includes('Ticket    ') && trimmedLine.includes('Symbol'))) {
          break;
        }
      }

      if (accountNumber) {
        return {
          accountNumber,
          accountName: accountName || `Account ${accountNumber}`,
          accountCurrency,
          accountBalance,
          exportTime,
          brokerServerTime
        };
      }

      // Fallback: extract from filename
      const fileNameMatch = fileName.match(/trades_(\d+)_/);
      if (fileNameMatch) {
        const accountFromFilename = fileNameMatch[1];
        this.logger.debug(`Using account number from filename: ${accountFromFilename}`);
        return {
          accountNumber: accountFromFilename,
          accountName: `Account ${accountFromFilename}`,
          accountCurrency: 'USD',
          accountBalance: 0,
          exportTime: new Date().toISOString()
        };
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error extracting account info: ${errorMessage}`);
      return null;
    }
  }

  private async parseTradeDataFromCSV(filePath: string, brokerOffsetMs: number = 0): Promise<TradeData[]> {
    return new Promise((resolve, reject) => {
      const trades: TradeData[] = [];
      let foundDataHeaders = false;
      let rowCount = 0;
      let errorCount = 0;
      let headerRow: string[] = [];

      try {
        // Read file content to manually find headers
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        
        // Find the header line (contains Ticket, Symbol, etc.)
        // Detect separator type (MT4 uses semicolon, MT5 uses tab or comma)
        let separator = ';'; // Default MT4
        let headerLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes('Ticket') && line.includes('Symbol') && line.includes('OpenTime')) {
            // Detect separator
            if (line.includes('\t')) {
              separator = '\t'; // MT5 tab-separated
            } else if (line.includes(',') && line.split(',').length > line.split(';').length) {
              separator = ','; // MT5 comma-separated
            } else {
              separator = ';'; // MT4 semicolon-separated
            }
            
            headerRow = line.split(separator);
            headerLineIndex = i;
            foundDataHeaders = true;
            this.logger.info(`Found trade data headers at line ${i + 1} (separator: '${separator}'): ${headerRow.join(', ')}`);
            break;
          }
        }

        if (!foundDataHeaders) {
          this.logger.warn(`No trade data headers found in CSV file`);
          resolve([]);
          return;
        }

        const stream = fs.createReadStream(filePath)
          .pipe(csv({ 
            headers: headerRow,
            separator: separator  // Use detected separator (MT4: ';', MT5: '\t' or ',')
          }));

        const timeout = setTimeout(() => {
          stream.destroy();
          reject(new Error('CSV parsing timeout after 30 seconds'));
        }, 30000); // 30 second timeout

        stream.on('data', (row: any) => {
          rowCount++;
          
          // Limit processing to prevent memory issues. This is a real
          // truncation — bump stats so the heartbeat surfaces it.
          if (rowCount > 10000) {
            this.logger.warn(`Row limit exceeded (10000), stopping CSV parsing — file is TRUNCATED`);
            this.stats.truncatedFiles++;
            stream.destroy();
            return;
          }

          // Skip empty rows
          if (!row || Object.keys(row).length === 0) return;
          
          // Skip rows where all values are empty
          const hasContent = Object.values(row).some(value => 
            value && value.toString().trim() !== ''
          );
          if (!hasContent) return;

          // Skip comment lines (rows that start with #)
          const firstValue = Object.values(row)[0];
          if (firstValue && firstValue.toString().trim().startsWith('#')) {
            this.logger.debug(`Skipping comment row ${rowCount}`);
            return;
          }

          // Skip header row (when Ticket field contains "Ticket")
          if (row.Ticket && row.Ticket.toString().trim().toLowerCase() === 'ticket') {
            this.logger.debug(`Skipping header row ${rowCount}`);
            return;
          }

          try {
            this.logger.debug(`Processing row ${rowCount}: ${JSON.stringify(row)}`);

            // Skip if no ticket data
            if (!row.Ticket || !row.Ticket.toString().trim()) {
              this.logger.debug(`Skipping row ${rowCount} - no ticket data: ${row.Ticket}`);
              return;
            }

            this.logger.debug(`Attempting to parse trade data for ticket: ${row.Ticket}`);
            const trade = this.parseTradeData(row, brokerOffsetMs);
            if (trade) {
              trades.push(trade);
              this.logger.debug(`Successfully parsed trade: ${trade.ticket} - ${trade.symbol}`);
            } else {
              this.logger.warn(`Failed to parse trade from row ${rowCount} - parseTradeData returned null`);
            }
          } catch (error) {
            errorCount++;
            if (errorCount <= 5) { // Log only first 5 errors to prevent log spam
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.logger.warn(`Error parsing trade row ${rowCount}: ${errorMessage}`);
            }
          }
        });

        stream.on('end', () => {
          clearTimeout(timeout);
          if (errorCount > 5) {
            this.logger.warn(`CSV parsing completed with ${errorCount} errors (showing only first 5)`);
          }
          this.logger.debug(`Parsed ${trades.length} trades from ${rowCount} rows`);
          resolve(trades);
        });

        stream.on('error', (error: Error) => {
          clearTimeout(timeout);
          this.logger.error(`CSV stream error: ${error.message}`);
          reject(error);
        });
      } catch (streamError) {
        this.logger.error(`Failed to create CSV stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
        reject(streamError);
      }
    });
  }


  private parseTradeData(row: any, brokerOffsetMs: number = 0): TradeData | null {
    try {
      this.logger.debug(`parseTradeData input: ${JSON.stringify(row)}`);
      
      // Skip invalid or incomplete rows
      if (!row || typeof row !== 'object') {
        this.logger.debug(`parseTradeData: Invalid row object`);
        return null;
      }

      if (!row.Ticket || !row.Symbol || !row.OpenTime) {
        this.logger.debug(`parseTradeData: Missing required fields - Ticket: ${row.Ticket}, Symbol: ${row.Symbol}, OpenTime: ${row.OpenTime}`);
        return null;
      }

      // Validate required fields
      const ticket = row.Ticket ? row.Ticket.toString().trim() : '';
      const symbol = row.Symbol ? row.Symbol.toString().trim().toUpperCase() : '';
      const openTime = row.OpenTime ? row.OpenTime.toString().trim() : '';

      this.logger.debug(`parseTradeData: Extracted - ticket: ${ticket}, symbol: ${symbol}, openTime: ${openTime}`);

      if (!ticket || !symbol || !openTime) {
        this.logger.debug(`parseTradeData: Empty required fields after validation`);
        return null;
      }

      // Additional validation to filter out dummy/invalid trades and header rows
      if (ticket === 'Ticket00' || 
          ticket === 'Ticket' || 
          ticket.toLowerCase().includes('ticket') || 
          symbol === 'SYMBOL' || 
          symbol === 'Symbol' ||
          symbol.length < 2 ||
          parseFloat(row.Size || 0) <= 0 ||
          parseFloat(row.OpenPrice || 0) <= 0 ||
          // Check if this looks like a header row
          (ticket.toLowerCase() === 'ticket' && symbol.toLowerCase() === 'symbol')) {
        this.logger.debug(`parseTradeData: Filtered out invalid/dummy/header trade - ticket: ${ticket}, symbol: ${symbol}, size: ${row.Size}, openPrice: ${row.OpenPrice}`);
        return null;
      }

      // Parse numeric fields with validation
      const parseNumeric = (value: any, defaultValue: number = 0): number => {
        if (value === null || value === undefined || value === '') {
          return defaultValue;
        }
        const parsed = parseFloat(value.toString().replace(/[^\d.-]/g, ''));
        return isNaN(parsed) ? defaultValue : parsed;
      };

      const tradeData: TradeData = {
        ticket,
        openTime: this.convertMT4TimeToISO(openTime, brokerOffsetMs),
        type: row.Type ? row.Type.toString().trim() : '',
        size: parseNumeric(row.Size),
        symbol,
        openPrice: parseNumeric(row.OpenPrice),
        stopLoss: parseNumeric(row.StopLoss),
        takeProfit: parseNumeric(row.TakeProfit),
        closeTime: this.convertMT4TimeToISO(row.CloseTime, brokerOffsetMs),
        closePrice: parseNumeric(row.ClosePrice),
        commission: parseNumeric(row.Commission),
        swap: parseNumeric(row.Swap),
        profit: parseNumeric(row.Profit),
        comment: row.Comment ? row.Comment.toString().trim() : '',
        magic: parseNumeric(row.Magic)
      };

      this.logger.debug(`parseTradeData: Successfully created trade object: ${JSON.stringify(tradeData)}`);
      return tradeData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error parsing trade data: ${errorMessage}`);
      return null;
    }
  }

  // Parses an MT4/MT5 broker-local time string ("YYYY.MM.DD HH:MM[:SS]") into
  // milliseconds, treating the input as if it were UTC. The broker offset is
  // applied separately by the caller.
  private parseBrokerLocalToUtcMs(timeStr: string): number | null {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const cleanStr = timeStr.trim();
    if (!cleanStr) return null;

    const [datePart, timePart] = cleanStr.split(/\s+/);
    if (!datePart || !timePart) return null;

    const dateBits = datePart.split(/[.\-/]/).map(Number);
    const timeBits = timePart.split(':').map(Number);
    if (dateBits.length < 3 || timeBits.length < 2) return null;

    const [y, mo, d] = dateBits;
    const [hh, mm, ss = 0] = timeBits;
    if ([y, mo, d, hh, mm, ss].some(v => Number.isNaN(v))) return null;

    return Date.UTC(y, mo - 1, d, hh, mm, ss);
  }

  // Returns how far ahead the broker clock is from real UTC, in ms.
  // brokerServerTimeIso is the ISO string produced by extractAccountInfoFromText:
  // it represents the broker's wall clock encoded as if it were UTC, so its
  // numeric ms value directly reflects broker-local-as-UTC.
  //
  // Sanity check: if the host clock is wrong by more than 14h (the largest
  // real broker offset), don't shift timestamps blindly — return 0 and bump
  // the rejection counter so it surfaces in the heartbeat.
  private static readonly MAX_BROKER_OFFSET_MS = 14 * 60 * 60 * 1000;
  private computeBrokerOffsetMs(brokerServerTimeIso?: string): number {
    if (!brokerServerTimeIso) return 0;
    const brokerAsUtcMs = new Date(brokerServerTimeIso).getTime();
    if (Number.isNaN(brokerAsUtcMs)) return 0;
    const offset = brokerAsUtcMs - Date.now();
    if (Math.abs(offset) > FileWatcher.MAX_BROKER_OFFSET_MS) {
      this.logger.warn(`Broker offset ${(offset / 3600000).toFixed(1)}h exceeds sane range; treating broker time as UTC. Check host clock.`);
      this.stats.brokerTimeRejections++;
      return 0;
    }
    return offset;
  }

  private convertMT4TimeToISO(timeStr: string, brokerOffsetMs: number = 0): string {
    try {
      if (!timeStr || typeof timeStr !== 'string' || timeStr.trim() === '') {
        return new Date().toISOString();
      }

      const brokerLocalAsUtcMs = this.parseBrokerLocalToUtcMs(timeStr);
      if (brokerLocalAsUtcMs != null) {
        return new Date(brokerLocalAsUtcMs - brokerOffsetMs).toISOString();
      }

      // Last-resort: let JS parse it (will be machine-local — only reached
      // when the format is unrecognized).
      const date = new Date(timeStr.trim());
      if (isNaN(date.getTime())) {
        this.logger.debug(`Could not parse date: ${timeStr}`);
        return new Date().toISOString();
      }
      return date.toISOString();
    } catch (error) {
      this.logger.debug(`Error converting MT4/MT5 time "${timeStr}": ${error instanceof Error ? error.message : String(error)}`);
      return new Date().toISOString();
    }
  }
}