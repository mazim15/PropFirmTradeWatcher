//+------------------------------------------------------------------+
//|                                          MT5_TradeExporter.mq5  |
//|                        Copyright 2025, PropFirm Trade Tracker   |
//|                                                                  |
//+------------------------------------------------------------------+
#property copyright "PropFirm Trade Tracker"
#property version   "1.10"
#property strict

//--- Input parameters
input int  ExportIntervalMinutes        = 1;     // Closed trades export interval (minutes)
input int  OpenTradesIntervalSeconds    = 30;    // Open trades export interval (seconds)
input int  AccountStateIntervalSeconds  = 60;    // Account state (equity/margin) export cadence
input bool EnableExport                 = true;  // Enable/disable closed trades export
input bool EnableOpenTrades             = true;  // Enable/disable open trades export
input bool EnableAccountState           = true;  // Enable/disable live account state export
input bool EnableLogging                = true;  // Enable debug logging
input int  MaxHistoryDays               = 90;    // Maximum days of history to export
input bool UseCommonFolder              = true;  // Write into the terminal common folder

//--- Globals
datetime lastExportTime         = 0;
datetime lastOpenTradesExport   = 0;
datetime lastAccountStateExport = 0;
string   logFileName            = "";

int CsvWriteFlags() { return FILE_WRITE|FILE_CSV|FILE_ANSI|(UseCommonFolder ? FILE_COMMON : 0); }
int TxtWriteFlags() { return FILE_WRITE|FILE_READ|FILE_TXT|(UseCommonFolder ? FILE_COMMON : 0); }
int CommonFlag()    { return UseCommonFolder ? FILE_COMMON : 0; }

bool FinalizeCsv(string tmpName, string finalName)
{
    if(!FileMove(tmpName, CommonFlag(), finalName, FILE_REWRITE|CommonFlag()))
    {
        WriteLog("ERROR: FileMove failed " + tmpName + " -> " + finalName + ", err=" + IntegerToString(GetLastError()));
        return false;
    }
    return true;
}

