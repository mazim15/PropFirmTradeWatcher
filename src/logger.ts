import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export class Logger {
  private logFile: string;
  private recentLogs: LogEntry[] = [];
  private maxRecentLogs = 500;

  constructor(private logLevel: LogLevel = 'info') {
    const userDataPath = app.getPath('userData');
    this.logFile = path.join(userDataPath, 'propfirm-watcher.log');
    
    // Ensure log directory exists
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    
    // Initialize with startup message
    this.info('Logger initialized');
  }

  public setLevel(level: LogLevel): void {
    this.logLevel = level;
    this.info(`Log level changed to: ${level}`);
  }

  public debug(message: string): void {
    this.log('debug', message);
  }

  public info(message: string): void {
    this.log('info', message);
  }

  public warn(message: string): void {
    this.log('warn', message);
  }

  public error(message: string): void {
    this.log('error', message);
  }

  private log(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const logEntry: LogEntry = {
      timestamp,
      level,
      message
    };

    // Add to recent logs
    this.recentLogs.push(logEntry);
    
    // Maintain max recent logs
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs = this.recentLogs.slice(-this.maxRecentLogs);
    }

    // Format log message
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    // Write to console
    console.log(formattedMessage);

    // Write to file (async, non-blocking)
    this.writeToFile(formattedMessage);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };

    return levels[level] >= levels[this.logLevel];
  }

  private writeToFile(message: string): void {
    try {
      fs.appendFile(this.logFile, message + '\n', (error) => {
        if (error) {
          console.error('Failed to write to log file:', error);
        }
      });
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  public getRecentLogs(count?: number): LogEntry[] {
    const logCount = count || this.recentLogs.length;
    return this.recentLogs.slice(-logCount);
  }

  public getLogFile(): string {
    return this.logFile;
  }

  public clearRecentLogs(): void {
    this.recentLogs = [];
  }

  public async rotateLogs(): Promise<void> {
    try {
      // Check file size (rotate if > 10MB)
      const stats = await fs.promises.stat(this.logFile);
      if (stats.size > 10 * 1024 * 1024) {
        const rotatedFile = this.logFile + '.old';
        
        // Remove old rotated file if exists
        if (fs.existsSync(rotatedFile)) {
          await fs.promises.unlink(rotatedFile);
        }
        
        // Rename current log to .old
        await fs.promises.rename(this.logFile, rotatedFile);
        
        this.info('Log file rotated');
      }
    } catch (error) {
      console.error('Failed to rotate logs:', error);
    }
  }
}