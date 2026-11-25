import assert from 'node:assert/strict';
import { test } from 'node:test';
import { server, plain } from './helpers.mjs';

function fixture(options = {}) {
  const headers = options.headers || ['name', 'url', 'hidden', 'id', 'tags', 'description', 'icon'];
  const rows = [headers, ...(options.rows || [])];
  const properties = { SPREADSHEET_ID: 'sheet-1', SHEET_NAME: '' };
  const writes = [], removed = [];
  let scriptLocked = false, userLocked = false;
  const app = server({ userProperties: properties,
    LockService: {
      getScriptLock: () => ({ waitLock() { scriptLocked = true; options.onLock?.(rows, properties); }, releaseLock() { scriptLocked = false; } }),
      getUserLock: () => ({ waitLock() { userLocked = true; }, releaseLock() { userLocked = false; } }),
    },
    CacheService: { getUserCache: () => ({ remove(key) { removed.push(key); } }) },
    Sheets: { Spreadsheets: {
      get() { if (options.failRead) throw new Error('Private Google error'); return { properties: { title: 'My Links' }, sheets: [
        { properties: { sheetId: 7, title: "Work's Links", index: 0, gridProperties: { rowCount: options.rowCount || 3 } }, tables: options.noTable ? [] : [{ tableId: 'links-table', range: { sheetId: 7, startRowIndex: 0, startColumnIndex: 0, endRowIndex: 3, endColumnIndex: headers.length } }] },
      ] }; },
      Values: { get(_id, range, args) { assert.equal(range, "'Work''s Links'"); return { values: args.valueRenderOption === 'FORMULA' && options.formulas ? options.formulas : rows }; } },
      batchUpdate(batch, id) {
        assert.equal(id, properties.SPREADSHEET_ID); assert.ok(scriptLocked && userLocked);
        writes.push(plain(batch));
        if (options.failWrite) throw new Error('Private token/API error');
        options.onWrite?.(rows);
        for (const request of batch.requests) if (request.appendCells) {
          request.appendCells.rows.forEach(row => rows.push(row.values.map(cell => cell.userEnteredValue.stringValue ?? cell.userEnteredValue.boolValue)));
        }
      },
    } },
  });
  return { ...app, rows, properties, writes, removed, unlocked: () => !scriptLocked && !userLocked };
}
const bookmark = (url, name = 'Bookmark', tags = []) => ({ name, url, tags });
const payload = { bookmarks: [bookmark('https://new.example/#one', '=IMPORTXML("private")', ['Work'])] };

