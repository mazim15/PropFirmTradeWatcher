import axios, { AxiosInstance, AxiosError } from 'axios';
import { TradeData, OpenTradeData, AccountStateData } from './fileWatcher';
import { Logger } from './logger';
import { normaliseSymbol, SymbolMap } from './symbolNormaliser';

// Retry transient failures (network errors, 5xx). Don't retry 4xx — those
// are deterministic (bad request, unauthorized, etc) and won't recover.
async function withRetry<T>(
  fn: () => Promise<T>,
  logger: Logger,
  label: string,
  maxAttempts: number = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as AxiosError)?.response?.status;
      const isRetryable = !status || status >= 500 || status === 429;
      if (!isRetryable || attempt === maxAttempts) throw error;
      const delayMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
      logger.warn(`${label} attempt ${attempt} failed (${status || 'network'}), retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

export interface TradingAccount {
  id: string;
  name: string;
  accountNumber: string;
  type: 'Prop' | 'Broker';
  status: string;
}

export interface ImportResult {
  success: boolean;
  importedCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  closedCount?: number;
  autoClosedTrades?: {ticketNumber: string, exitPrice: number, netPnl: number}[];
  error?: string;
}

export interface ApiTestResult {
  success: boolean;
  message?: string;
  error?: string;
}

export class ApiClient {
  private axiosInstance: AxiosInstance;
  private keyName: string = '';
  private symbolMap: SymbolMap | undefined;

  constructor(
    private apiUrl: string,
    private apiKey: string,
    private logger: Logger,
    symbolMap?: SymbolMap
  ) {
    this.symbolMap = symbolMap;
    this.axiosInstance = this.createAxiosInstance();
  }

  public getKeyName(): string {
    return this.keyName;
  }

  public updateConfig(apiUrl: string, apiKey: string): void {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.axiosInstance = this.createAxiosInstance();
  }

  public setSymbolMap(map: SymbolMap | undefined): void {
    this.symbolMap = map;
  }

  private createAxiosInstance(): AxiosInstance {
    return axios.create({
      baseURL: this.apiUrl.endsWith('/') ? this.apiUrl.slice(0, -1) : this.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PropFirm-Trade-Watcher/1.0',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
      }
    });
  }

  public async testConnection(): Promise<ApiTestResult> {
    try {
      this.logger.info('Testing API connection and authentication...');
      
      const response = await this.axiosInstance.get('/api/watcher/auth-test');
      
      if (response.status === 200 && response.data?.success) {
        this.logger.info('API connection and authentication successful');
        this.keyName = response.data.keyName || 'Unknown';
        return {
          success: true,
          message: `Connection successful - Key: ${this.keyName}`
        };
      } else {
        return {
          success: false,
          error: `Unexpected response status: ${response.status}`
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`API connection test failed: ${errorMessage}`);
      
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          return {
            success: false,
            error: 'Connection refused. Is the web app running?'
          };
        } else if (error.response?.status === 401) {
          return {
            success: false,
            error: 'Authentication failed. Check your API key.'
          };
        } else if (error.response?.status === 404) {
          return {
            success: false,
            error: 'API endpoint not found. Check the URL.'
          };
        } else {
          return {
            success: false,
            error: `HTTP ${error.response?.status}: ${error.response?.statusText || error.message}`
          };
        }
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async findAccountByNumber(accountNumber: string): Promise<TradingAccount | null> {
    try {
      this.logger.debug(`Looking for account: ${accountNumber}`);

      const response = await withRetry(
        () => this.axiosInstance.get(`/api/accounts/match-by-number/${accountNumber}`),
        this.logger,
        `findAccountByNumber(${accountNumber})`
      );

      if (response.data && response.data.account) {
        this.logger.info(`Found matching account: ${response.data.account.name} (${accountNumber})`);
        return response.data.account;
      }

      this.logger.warn(`No account found for number: ${accountNumber}`);
      return null;
    } catch (error) {
      this.logger.error(`Error finding account ${accountNumber}: ${error instanceof Error ? error.message : String(error)}`);

      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null; // Account not found
      }

      throw error;
    }
  }

  public async filterNewTrades(accountId: string, trades: TradeData[]): Promise<TradeData[]> {
    this.logger.debug(`Checking for duplicate trades in account: ${accountId}`);

    const ticketNumbers = trades.map(trade => trade.ticket);

    // Re-thrown after retries — caller treats throw as a hard failure now
    // that dedup is authoritative on the server side (ticketNumber field).
    const response = await withRetry(
      () => this.axiosInstance.post('/api/trades/check-duplicates', { accountId, ticketNumbers }),
      this.logger,
      `checkDuplicates(${accountId})`
    );

    if (response.data && Array.isArray(response.data.existingTickets)) {
      const existingTickets = new Set(response.data.existingTickets);
      const newTrades = trades.filter(trade => !existingTickets.has(trade.ticket));
      this.logger.info(`Found ${newTrades.length} new trades out of ${trades.length} total`);
      return newTrades;
    }

    // Server returned 200 but unexpected shape — refuse to import; safer
    // than a possible double-import.
    this.logger.error('Duplicate check returned unexpected response shape; aborting batch');
    throw new Error('Invalid /check-duplicates response');
  }

  public async importTrades(accountId: string, trades: TradeData[]): Promise<ImportResult> {
    try {
      this.logger.info(`Importing ${trades.length} trades for account: ${accountId}`);
      
      // Convert TradeData to the format expected by the web app
      const tradesForImport = trades.map(trade => ({
        accountId,
        symbolId: null, // Will be resolved by the API
        ticketNumber: trade.ticket,
        direction: this.convertTradeDirection(trade.type),
        lotSize: trade.size,
        entryPrice: trade.openPrice,
        exitPrice: trade.closePrice,
        entryTime: trade.openTime,
        exitTime: trade.closeTime,
        entryTimeUTC: trade.openTime,
        exitTimeUTC: trade.closeTime,
        status: 'Closed',
        commission: Math.abs(trade.commission),
        swap: trade.swap,
        grossPnl: 0, // Will be calculated by API
        netPnl: 0,   // Will be calculated by API
        notes: `Watcher Import | Ticket: ${trade.ticket}${trade.stopLoss ? ` | SL: ${trade.stopLoss}` : ''}${trade.takeProfit ? ` | TP: ${trade.takeProfit}` : ''}${trade.comment ? ` | ${trade.comment}` : ''}`,
        tags: ['watcher-import'],
        createdDate: new Date().toISOString(),
        symbol: normaliseSymbol(trade.symbol, this.symbolMap), // canonicalised for resolution
        symbolRaw: trade.symbol, // preserve original broker-side name
        magic: trade.magic ?? 0
      }));

      this.logger.info(`Sending ${tradesForImport.length} trades to web app`);
      tradesForImport.forEach((trade, index) => {
        this.logger.debug(`Trade ${index + 1}: ${JSON.stringify(trade)}`);
      });

      const response = await withRetry(
        () => this.axiosInstance.post('/api/import/batch', { trades: tradesForImport }),
        this.logger,
        `importTrades(${accountId})`
      );
      
      if (response.data && response.data.success) {
        this.logger.info(`Successfully imported ${response.data.importedCount} trades`);
        return {
          success: true,
          importedCount: response.data.importedCount,
          skippedCount: response.data.skippedCount || 0
        };
      } else {
        // Handle different error response formats
        let errorMessage = 'Unknown error during import';
        
        if (response.data) {
          if (response.data.message) {
            errorMessage = response.data.message;
          } else if (response.data.errors && Array.isArray(response.data.errors) && response.data.errors.length > 0) {
            errorMessage = response.data.errors.join('; ');
          } else if (response.data.error) {
            errorMessage = response.data.error;
          }
        }

        this.logger.error(`Import failed: ${errorMessage}`);
        this.logger.error(`Full response: ${JSON.stringify(response.data)}`);
        
        // Log additional details about what was skipped
        if (response.data && response.data.errors && Array.isArray(response.data.errors)) {
          this.logger.error(`Detailed errors:`);
          response.data.errors.forEach((err: any, index: number) => {
            this.logger.error(`  ${index + 1}. ${err}`);
          });
        }
        
        return {
          success: false,
          error: errorMessage
        };
      }
    } catch (error) {
      this.logger.error(`Error importing trades: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private convertTradeDirection(mt4Type: string): 'Buy' | 'Sell' {
    const type = mt4Type.toLowerCase();
    
    if (type.includes('buy')) {
      return 'Buy';
    } else if (type.includes('sell')) {
      return 'Sell';
    } else {
      // Default to Buy if unclear
      return 'Buy';
    }
  }

  public async registerWatcher(watcherId: string, version: string, systemInfo?: any): Promise<boolean> {
    try {
      const response = await this.axiosInstance.post('/api/watcher/register', {
        watcherId,
        version,
        timestamp: new Date().toISOString(),
        hostname: systemInfo?.hostname,
        platform: systemInfo?.platform,
        arch: systemInfo?.arch,
        osVersion: systemInfo?.version,
        user: systemInfo?.user,
        uptime: systemInfo?.uptime
      });
      
      return response.status === 200;
    } catch (error) {
      this.logger.error(`Error registering watcher: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  public async postAccountState(accountId: string, state: AccountStateData): Promise<boolean> {
    try {
      const response = await withRetry(
        () => this.axiosInstance.post('/api/accounts/state', { accountId, ...state, postedAt: new Date().toISOString() }),
        this.logger,
        `postAccountState(${accountId})`
      );
      return response.status === 200;
    } catch (error) {
      this.logger.debug(`postAccountState failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // Pulls the user's symbol map (canonical -> variants) so the watcher can
  // canonicalise broker symbols before sending. Called at startup and on
  // each heartbeat tick. Returns null on failure (caller keeps existing).
  public async fetchSymbolMap(): Promise<SymbolMap | null> {
    try {
      const response = await this.axiosInstance.get('/api/settings/symbol-map');
      if (response.status === 200 && response.data?.success && response.data.symbolMap) {
        return response.data.symbolMap as SymbolMap;
      }
      return null;
    } catch (error) {
      this.logger.debug(`fetchSymbolMap failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  public async sendHeartbeat(watcherId: string, stats: any): Promise<boolean> {
    try {
      const response = await this.axiosInstance.post('/api/watcher/heartbeat', {
        watcherId,
        stats,
        timestamp: new Date().toISOString()
      });
      
      return response.status === 200;
    } catch (error) {
      this.logger.debug(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  public async importOpenTrades(accountId: string, openTrades: OpenTradeData[], closedTradesData?: any[], accountInfo?: any): Promise<ImportResult> {
    try {
      this.logger.info(`Importing ${openTrades.length} open trades for account: ${accountId}`);
      
      // Convert OpenTradeData to the format expected by the web app
      const openTradesForImport = openTrades.map(trade => ({
        accountId,
        symbolId: '', // Will be resolved by the API, using empty string instead of null
        ticketNumber: trade.ticket,
        direction: this.convertTradeDirection(trade.type),
        lotSize: trade.size,
        entryPrice: trade.openPrice,
        currentPrice: trade.currentPrice,
        entryTime: trade.openTime,
        entryTimeUTC: trade.openTime,
        status: 'Open',
        stopLoss: trade.stopLoss && trade.stopLoss !== 0 ? trade.stopLoss : 0,
        takeProfit: trade.takeProfit && trade.takeProfit !== 0 ? trade.takeProfit : 0,
        commission: Math.abs(trade.commission),
        swap: trade.swap,
        unrealizedPnl: trade.unrealizedPnl,
        grossPnl: trade.unrealizedPnl + Math.abs(trade.commission) + trade.swap,
        netPnl: trade.unrealizedPnl,
        notes: `Open Trade Import | Ticket: ${trade.ticket}${trade.comment ? ` | ${trade.comment}` : ''}`,
        tags: ['watcher-import', 'open-trade'],
        createdDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        symbol: normaliseSymbol(trade.symbol, this.symbolMap),
        symbolRaw: trade.symbol,
        magic: trade.magic ?? 0
      }));

      this.logger.info(`Sending ${openTradesForImport.length} open trades to web app`);
      openTradesForImport.forEach((trade, index) => {
        this.logger.debug(`Open Trade ${index + 1}: ${JSON.stringify(trade)}`);
      });

      const requestPayload = {
        trades: openTradesForImport,
        accountId: accountId,
        closedTradesData: closedTradesData || [],
        accountInfo: accountInfo
      };

      this.logger.debug(`Full API request payload: ${JSON.stringify(requestPayload, null, 2)}`);

      const response = await withRetry(
        () => this.axiosInstance.post('/api/import/open-trades', requestPayload),
        this.logger,
        `importOpenTrades(${accountId})`
      );

      this.logger.debug(`API Response Status: ${response.status}`);
      this.logger.debug(`API Response Data: ${JSON.stringify(response.data, null, 2)}`);
      
      if (response.data && response.data.success) {
        this.logger.info(`Successfully processed open trades: ${response.data.importedCount} new, ${response.data.updatedCount} updated, ${response.data.closedCount || 0} auto-closed`);
        return {
          success: true,
          importedCount: response.data.importedCount,
          updatedCount: response.data.updatedCount,
          skippedCount: response.data.skippedCount || 0,
          closedCount: response.data.closedCount || 0,
          autoClosedTrades: response.data.autoClosedTrades || []
        };
      } else {
        // Handle different error response formats
        let errorMessage = 'Unknown error during open trades import';
        
        if (response.data) {
          if (response.data.message) {
            errorMessage = response.data.message;
          } else if (response.data.errors && Array.isArray(response.data.errors) && response.data.errors.length > 0) {
            errorMessage = response.data.errors.join('; ');
          } else if (response.data.error) {
            errorMessage = response.data.error;
          }
        }

        this.logger.error(`Open trades import failed: ${errorMessage}`);
        this.logger.error(`Full response: ${JSON.stringify(response.data)}`);
        
        return {
          success: false,
          error: errorMessage
        };
      }
    } catch (error) {
      this.logger.error(`Error importing open trades: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async updateTradeWithClosedData(accountId: string, ticketNumber: string, closedData: {exitPrice: number, exitTime: string, netPnl: number, status: string}): Promise<{success: boolean, error?: string}> {
    try {
      this.logger.info(`Updating trade ${ticketNumber} with actual closed data: exitPrice=${closedData.exitPrice}, netPnl=${closedData.netPnl}`);
      
      const response = await withRetry(
        () => this.axiosInstance.post('/api/trades/update-closed-data', {
          accountId,
          ticketNumber,
          exitPrice: closedData.exitPrice,
          exitTime: closedData.exitTime,
          netPnl: closedData.netPnl,
          grossPnl: closedData.netPnl,
          status: closedData.status
        }),
        this.logger,
        `updateTradeClosedData(${ticketNumber})`
      );
      
      if (response.status === 200 && response.data?.success) {
        this.logger.info(`Successfully updated trade ${ticketNumber} with closed data`);
        return { success: true };
      } else {
        return {
          success: false,
          error: response.data?.error || `Unexpected response status: ${response.status}`
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`API call failed for updating trade ${ticketNumber}: ${errorMessage}`);
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }
}