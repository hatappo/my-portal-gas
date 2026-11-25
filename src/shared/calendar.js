// Pure calendar calculations shared by GAS, the browser and offline fixtures.
globalThis.PortalCalendar = (() => {
  const defaults = () => ({ calendarIds: ['primary'], cacheSeconds: 300, alertMinutes: 0 });
  /** @param {unknown} value @returns {value is CalendarSettings} */
  function validSettings(value) {
    const v = /** @type {CalendarSettings} */ (value);
    return Boolean(v && typeof v === 'object' && Object.keys(v).every(key => ['alertMinutes', 'cacheSeconds', 'calendarIds', 'workStart', 'workEnd'].includes(key)) && validWorkHours(v) &&
      Array.isArray(v.calendarIds) && v.calendarIds.length >= 1 && v.calendarIds.length <= 5 && new Set(v.calendarIds).size === v.calendarIds.length &&
      v.calendarIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\s]/.test(id) && Array.from(id).every(char => char.charCodeAt(0) >= 32)) &&
      [0, 60, 300, 900, 1800, 3600, 21600].includes(v.cacheSeconds) && [0, 1, 2, 3, 5, 10, 15].includes(v.alertMinutes));
  }
  /** Both blank disables the window; overnight ranges are not supported.
   * @param {Partial<CalendarSettings>} value */
  function validWorkHours(value) {
    const start = value.workStart, end = value.workEnd;
    if ((start === undefined || start === '') && (end === undefined || end === '')) return true;
    return typeof start === 'string' && typeof end === 'string' &&
      /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(start) && /^(?:(?:[01]\d|2[0-3]):(?:00|30)|24:00)$/.test(end) && start < end;
  }
  /** Restore supported preferences without retaining removed settings. @param {unknown} value */
  function restoreSettings(value) {
    if (!value || typeof value !== 'object') return defaults();
    const stored = /** @type {Partial<CalendarSettings>} */ (value);
    const settings = { calendarIds: stored.calendarIds, cacheSeconds: stored.cacheSeconds, alertMinutes: stored.alertMinutes,
      ...(stored.workStart !== undefined ? { workStart: stored.workStart } : {}),
      ...(stored.workEnd !== undefined ? { workEnd: stored.workEnd } : {}),
    };
    return validSettings(settings) ? settings : defaults();
  }
  /** Display-only names for up to five selected calendars; never used to authorize or fetch events.
   * @param {unknown} value @param {string[]} ids @returns {Record<string, string>} */
  function names(value, ids) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
    return Object.fromEntries(ids.slice(0, 5).filter(id => Object.prototype.hasOwnProperty.call(source, id) && typeof source[id] === 'string' && source[id].trim())
      .map(id => [id, /** @type {string} */ (source[id]).trim().slice(0, 200)]));
  }
  /** @param {number} now @param {string} timeZone */
  function parts(now, timeZone) {
    return Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  }
  /** @param {number} now @param {string} timeZone */
  function dateKey(now, timeZone) { const p = parts(now, timeZone); return p.year + '-' + p.month + '-' + p.day; }
  /** Find the first instant of a civil day, including midnight timezone transitions.
   * @param {string} date @param {string} timeZone */
  function midnight(date, timeZone) {
    const anchor = Date.parse(date + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(anchor)) throw new Error('INVALID_INPUT');
    let lo = anchor - 48 * 3600000, hi = anchor + 48 * 3600000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2000) * 1000;
      if (dateKey(mid, timeZone) < date) lo = mid; else hi = mid;
    }
    return hi;
  }
  /** @param {number} now @param {string} timeZone */
  function day(now, timeZone) {
    const date = dateKey(now, timeZone);
    const next = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    return { date, start: midnight(date, timeZone), end: midnight(next, timeZone) };
  }
  /** Resolve a civil time, rather than adding elapsed hours to midnight across DST.
   * Repeated times use the earlier start/later end; skipped times advance to the next valid minute.
   * @param {string} time @param {number} start @param {number} end @param {string} zone @param {boolean} latest */
  function workInstant(time, start, end, zone, latest) {
    if (time === '24:00') return end;
    const date = dateKey(start, zone), target = Date.parse(date + 'T' + time + ':00Z');
    const candidates = [...new Set([start, end - 1000].map(instant => {
      const p = parts(instant, zone);
      const wall = Date.parse(p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + 'Z');
      return target - (wall - instant);
    }))].filter(instant => {
      const p = parts(instant, zone);
      return instant >= start && instant < end && p.year + '-' + p.month + '-' + p.day === date && p.hour + ':' + p.minute === time;
    }).sort((a, b) => a - b);
    if (candidates.length) return latest ? candidates[candidates.length - 1] : candidates[0];
    for (let instant = start; instant < end; instant += 60000) {
      const p = parts(instant, zone);
      if (p.hour + ':' + p.minute >= time) return instant;
    }
    return end;
  }
  /** @param {CalendarSettings} settings @param {number} start @param {number} end @param {string} zone */
  function workBounds(settings, start, end, zone) {
    if (!settings.workStart || !settings.workEnd || !validWorkHours(settings)) return undefined;
    return { start: workInstant(settings.workStart, start, end, zone, false), end: workInstant(settings.workEnd, start, end, zone, true) };
  }
  /** Incomplete results never imply free time. Work hours extend, never clip, the actual schedule.
   * @param {CalendarEvent[]} events @param {number} start @param {number} end @param {boolean} complete
   * @param {{start: number, end: number}} [work] @returns {CalendarSlot[]} */
  function slots(events, start, end, complete, work) {
    const timed = events.filter(e => !e.allDay && e.end > start && e.start < end);
    /** @type {CalendarSlot[]} */ const result = timed.map(event => ({ id: event.id, start: Math.max(start, event.start), end: Math.min(end, event.end), event, gap: false }));
    if (complete) {
      const busy = events.filter(e => e.busy && e.end > start && e.start < end).map(e => ({ start: Math.max(start, e.start), end: Math.min(end, e.end) })).sort((a, b) => a.start - b.start);
      const floor = work ? Math.max(start, Math.min(work.start, ...result.map(s => s.start))) : busy[0]?.start;
      const ceiling = work ? Math.min(end, Math.max(work.end, ...result.map(s => s.end))) : Math.max(...busy.map(b => b.end));
      if (Number.isFinite(floor) && ceiling > floor) {
        let until = floor;
        for (const block of busy) {
          if (block.end <= until || block.start >= ceiling) continue;
          if (block.start > until) result.push({ id: 'gap:' + until, start: until, end: Math.min(block.start, ceiling), gap: true, event: undefined });
          until = Math.max(until, block.end);
        }
        if (until < ceiling) result.push({ id: 'gap:' + until, start: until, end: ceiling, gap: true, event: undefined });
      }
    }
    return result.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  }
  /** @param {CalendarSlot} slot @param {CalendarSlot[]} all @param {number} now */
  function state(slot, all, now) {
    if (slot.end <= now) return 'past';
    if (slot.start <= now) return 'current';
    const next = all.find(s => !s.gap && s.start > now)?.start;
    return !slot.gap && slot.start === next ? 'next' : 'future';
  }
  return { validWorkHours, workBounds, names, defaults, validSettings, restoreSettings, dateKey, midnight, day, slots, state };
})();