test('Preview includes hidden and related rows in deduplication without exposing existing content', () => {
  const app = fixture({ rows: [['Hidden', 'https://hidden.test/', true, 'hidden'], ['Child', 'https://child.test/', false, '']] });
  const result = plain(app.context.previewBookmarkImport({ bookmarks: [bookmark('https://hidden.test/'), bookmark('https://child.test/'), ...payload.bookmarks, ...payload.bookmarks, bookmark('javascript:alert(1)')] }));
  assert.equal(result.ok, true); assert.equal(result.received, 5); assert.equal(result.duplicates, 3); assert.equal(result.invalid, 1);
  assert.equal(result.additions.length, 1); assert.equal(result.destination.sheetId, 7);
  assert.equal(app.writes.length, 0); assert.ok(!JSON.stringify(result).includes('Hidden'));
});
test('Import uses headers, literal strings, table appends and invalidates the cache; retries add nothing', () => {
  const app = fixture({ rows: [['Existing', 'https://existing.test', false, 'old'], ['', '', false, '']], rowCount: 2 });
  const preview = plain(app.context.previewBookmarkImport(payload));
  const request = { ...payload, destination: preview.destination };
  const result = plain(app.context.importBookmarks(request));
  assert.equal(result.added, 1); assert.equal(app.writes.length, 1); assert.ok(app.unlocked());
  const cells = app.writes[0].requests[0].appendCells;
  assert.equal(cells.tableId, 'links-table');
  assert.equal(cells.sheetId, undefined);
  assert.equal(cells.rows[0].values[0].userEnteredValue.stringValue, '=IMPORTXML("private")');
  assert.equal(cells.rows[0].values[3].userEnteredValue.stringValue, preview.additions[0].id);
  assert.equal(cells.rows[0].values[4].userEnteredValue.stringValue, 'Work');
  assert.equal(app.writes[0].requests.length, 1);
  assert.match(app.removed[0], /^catalog-v7:/);
  assert.equal(app.context.importBookmarks(request).added, 0); assert.equal(app.writes.length, 1);
});
test('Recheck catches URLs inserted after preview and refuses a changed destination', () => {
  const app = fixture(); const preview = app.context.previewBookmarkImport(payload);
  app.rows.push(['From another edit', payload.bookmarks[0].url, false, 'manual']);
  assert.equal(app.context.importBookmarks({ ...payload, destination: preview.destination }).added, 0);
  assert.equal(app.context.importBookmarks({ ...payload, destination: { ...preview.destination, sheetId: 999 } }).error, 'BOOKMARK_DESTINATION_CHANGED');
  app.properties.SPREADSHEET_ID = 'another-sheet';
  assert.equal(app.context.importBookmarks({ ...payload, destination: preview.destination }).error, 'BOOKMARK_DESTINATION_CHANGED');
  assert.equal(app.writes.length, 0);
});
test('Without a table, Sheets appends by sheet ID without overwriting late edits or empty-display formulas', () => {
  const formula = ['', '', false, '', '=IF(TRUE,"","")'];
  const lateEdit = ['Concurrent manual entry', 'https://manual.test/', false, 'manual'];
  const app = fixture({ noTable: true, rows: [formula], onWrite: rows => rows.push(lateEdit) });
  const preview = app.context.previewBookmarkImport(payload);
  assert.equal(app.context.importBookmarks({ ...payload, destination: preview.destination }).added, 1);
  assert.equal(app.writes[0].requests[0].appendCells.sheetId, 7);
  assert.equal(app.writes[0].requests[0].appendCells.tableId, undefined);
  assert.deepEqual(app.rows[1], formula); assert.deepEqual(app.rows[2], lateEdit);
  assert.equal(app.rows[3][1], payload.bookmarks[0].url);
});
test('Errors are bounded, invalid destinations never write and ambiguous write failures invalidate cache', () => {
  const app = fixture();
  assert.equal(app.context.previewBookmarkImport({ bookmarks: Array(1001).fill(payload.bookmarks[0]) }).error, 'BOOKMARK_INVALID_INPUT');
  assert.equal(app.context.importBookmarks(payload).error, 'BOOKMARK_DESTINATION_CHANGED');
  assert.equal(fixture({ failRead: true }).context.previewBookmarkImport(payload).error, 'BOOKMARK_READ_FAILED');
  const failing = fixture({ failWrite: true });
  const result = failing.context.importBookmarks({ ...payload, destination: failing.context.previewBookmarkImport(payload).destination });
  assert.equal(result.error, 'BOOKMARK_WRITE_FAILED'); assert.equal(failing.removed.length, 1); assert.ok(failing.unlocked());
  assert.ok(!JSON.stringify(result).includes('Private'));
});
test('Queries and fragments stay distinct and existing ID collisions never overwrite entries', () => {
  const app = fixture(); const id = app.context.previewBookmarkImport(payload).additions[0].id;
  app.rows.push(['Manual ID', 'https://other.test/', false, id]);
  const result = app.context.previewBookmarkImport({ bookmarks: [...payload.bookmarks, bookmark('https://new.example/#two'), bookmark('https://new.example/?a=1'), bookmark('https://new.example/?a=2')] });
  assert.equal(result.additions.length, 4); assert.notEqual(result.additions[0].id, id);
});
