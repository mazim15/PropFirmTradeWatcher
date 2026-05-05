//+------------------------------------------------------------------+
//|                                          MT4_TradeExporter.mq4  |
//|                        Copyright 2025, PropFirm Trade Tracker   |
//|                                                                  |
//+------------------------------------------------------------------+
#property copyright "PropFirm Trade Tracker"
#property version   "1.10"
#property strict

//--- Input parameters
input int  ExportIntervalMinutes        = 1;     // Export interval in minutes
input int  OpenTradesIntervalSeconds    = 30;    // Open trades export interval in seconds
input int  AccountStateIntervalSeconds  = 60;    // Account state (equity/margin) export cadence
input bool EnableExport                 = true;  // Enable/disable closed trades export
input bool EnableOpenTrades             = true;  // Enable/disable open trades export
input bool EnableAccountState           = true;  // Enable/disable live account state export
input bool EnableLogging                = true;  // Enable debug logging
input int  MaxHistoryDays               = 30;    // Maximum days of history to export
input bool UseCommonFolder              = true;  // Write into the terminal common folder (MQL\Common\Files)

//--- Global variables
datetime lastExportTime          = 0;
datetime lastOpenTradesExport    = 0;
datetime lastAccountStateExport  = 0;
string   logFileName             = "";

//+------------------------------------------------------------------+
//| File-flag helpers — single source of truth so atomic writes,     |
//| logs and reads all agree about the FILE_COMMON bit.              |
//+------------------------------------------------------------------+
int CsvWriteFlags()  { return FILE_WRITE|FILE_CSV|FILE_ANSI|(UseCommonFolder ? FILE_COMMON : 0); }
int TxtWriteFlags()  { return FILE_WRITE|FILE_READ|FILE_TXT|(UseCommonFolder ? FILE_COMMON : 0); }
int CommonFlag()     { return UseCommonFolder ? FILE_COMMON : 0; }

//+------------------------------------------------------------------+
//| Atomic CSV write: open *.tmp, run writer callback, close, rename |
//| onto the final filename. Returns the row count from the writer.  |
//+------------------------------------------------------------------+
// MQL4 doesn't support function pointers cleanly across builds, so each
// caller inlines the open/close cycle and finishes by calling FinalizeCsv.
bool FinalizeCsv(string tmpName, string finalName)
{
    // FileMove deletes any existing dst when FILE_REWRITE is passed.
    if(!FileMove(tmpName, CommonFlag(), finalName, FILE_REWRITE|CommonFlag()))
    {
        WriteLog("ERROR: FileMove failed " + tmpName + " -> " + finalName + ", err=" + IntegerToString(GetLastError()));
        return false;
    }
    return true;
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    Print("MT4 Trade Exporter initialized (UseCommonFolder=", UseCommonFolder, ")");

    if(EnableLogging)
    {
        logFileName = "MT4_Exporter_" + IntegerToString(AccountNumber()) + "_log.txt";
        WriteLog("=== MT4 Trade Exporter Started ===");
        WriteLog("Account Number: " + IntegerToString(AccountNumber()));
        WriteLog("Account Name: " + AccountName());
        WriteLog("Export Interval: " + IntegerToString(ExportIntervalMinutes) + " minutes");
        WriteLog(UseCommonFolder
                  ? "Files will be written to terminal Common\\Files (FILE_COMMON)."
                  : "Files will be written to MQL4\\Files\\ (per-terminal sandbox).");
    }

    // Single timer per EA. Use the smallest cadence among the enabled exports.
    int timerSeconds = 0;
    if(EnableExport)        timerSeconds = (timerSeconds == 0) ? ExportIntervalMinutes * 60 : MathMin(timerSeconds, ExportIntervalMinutes * 60);
    if(EnableOpenTrades)    timerSeconds = (timerSeconds == 0) ? OpenTradesIntervalSeconds : MathMin(timerSeconds, OpenTradesIntervalSeconds);
    if(EnableAccountState)  timerSeconds = (timerSeconds == 0) ? AccountStateIntervalSeconds : MathMin(timerSeconds, AccountStateIntervalSeconds);

    if(timerSeconds > 0)
    {
        EventSetTimer(timerSeconds);
        WriteLog("Timer set to " + IntegerToString(timerSeconds) + " seconds");
    }

    if(EnableExport)        ExportTrades();
    if(EnableOpenTrades)    ExportOpenTrades();
    if(EnableAccountState)  ExportAccountState();

    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
    WriteLog("=== MT4 Trade Exporter Stopped ===");
    EventKillTimer();
}

