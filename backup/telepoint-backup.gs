/**
 * TelePoint → Google Sheets automatic backup.
 *
 * Polls the portal's /api/backup feed and mirrors every table into its own tab
 * of this spreadsheet. Each run fully refreshes the data (all historical rows
 * included), so the sheet is always a complete, up-to-date copy of the DB.
 *
 * SETUP (see backup/README.md for the full walkthrough):
 *   1. Open your backup Google Sheet → Extensions → Apps Script.
 *   2. Paste this file in, then set the two Script Properties below
 *      (Project Settings → Script properties):
 *        PORTAL_URL   e.g. https://your-portal.vercel.app
 *        BACKUP_TOKEN the same secret you set as BACKUP_TOKEN on the server
 *   3. Run `setupTrigger` once (authorize when prompted).
 *      It installs a time trigger that runs `backupAll` every minute.
 *   4. Run `backupAll` once manually to do the first full pull.
 */

// Tables to mirror. Each becomes a tab with the same name.
var TABLES = [
  'retailers',
  'customers',
  'emi_schedule',
  'payment_requests',
  'payment_request_items',
  'fine_settings',
  'broadcast_messages',
  'audit_log',
];

function _config_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('PORTAL_URL');
  var token = props.getProperty('BACKUP_TOKEN');
  if (!url || !token) {
    throw new Error('Set PORTAL_URL and BACKUP_TOKEN in Project Settings → Script properties.');
  }
  return { url: url.replace(/\/+$/, ''), token: token };
}

function _fetchTable_(cfg, table) {
  var endpoint = cfg.url + '/api/backup?table=' + encodeURIComponent(table);
  var res = UrlFetchApp.fetch(endpoint, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + cfg.token },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Fetch ' + table + ' failed (HTTP ' + code + '): ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/**
 * Writes one table's rows into its tab, replacing whatever was there.
 * Columns are taken from the API's `columns` list (stable order).
 */
function _writeSheet_(ss, table, payload) {
  var sheet = ss.getSheetByName(table) || ss.insertSheet(table);
  sheet.clearContents();

  var columns = payload.columns || [];
  var rows = payload.rows || [];

  if (columns.length === 0) {
    sheet.getRange(1, 1).setValue('(no rows) — last synced ' + payload.generated_at);
    return rows.length;
  }

  var values = [columns];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var line = [];
    for (var c = 0; c < columns.length; c++) {
      var v = row[columns[c]];
      if (v === null || v === undefined) {
        line.push('');
      } else if (typeof v === 'object') {
        line.push(JSON.stringify(v)); // jsonb / arrays → string
      } else {
        line.push(v);
      }
    }
    values.push(line);
  }

  sheet.getRange(1, 1, values.length, columns.length).setValues(values);
  sheet.setFrozenRows(1);
  return rows.length;
}

/** Pulls every table and refreshes all tabs. Safe to run on a timer. */
function backupAll() {
  var cfg = _config_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary = [];

  for (var i = 0; i < TABLES.length; i++) {
    var table = TABLES[i];
    try {
      var payload = _fetchTable_(cfg, table);
      var n = _writeSheet_(ss, table, payload);
      summary.push(table + ': ' + n);
    } catch (err) {
      summary.push(table + ': ERROR ' + err.message);
    }
  }

  // A small status tab so you can see the last sync at a glance.
  var status = ss.getSheetByName('_sync_status') || ss.insertSheet('_sync_status');
  status.clearContents();
  status.getRange(1, 1, 1, 2).setValues([['Last sync (IST)', _nowIst_()]]);
  status.getRange(3, 1, summary.length, 1).setValues(summary.map(function (s) { return [s]; }));
}

function _nowIst_() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Installs a 1-minute time trigger for backupAll (the shortest Apps Script
 * allows — "near real-time"). Removes any existing backupAll triggers first so
 * re-running this never stacks duplicates.
 */
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'backupAll') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('backupAll').timeBased().everyMinutes(1).create();
  backupAll(); // do an immediate first sync
}

/** Removes the backup trigger (stop automatic syncing). */
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'backupAll') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