//+------------------------------------------------------------------+
int OnInit()
{
    Print("MT5 Trade Exporter initialized (UseCommonFolder=", UseCommonFolder, ")");

    if(EnableLogging)
    {
        logFileName = "MT5_Exporter_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "_log.txt";
        WriteLog("=== MT5 Trade Exporter Started ===");
        WriteLog("Account Number: " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
        WriteLog("Account Name: " + AccountInfoString(ACCOUNT_NAME));
        WriteLog("Export Interval: " + IntegerToString(ExportIntervalMinutes) + " minutes");
        WriteLog(UseCommonFolder
                  ? "Files will be written to terminal Common\\Files (FILE_COMMON)."
                  : "Files will be written to MQL5\\Files\\ (per-terminal sandbox).");
    }

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

void OnDeinit(const int reason)
{
    WriteLog("=== MT5 Trade Exporter Stopped ===");
    EventKillTimer();
}

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

    string finalName = "trades_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "_latest.csv";
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

    if(!FinalizeCsv(tmpName, finalName)) return;

    lastExportTime = TimeCurrent();
    WriteLog("Export completed: " + IntegerToString(tradesExported) + " positions -> " + finalName);
}

void ExportOpenTrades()
{
    WriteLog("Starting open trades export...");

    string finalName = "open_trades_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "_latest.csv";
    string tmpName   = finalName + ".tmp";

    int fileHandle = FileOpen(tmpName, CsvWriteFlags());
    if(fileHandle == INVALID_HANDLE)
    {
        WriteLog("ERROR: Could not create open trades temp file: " + tmpName + ", err=" + IntegerToString(GetLastError()));
        return;
    }

    WriteOpenTradesAccountInfo(fileHandle);
    int openTradesExported = WriteOpenTradesData(fileHandle);
    FileClose(fileHandle);

    if(!FinalizeCsv(tmpName, finalName)) return;

    lastOpenTradesExport = TimeCurrent();
    WriteLog("Open trades export completed: " + IntegerToString(openTradesExported) + " -> " + finalName);
}

void ExportAccountState()
{
    string finalName = "account_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "_state.csv";
    string tmpName   = finalName + ".tmp";

    int fileHandle = FileOpen(tmpName, CsvWriteFlags());
    if(fileHandle == INVALID_HANDLE)
    {
        WriteLog("ERROR: Could not create account state temp file, err=" + IntegerToString(GetLastError()));
        return;
    }

    double balance     = AccountInfoDouble(ACCOUNT_BALANCE);
    double equity      = AccountInfoDouble(ACCOUNT_EQUITY);
    double margin      = AccountInfoDouble(ACCOUNT_MARGIN);
    double freeMargin  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
    double marginLevel = (margin > 0) ? (equity / margin * 100.0) : 0.0;
    double profit      = AccountInfoDouble(ACCOUNT_PROFIT);

    FileWrite(fileHandle, "# Account State");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
    FileWrite(fileHandle, "# Account Currency", AccountInfoString(ACCOUNT_CURRENCY));
    FileWrite(fileHandle, "# Server Name", AccountInfoString(ACCOUNT_SERVER));
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
    if(!FinalizeCsv(tmpName, finalName)) return;
    lastAccountStateExport = TimeCurrent();
}

//+------------------------------------------------------------------+
//| Account info / CSV header                                        |
//+------------------------------------------------------------------+
void WriteAccountInfo(int fileHandle)
{
    FileWrite(fileHandle, "# Account Information");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
    FileWrite(fileHandle, "# Account Name", AccountInfoString(ACCOUNT_NAME));
    FileWrite(fileHandle, "# Account Currency", AccountInfoString(ACCOUNT_CURRENCY));
    FileWrite(fileHandle, "# Account Balance", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2));
    FileWrite(fileHandle, "# Account Equity", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2));
    FileWrite(fileHandle, "# Broker Server Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "# Account Free Margin", DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2));
    FileWrite(fileHandle, "# Server Name", AccountInfoString(ACCOUNT_SERVER));
    FileWrite(fileHandle, "# Export Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "# Last Export", TimeToString(lastExportTime, TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "");

    FileWrite(fileHandle, "Ticket", "OpenTime", "Type", "Size", "Symbol", "OpenPrice",
              "StopLoss", "TakeProfit", "CloseTime", "ClosePrice", "Commission",
              "Swap", "Profit", "Comment", "Magic");
}

//+------------------------------------------------------------------+
//| Closed trades — aggregate per position (handles partial closes). |
//| One CSV row per DEAL_POSITION_ID, summing volume/profit/swap/    |
//| commission across all exit deals; SL/TP pulled from the matching |
//| entry order. Uses a small dynamic array to dedupe position ids   |
//| we've already exported in this pass.                              |
//+------------------------------------------------------------------+
int WriteTradeData(int fileHandle)
{
    datetime cutoffTime = TimeCurrent() - (MaxHistoryDays * 24 * 3600);
    if(!HistorySelect(cutoffTime, TimeCurrent()))
    {
        WriteLog("ERROR: Failed to select history data");
        return 0;
    }

    int totalDeals    = HistoryDealsTotal();
    int exportedCount = 0;

    WriteLog("Processing " + IntegerToString(totalDeals) + " historical deals (aggregating by position)");

    ulong processed[];
    int   processedSize = 0;

    for(int i = 0; i < totalDeals; i++)
    {
        ulong dealTicket = HistoryDealGetTicket(i);
        if(dealTicket == 0) continue;

        long dealEntry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
        if(dealEntry != DEAL_ENTRY_OUT && dealEntry != DEAL_ENTRY_INOUT) continue;

        long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
        if(dealType != DEAL_TYPE_BUY && dealType != DEAL_TYPE_SELL) continue;

        ulong positionId = (ulong)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
        if(positionId == 0) continue;

        // Skip if we've already aggregated this position in this pass.
        bool seen = false;
        for(int p = 0; p < processedSize; p++)
            if(processed[p] == positionId) { seen = true; break; }
        if(seen) continue;

        if(WritePositionAggregate(fileHandle, positionId)) exportedCount++;

        ArrayResize(processed, processedSize + 1);
        processed[processedSize] = positionId;
        processedSize++;
    }

    WriteLog("Exported " + IntegerToString(exportedCount) + " positions");
    return exportedCount;
}

//+------------------------------------------------------------------+
//| Aggregate one position's deals into a single CSV row.           |
//| Returns true if a row was written.                              |
//+------------------------------------------------------------------+
bool WritePositionAggregate(int fileHandle, ulong positionId)
{
    if(!HistorySelectByPosition(positionId)) return false;

    int totalDeals = HistoryDealsTotal();
    if(totalDeals == 0) return false;

    // Entry-deal data (taken from DEAL_ENTRY_IN).
    bool   haveEntry      = false;
    datetime openTime     = 0;
    double openPrice      = 0;
    double openVolumeAcc  = 0;        // total opening volume across IN deals
    double openCommission = 0;
    string symbol         = "";
    string entryComment   = "";
    long   entryDealType  = 0;
    long   magic          = 0;
    ulong  entryOrderTicket = 0;

    // Exit-deal aggregates.
    double closeVolume    = 0;
    double weightedClose  = 0;        // sum(price * volume) for VWAP
    datetime lastCloseTime = 0;
    double sumProfit      = 0;
    double sumSwap        = 0;
    double sumCloseCommission = 0;
    string lastExitComment = "";
    bool   sawExit        = false;
    long   lastExitReason = -1;

    // Skip stale exits we already exported.
    bool everAfterLastExport = false;

    for(int i = 0; i < totalDeals; i++)
    {
        ulong dt = HistoryDealGetTicket(i);
        if(dt == 0) continue;

        long entry = HistoryDealGetInteger(dt, DEAL_ENTRY);
        long type  = HistoryDealGetInteger(dt, DEAL_TYPE);

        if(entry == DEAL_ENTRY_IN && (type == DEAL_TYPE_BUY || type == DEAL_TYPE_SELL))
        {
            datetime t = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
            double v = HistoryDealGetDouble(dt, DEAL_VOLUME);
            if(!haveEntry || t < openTime) openTime = t;
            // Volume-weighted entry price (covers multi-leg-in adds).
            double price = HistoryDealGetDouble(dt, DEAL_PRICE);
            openPrice = (openVolumeAcc + v > 0)
                ? (openPrice * openVolumeAcc + price * v) / (openVolumeAcc + v)
                : price;
            openVolumeAcc += v;
            openCommission += HistoryDealGetDouble(dt, DEAL_COMMISSION);
            symbol         = HistoryDealGetString(dt, DEAL_SYMBOL);
            entryComment   = HistoryDealGetString(dt, DEAL_COMMENT);
            entryDealType  = type;
            magic          = HistoryDealGetInteger(dt, DEAL_MAGIC);
            entryOrderTicket = (ulong)HistoryDealGetInteger(dt, DEAL_ORDER);
            haveEntry      = true;
        }
        else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_INOUT)
        {
            if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;

            datetime t = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
            double v   = HistoryDealGetDouble(dt, DEAL_VOLUME);
            double pr  = HistoryDealGetDouble(dt, DEAL_PRICE);

            if(t > lastCloseTime) {
                lastCloseTime  = t;
                lastExitComment = HistoryDealGetString(dt, DEAL_COMMENT);
                lastExitReason  = HistoryDealGetInteger(dt, DEAL_REASON);
            }
            if(lastExportTime == 0 || t > lastExportTime) everAfterLastExport = true;

            closeVolume      += v;
            weightedClose    += pr * v;
            sumProfit        += HistoryDealGetDouble(dt, DEAL_PROFIT);
            sumSwap          += HistoryDealGetDouble(dt, DEAL_SWAP);
            sumCloseCommission += HistoryDealGetDouble(dt, DEAL_COMMISSION);
            sawExit = true;
        }
    }

    if(!haveEntry || !sawExit) return false;
    // NOTE: do NOT skip based on lastExportTime here. The output file is
    // <_latest.csv> and gets atomically overwritten each cycle, so the
    // watcher expects it to be a *snapshot* of the last MaxHistoryDays —
    // not an incremental delta. Filtering produced an empty file when no
    // position closed in the last interval, which broke the watcher's
    // fold-in path (auto-closed trades could never be corrected).

    double closePrice = (closeVolume > 0) ? (weightedClose / closeVolume) : 0.0;

    // SL/TP from the entry order (deal history alone doesn't carry them).
    double slPrice = 0, tpPrice = 0;
    if(entryOrderTicket != 0 && HistoryOrderSelect(entryOrderTicket))
    {
        slPrice = HistoryOrderGetDouble(entryOrderTicket, ORDER_SL);
        tpPrice = HistoryOrderGetDouble(entryOrderTicket, ORDER_TP);
    }

    int symbolDigits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

    string tradeType = (entryDealType == DEAL_TYPE_BUY) ? "buy" : "sell";

    // Net commission = entry + sum of exit commissions.
    double commission = openCommission + sumCloseCommission;

    string comment = (StringLen(lastExitComment) > 0) ? lastExitComment : entryComment;

    FileWrite(fileHandle,
        IntegerToString(positionId),                       // Ticket = position id (stable)
        TimeToString(openTime, TIME_DATE|TIME_MINUTES),
        tradeType,
        DoubleToString(closeVolume, 2),                    // size = total closed volume
        symbol,
        DoubleToString(openPrice, symbolDigits),
        DoubleToString(slPrice, symbolDigits),
        DoubleToString(tpPrice, symbolDigits),
        TimeToString(lastCloseTime, TIME_DATE|TIME_MINUTES),
        DoubleToString(closePrice, symbolDigits),
        DoubleToString(commission, 2),
        DoubleToString(sumSwap, 2),
        DoubleToString(sumProfit, 2),
        comment,
        IntegerToString(magic)
    );
    return true;
}