//+------------------------------------------------------------------+
//| Timer function                                                  |
//+------------------------------------------------------------------+
void OnTimer()
{
    if(EnableExport && TimeCurrent() >= lastExportTime + (ExportIntervalMinutes * 60))
        ExportTrades();

    if(EnableOpenTrades && TimeCurrent() >= lastOpenTradesExport + OpenTradesIntervalSeconds)
        ExportOpenTrades();

    if(EnableAccountState && TimeCurrent() >= lastAccountStateExport + AccountStateIntervalSeconds)
        ExportAccountState();
}

//+------------------------------------------------------------------+
//| Closed trades export                                            |
//+------------------------------------------------------------------+
void ExportTrades()
{
    WriteLog("Starting trade export...");

    string finalName = "trades_" + IntegerToString(AccountNumber()) + "_latest.csv";
    string tmpName   = finalName + ".tmp";

    int fileHandle = FileOpen(tmpName, CsvWriteFlags());
    if(fileHandle == INVALID_HANDLE)
    {
        WriteLog("ERROR: Could not create temp file: " + tmpName + ", err=" + IntegerToString(GetLastError()));
        return;
    }

    WriteAccountInfo(fileHandle);
    int tradesExported = WriteTradeData(fileHandle);
    FileClose(fileHandle);

    if(!FinalizeCsv(tmpName, finalName))
        return;

    lastExportTime = TimeCurrent();
    WriteLog("Export completed: " + IntegerToString(tradesExported) + " trades -> " + finalName);
}

//+------------------------------------------------------------------+
//| Open trades export                                              |
//+------------------------------------------------------------------+
void ExportOpenTrades()
{
    WriteLog("Starting open trades export...");

    string finalName = "open_trades_" + IntegerToString(AccountNumber()) + "_latest.csv";
    string tmpName   = finalName + ".tmp";

    int fileHandle = FileOpen(tmpName, CsvWriteFlags());
    if(fileHandle == INVALID_HANDLE)
    {
        WriteLog("ERROR: Could not create temp file: " + tmpName + ", err=" + IntegerToString(GetLastError()));
        return;
    }

    WriteOpenTradesAccountInfo(fileHandle);
    int openTradesExported = WriteOpenTradesData(fileHandle);
    FileClose(fileHandle);

    if(!FinalizeCsv(tmpName, finalName))
        return;

    lastOpenTradesExport = TimeCurrent();
    WriteLog("Open trades export completed: " + IntegerToString(openTradesExported) + " -> " + finalName);
}

//+------------------------------------------------------------------+
//| Live account state export (equity / margin / freeMargin / level) |
//+------------------------------------------------------------------+
void ExportAccountState()
{
    string finalName = "account_" + IntegerToString(AccountNumber()) + "_state.csv";
    string tmpName   = finalName + ".tmp";

    int fileHandle = FileOpen(tmpName, CsvWriteFlags());
    if(fileHandle == INVALID_HANDLE)
    {
        WriteLog("ERROR: Could not create account state temp file, err=" + IntegerToString(GetLastError()));
        return;
    }

    double balance     = AccountBalance();
    double equity      = AccountEquity();
    double margin      = AccountMargin();
    double freeMargin  = AccountFreeMargin();
    double marginLevel = (margin > 0) ? (equity / margin * 100.0) : 0.0;
    double profit      = AccountProfit();

    FileWrite(fileHandle, "# Account State");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountNumber()));
    FileWrite(fileHandle, "# Account Currency", AccountCurrency());
    FileWrite(fileHandle, "# Server Name", AccountServer());
    FileWrite(fileHandle, "# Broker Server Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "# Export Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "");
    FileWrite(fileHandle, "Balance", "Equity", "Margin", "FreeMargin", "MarginLevel", "Profit");
    FileWrite(fileHandle,
        DoubleToString(balance, 2),
        DoubleToString(equity, 2),
        DoubleToString(margin, 2),
        DoubleToString(freeMargin, 2),
        DoubleToString(marginLevel, 2),
        DoubleToString(profit, 2));

    FileClose(fileHandle);

    if(!FinalizeCsv(tmpName, finalName))
        return;

    lastAccountStateExport = TimeCurrent();
}

