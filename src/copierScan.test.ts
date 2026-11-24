import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetFile, toEndpoints, type ScanOutput } from './copierScan';

test('parseSetFile reads MT4 lines', () => {
  assert.deepEqual(parseSetFile('Channel=FN2\r\nUseFixedLotSize=0.23\r\n'), { Channel: 'FN2', UseFixedLotSize: '0.23' });
});

test("parseSetFile cuts MT5 '||' suffixes and a BOM", () => {
  const s = parseSetFile('\uFEFFChannel=AzeemBBF\nHeartbeatPeriodSeconds=10||10||1||100||N\n');
  assert.equal(s.HeartbeatPeriodSeconds, '10');
  assert.equal(s.Channel, 'AzeemBBF');
});

test('parseSetFile skips section headers without throwing', () => {
  assert.doesNotThrow(() => parseSetFile('s_Server==== Server settings ===\nChannel=X\n'));
  assert.equal(parseSetFile('s_Server==== Server settings ===\nChannel=X\n').Channel, 'X');
});

const scannedAt = '2026-11-21T10:00:00.000Z';
const recvSet = (ch: string, lot: string, inv: string) =>
  `Channel=${ch}\r\nUseFixedLotSize=${lot}\r\nInvertTrades=${inv}\r\nAlertIfHeartbeatMissingSeconds=0\r\n`;

test('toEndpoints maps sender, receiver, exporter and ignores other EAs', () => {
  const raw: ScanOutput = {
    scannedAt,
    terminals: [
      { kind: 'mt4', path: 'C:\\Exness', dataFolder: 'EX4', login: '13003534', error: null, eas: [
        { title: 'TradeCopy Receiver', set: recvSet('FN2', '0.23', 'true') },
        { title: 'TradeCopy Receiver', set: recvSet('Areeb', '0.33', 'true') },
      ] },
      { kind: 'mt5', path: 'C:\\BBF', dataFolder: '7DCE', login: '12150589', error: null, eas: [
        { title: 'TradeCopy Sender', set: 'Channel=FN2||0||0||0||N\n' },
        { title: 'MT5_TradeExporter', set: null },
        { title: 'SuperTrend', set: null },
      ] },
    ],
  };
  const rows = toEndpoints(raw, 'w1', 'azeem-pc');
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(r => r.role === 'terminal').length, 2);
  assert.equal(rows.filter(r => r.role === 'receiver').length, 2);
  assert.equal(rows.filter(r => r.role === 'sender').length, 1);
  assert.equal(rows.filter(r => r.role === 'exporter').length, 1);
  const fn2 = rows.find(r => r.role === 'receiver' && r.channel === 'FN2')!;
  assert.equal(fn2.lot, 0.23);
  assert.equal(fn2.invert, true);
  assert.equal(fn2.login, '13003534');
  const sender = rows.find(r => r.role === 'sender')!;
  assert.equal(sender.channel, 'FN2');
  assert.equal(sender.lot, null);
  assert.equal(sender.watcherId, 'w1');
  assert.equal(sender.scannedAt, scannedAt);
});

test('toEndpoints keeps a failed terminal with its error and no EA rows', () => {
  const rows = toEndpoints({ scannedAt, terminals: [
    { kind: 'mt4', path: 'C:\\X', dataFolder: 'D', login: '1', error: 'MDIClient not found', eas: [] },
  ] }, 'w1', 'pc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'terminal');
  assert.equal(rows[0].error, 'MDIClient not found');
});

test('the terminal row carries the kept sender channel', () => {
  const raw = { scannedAt: '2026-11-24T00:00:00Z', terminals: [
    { kind: 'mt5' as const, path: 'p', dataFolder: 'd', login: '1', error: null, eas: [], keptChannel: 'FN2' },
    { kind: 'mt5' as const, path: 'q', dataFolder: 'e', login: '2', error: null, eas: [] },
  ] };
  assert.deepEqual(toEndpoints(raw, 'w', 'pc').map(e => e.channel), ['FN2', null]);
});