//+------------------------------------------------------------------+
//| Open trades                                                     |
//+------------------------------------------------------------------+
double GetPositionOpenCommission(ulong positionTicket)
{
    if(!HistorySelectByPosition(positionTicket)) return 0.0;
    int totalDeals = HistoryDealsTotal();
    double commission = 0.0;
    for(int i = 0; i < totalDeals; i++)
    {
        ulong dt = HistoryDealGetTicket(i);
        if(dt == 0) continue;
        if(HistoryDealGetInteger(dt, DEAL_ENTRY) == DEAL_ENTRY_IN)
            commission += HistoryDealGetDouble(dt, DEAL_COMMISSION);
    }
    return commission;
}

void WriteOpenTradesAccountInfo(int fileHandle)
{
    FileWrite(fileHandle, "# Open Trades Export");
    FileWrite(fileHandle, "# Account Number", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
    FileWrite(fileHandle, "# Account Name", AccountInfoString(ACCOUNT_NAME));
    FileWrite(fileHandle, "# Account Currency", AccountInfoString(ACCOUNT_CURRENCY));
    FileWrite(fileHandle, "# Account Balance", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2));
    FileWrite(fileHandle, "# Account Equity", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2));
    FileWrite(fileHandle, "# Broker Server Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
    FileWrite(fileHandle, "# Account Free Margin", DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2));
    FileWrite(fileHandle, "# Server Name", AccountInfoString(ACCOUNT_SERVER));
    FileWrite(fileHandle, "# Export Time", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES));
    FileWrite(fileHandle, "# Export Type", "OPEN_TRADES");
    FileWrite(fileHandle, "");

    FileWrite(fileHandle, "Ticket", "OpenTime", "Type", "Size", "Symbol", "OpenPrice",
              "StopLoss", "TakeProfit", "CurrentPrice", "Commission", "Swap",
              "UnrealizedPnl", "Comment", "Status", "Magic");
}

