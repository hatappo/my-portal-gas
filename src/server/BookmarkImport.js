/** @typedef {{name: string, url: string, tags: string[]}} ImportedBookmark */
/** Validate before accessing Google services. No HTML or formula interpretation.
 * @param {unknown} input @returns {{bookmarks: ImportedBookmark[], invalid: number}}
 */
function validateBookmarkImport_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('BOOKMARK_INVALID_INPUT');
  const request = /** @type {{bookmarks?: unknown}} */ (input);
  if (!Array.isArray(request.bookmarks) || request.bookmarks.length > 1000 || JSON.stringify(input).length > 1000000) throw new Error('BOOKMARK_INVALID_INPUT');
  let invalid = 0;
  /** @type {ImportedBookmark[]} */
  const bookmarks = [];
  for (const item of request.bookmarks) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.name !== 'string') { invalid++; continue; }
    const url = item.url.trim();
    // Preserve queries/fragments and path case. Only trim surrounding whitespace.
    // eslint-disable-next-line no-control-regex -- Reject control bytes in imported URLs.
    if (!/^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i.test(url) || url.length > 8192 || item.name.length > 1000 || /[\u0000-\u001f\u007f]/.test(url)) { invalid++; continue; }
    const tags = Array.isArray(item.tags) ? item.tags.filter((/** @type {unknown} */ tag) => typeof tag === 'string').map((/** @type {string} */ tag) => tag.trim()).filter(Boolean) : [];
    if (tags.length > 20 || tags.some((/** @type {string} */ tag) => tag.length > 100 || /[,、\r\n]/.test(tag))) { invalid++; continue; }
    bookmarks.push({ name: item.name.trim() || url, url, tags: [...new Set(tags)] });
  }
  return { bookmarks, invalid };
}

/** Read unfiltered rows, including hidden entries and child URLs.
 * @param {{id: string, name: string}} source
 */
function bookmarkImportSheet_(source) {
  if (!Sheets) throw new Error('SHEETS_SERVICE_DISABLED');
  const metadata = Sheets.Spreadsheets.get(source.id, { fields: 'spreadsheetId,properties(title),sheets(properties,tables)' });
  const sheet = source.name ? metadata.sheets?.find((sheet) => sheet.properties?.title === source.name)
    : metadata.sheets?.slice().sort((a, b) => (a.properties?.index || 0) - (b.properties?.index || 0))[0];
  if (!sheet?.properties?.title || sheet.properties.sheetId === undefined) throw new Error('SHEET_NOT_FOUND');
  const range = "'" + sheet.properties.title.replace(/'/g, "''") + "'";
  const rows = Sheets.Spreadsheets.Values.get(source.id, range, { valueRenderOption: 'FORMATTED_VALUE' }).values || [];
  const headers = (rows[0] || []).map((value) => String(value ?? '').trim());
  const named = headers.filter(Boolean);
  if (new Set(named).size !== named.length || !['id', 'name', 'url'].every((key) => headers.includes(key))) throw new Error('INVALID_SHEET_HEADERS');
  return { sheet, headers, rows, range, destination: { id: source.id, sheetId: sheet.properties.sheetId, name: sheet.properties.title, title: metadata.properties?.title || source.id } };
}

/** @param {ReturnType<typeof validateBookmarkImport_>} input @param {unknown[][]} rows @param {string[]} headers */
function planBookmarkImport_(input, rows, headers) {
  const known = new Set(rows.slice(1).map((row) => String(row[headers.indexOf('url')] ?? '').trim()).filter(Boolean));
  const ids = new Set(rows.slice(1).map((row) => String(row[headers.indexOf('id')] ?? '').trim()).filter(Boolean));
  let duplicates = 0;
  const additions = [];
  for (const bookmark of input.bookmarks) {
    if (known.has(bookmark.url)) { duplicates++; continue; }
    known.add(bookmark.url);
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bookmark.url, Utilities.Charset.UTF_8);
    const base = 'chrome-' + digest.map((byte) => (byte & 255).toString(16).padStart(2, '0')).join('').slice(0, 24);
    let id = base, suffix = 1;
    while (ids.has(id)) id = base + '-' + suffix++;
    ids.add(id);
    additions.push({ ...bookmark, id });
  }
  return { additions, duplicates, invalid: input.invalid, received: input.bookmarks.length + input.invalid };
}