//+------------------------------------------------------------------+
//| Closed trades CSV header                                        |
//+------------------------------------------------------------------+
void WriteAccountInfo(int fileHandle)
{
    FileWrite(fileHandle, "# Account Information");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountNumber()));
    FileWrite(fileHandle, "# Account Name", AccountName());
    FileWrite(fileHandle, "# Account Currency", AccountCurrency());
    FileWrite(fileHandle, "# Account Balance", DoubleToString(AccountBalance(), 2));
    FileWrite(fileHandle, "# Account Equity", DoubleToString(AccountEquity(), 2));
    FileWrite(fileHandle, "# Broker Server Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "# Account Free Margin", DoubleToString(AccountFreeMargin(), 2));
    FileWrite(fileHandle, "# Server Name", AccountServer());
    FileWrite(fileHandle, "# Export Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "# Last Export", TimeToString(lastExportTime, TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "");

    FileWrite(fileHandle, "Ticket", "OpenTime", "Type", "Size", "Symbol", "OpenPrice",
              "StopLoss", "TakeProfit", "CloseTime", "ClosePrice", "Commission",
              "Swap", "Profit", "Comment", "Magic");
}

//+------------------------------------------------------------------+
//| Closed trades data                                              |
//+------------------------------------------------------------------+
int WriteTradeData(int fileHandle)
{
    int totalTrades   = OrdersHistoryTotal();
    int exportedCount = 0;
    datetime cutoffTime = TimeCurrent() - (MaxHistoryDays * 24 * 3600);

    WriteLog("Processing " + IntegerToString(totalTrades) + " historical trades");

    for(int i = 0; i < totalTrades; i++)
    {
        if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;

        if(OrderOpenTime() < cutoffTime) continue;
        // NOTE: do NOT filter by lastExportTime here. The output file is
        // <_latest.csv> and gets atomically overwritten each cycle, so the
        // watcher expects it to be a *snapshot* of the last MaxHistoryDays
        // — not an incremental delta. Filtering produced an empty file when
        // no trade closed in the last interval, which broke the watcher's
        // fold-in path (auto-closed trades could never be corrected).
        if(OrderType() > 1 && OrderCloseTime() == 0) continue; // pending cancellations

        string tradeType = "";
        switch(OrderType())
        {
            case OP_BUY:       tradeType = "buy";        break;
            case OP_SELL:      tradeType = "sell";       break;
            case OP_BUYLIMIT:  tradeType = "buy limit";  break;
            case OP_SELLLIMIT: tradeType = "sell limit"; break;
            case OP_BUYSTOP:   tradeType = "buy stop";   break;
            case OP_SELLSTOP:  tradeType = "sell stop";  break;
            default:           tradeType = "unknown";    break;
        }

        if(OrderType() <= 1 && OrderCloseTime() > 0)
        {
            int symbolDigits = (int)MarketInfo(OrderSymbol(), MODE_DIGITS);
            FileWrite(fileHandle,
                IntegerToString(OrderTicket()),
                TimeToString(OrderOpenTime(), TIME_DATE|TIME_MINUTES),
                tradeType,
                DoubleToString(OrderLots(), 2),
                OrderSymbol(),
                DoubleToString(OrderOpenPrice(), symbolDigits),
                DoubleToString(OrderStopLoss(), symbolDigits),
                DoubleToString(OrderTakeProfit(), symbolDigits),
                TimeToString(OrderCloseTime(), TIME_DATE|TIME_MINUTES),
                DoubleToString(OrderClosePrice(), symbolDigits),
                DoubleToString(OrderCommission(), 2),
                DoubleToString(OrderSwap(), 2),
                DoubleToString(OrderProfit(), 2),
                OrderComment(),
                IntegerToString(OrderMagicNumber())
            );
            exportedCount++;
        }
    }

    WriteLog("Exported " + IntegerToString(exportedCount) + " trades");
    return exportedCount;
}

//+------------------------------------------------------------------+
//| Open trades header                                              |
//+------------------------------------------------------------------+
void WriteOpenTradesAccountInfo(int fileHandle)
{
    FileWrite(fileHandle, "# Open Trades Export");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountNumber()));
    FileWrite(fileHandle, "# Account Name", AccountName());
    FileWrite(fileHandle, "# Account Currency", AccountCurrency());
    FileWrite(fileHandle, "# Account Balance", DoubleToString(AccountBalance(), 2));
    FileWrite(fileHandle, "# Account Equity", DoubleToString(AccountEquity(), 2));
    FileWrite(fileHandle, "# Broker Server Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "# Account Free Margin", DoubleToString(AccountFreeMargin(), 2));
    FileWrite(fileHandle, "# Server Name", AccountServer());
    FileWrite(fileHandle, "# Export Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "# Export Type", "OPEN_TRADES");
    FileWrite(fileHandle, "");

    FileWrite(fileHandle, "Ticket", "OpenTime", "Type", "Size", "Symbol", "OpenPrice",
              "StopLoss", "TakeProfit", "CurrentPrice", "Commission", "Swap",
              "UnrealizedPnl", "Comment", "Status", "Magic");
}

//+------------------------------------------------------------------+
//| Open trades data                                                |
//+------------------------------------------------------------------+
int WriteOpenTradesData(int fileHandle)
{
    int totalOpenTrades = OrdersTotal();
    int exportedCount   = 0;

    WriteLog("Processing " + IntegerToString(totalOpenTrades) + " open trades");

    for(int i = 0; i < totalOpenTrades; i++)
    {
        if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
        if(OrderType() > 1) continue; // skip pending orders

        int symbolDigits = (int)MarketInfo(OrderSymbol(), MODE_DIGITS);

        string tradeType = (OrderType() == OP_BUY) ? "buy" : "sell";

        double currentPrice = (OrderType() == OP_BUY)
            ? MarketInfo(OrderSymbol(), MODE_BID)
            : MarketInfo(OrderSymbol(), MODE_ASK);

        double unrealizedPnl = OrderProfit() + OrderSwap() + OrderCommission();

        FileWrite(fileHandle,
            IntegerToString(OrderTicket()),
            TimeToString(OrderOpenTime(), TIME_DATE|TIME_MINUTES),
            tradeType,
            DoubleToString(OrderLots(), 2),
            OrderSymbol(),
            DoubleToString(OrderOpenPrice(), symbolDigits),
            DoubleToString(OrderStopLoss(), symbolDigits),
            DoubleToString(OrderTakeProfit(), symbolDigits),
            DoubleToString(currentPrice, symbolDigits),
            DoubleToString(OrderCommission(), 2),
            DoubleToString(OrderSwap(), 2),
            DoubleToString(unrealizedPnl, 2),
            OrderComment(),
            "OPEN",
            IntegerToString(OrderMagicNumber())
        );
        exportedCount++;
    }

    WriteLog("Exported " + IntegerToString(exportedCount) + " open trades");
    return exportedCount;
}

//+------------------------------------------------------------------+
//| Logging                                                         |
//+------------------------------------------------------------------+
void WriteLog(string message)
{
    if(!EnableLogging) return;

    string logMessage = TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES) + " - " + message;
    Print(logMessage);

    string relativeLogName = "MT4_Exporter_" + IntegerToString(AccountNumber()) + "_log.txt";
    int logHandle = FileOpen(relativeLogName, TxtWriteFlags());
    if(logHandle != INVALID_HANDLE)
    {
        FileSeek(logHandle, 0, SEEK_END);
        FileWrite(logHandle, logMessage);
        FileClose(logHandle);
    }
}

//+------------------------------------------------------------------+
//| Manual export trigger                                           |
//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
    if(id == CHARTEVENT_KEYDOWN && lparam == 69) // 'E'
    {
        WriteLog("Manual export triggered");
        ExportTrades();
    }
}