int WriteOpenTradesData(int fileHandle)
{
    int totalPositions = PositionsTotal();
    int exportedCount  = 0;

    WriteLog("Processing " + IntegerToString(totalPositions) + " open positions");

    for(int i = 0; i < totalPositions; i++)
    {
        string symbol = PositionGetSymbol(i);
        if(symbol == "") continue;

        ulong  ticket    = PositionGetInteger(POSITION_TICKET);
        datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
        long   posType   = PositionGetInteger(POSITION_TYPE);
        double volume    = PositionGetDouble(POSITION_VOLUME);
        double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
        double sl        = PositionGetDouble(POSITION_SL);
        double tp        = PositionGetDouble(POSITION_TP);
        double commission = GetPositionOpenCommission(ticket);
        double swap      = PositionGetDouble(POSITION_SWAP);
        double profit    = PositionGetDouble(POSITION_PROFIT);
        string comment   = PositionGetString(POSITION_COMMENT);
        long   magic     = PositionGetInteger(POSITION_MAGIC);

        int symbolDigits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

        string tradeType    = (posType == POSITION_TYPE_BUY) ? "buy" : "sell";
        double currentPrice = (posType == POSITION_TYPE_BUY)
            ? SymbolInfoDouble(symbol, SYMBOL_BID)
            : SymbolInfoDouble(symbol, SYMBOL_ASK);

        double unrealizedPnl = profit + swap + commission;

        FileWrite(fileHandle,
            IntegerToString(ticket),
            TimeToString(openTime, TIME_DATE|TIME_MINUTES),
            tradeType,
            DoubleToString(volume, 2),
            symbol,
            DoubleToString(openPrice, symbolDigits),
            DoubleToString(sl, symbolDigits),
            DoubleToString(tp, symbolDigits),
            DoubleToString(currentPrice, symbolDigits),
            DoubleToString(commission, 2),
            DoubleToString(swap, 2),
            DoubleToString(unrealizedPnl, 2),
            comment,
            "OPEN",
            IntegerToString(magic)
        );
        exportedCount++;
    }

    WriteLog("Exported " + IntegerToString(exportedCount) + " open positions");
    return exportedCount;
}

//+------------------------------------------------------------------+
void WriteLog(string message)
{
    if(!EnableLogging) return;

    string logMessage = TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES) + " - " + message;
    Print(logMessage);

    string relativeLogName = "MT5_Exporter_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "_log.txt";
    int logHandle = FileOpen(relativeLogName, TxtWriteFlags());
    if(logHandle != INVALID_HANDLE)
    {
        FileSeek(logHandle, 0, SEEK_END);
        FileWrite(logHandle, logMessage);
        FileClose(logHandle);
    }
}

void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
    if(id == CHARTEVENT_KEYDOWN && lparam == 69)
    {
        WriteLog("Manual export triggered");
        ExportTrades();
    }
}