/** @param {unknown} input */
function previewBookmarkImport(input) {
  try {
    const validated = validateBookmarkImport_(input);
    const target = bookmarkImportSheet_(getSheetSource_());
    return { ok: true, ...planBookmarkImport_(validated, target.rows, target.headers), destination: target.destination };
  } catch (error) { return bookmarkImportError_(error, false); }
}

/** Append only after rechecking the configured destination and all current URLs.
 * @param {unknown} input
 */
function importBookmarks(input) {
  let writing = false;
  try {
    const validated = validateBookmarkImport_(input);
    const expected = /** @type {{destination?: {id?: unknown, sheetId?: unknown}}} */ (input).destination;
    if (!expected || typeof expected.id !== 'string' || !Number.isInteger(expected.sheetId)) throw new Error('BOOKMARK_DESTINATION_CHANGED');
    return withPortalPropertiesLock_(() => {
      if (!Sheets) throw new Error('SHEETS_SERVICE_DISABLED');
      const source = getSheetSource_();
      if (source.id !== expected.id) throw new Error('BOOKMARK_DESTINATION_CHANGED');
      const target = bookmarkImportSheet_(source);
      if (target.destination.sheetId !== expected.sheetId) throw new Error('BOOKMARK_DESTINATION_CHANGED');
      const plan = planBookmarkImport_(validated, target.rows, target.headers);
      if (!plan.additions.length) return { ok: true, ...plan, added: 0, destination: target.destination };
      // Let Sheets choose the append position at write time. Never overwrite a row
      // that another editor may have filled since the read above.
      const table = target.sheet.tables?.find(table => table.tableId && table.range &&
        (table.range.startRowIndex || 0) === 0 && (table.range.startColumnIndex || 0) === 0 &&
        table.range.endColumnIndex === target.headers.length);
      /** @type {GoogleAppsScript.Sheets.Schema.Request[]} */
      const requests = [{ appendCells: {
        ...(table ? { tableId: table.tableId } : { sheetId: target.destination.sheetId }),
        fields: 'userEnteredValue',
        rows: plan.additions.map((bookmark) => ({ values: target.headers.map((header) => {
          if (header === 'hidden') return { userEnteredValue: { boolValue: false } };
          const values = { id: bookmark.id, name: bookmark.name, url: bookmark.url, tags: bookmark.tags.join(', '), description: '', icon: '' };
          return { userEnteredValue: { stringValue: /** @type {Record<string, string>} */ (values)[header] || '' } };
        }) })),
      } }];
      const lock = LockService.getUserLock();
      lock.waitLock(10000);
      try {
        writing = true;
        // Append literal values; Sheets extends the table/grid as needed.
        Sheets.Spreadsheets.batchUpdate({ requests }, source.id);
      } finally {
        // Also invalidate on an ambiguous response: a timed-out write may have succeeded.
        try { CacheService.getUserCache().remove(sheetCatalogCacheKey_(source)); } catch { /* Cache must not turn a successful import into an error. */ }
        lock.releaseLock();
      }
      return { ok: true, ...plan, added: plan.additions.length, destination: target.destination };
    });
  } catch (error) { return bookmarkImportError_(error, writing); }
}

/** Never return Google error payloads or sheet content to the extension.
 * @param {unknown} error @param {boolean} writing
 */
function bookmarkImportError_(error, writing) {
  const code = error instanceof Error ? error.message : '';
  const known = ['BOOKMARK_INVALID_INPUT', 'BOOKMARK_DESTINATION_CHANGED', 'SPREADSHEET_NOT_CONFIGURED', 'SHEET_NOT_FOUND', 'INVALID_SHEET_HEADERS'];
  return { ok: false, error: known.includes(code) ? code : writing ? 'BOOKMARK_WRITE_FAILED' : 'BOOKMARK_READ_FAILED' };
}
