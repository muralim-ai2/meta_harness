'use strict';
/** Read Copilot-owned chat logs and telemetry best-effort: their formats vary by model and change without notice, and Mission Control only
 * displays them, so a value of an unexpected shape is ignored instead of failing (decision D-068). Harness-owned files stay strictly validated. */

/** Return the object a JSON text encodes, or null when the text is not JSON or not an object.
 * @param {string} value
 * @returns {Record<string, unknown> | null}
 */
function jsonObject(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return object(parsed);
}

/** Return the JSON objects in newline-terminated lines and how many non-empty lines were not JSON objects; an unterminated last line waits.
 * @param {string} content
 * @returns {{rows: Record<string, unknown>[], skipped: number}}
 */
function looseLines(content) {
  const lines = content.split('\n');
  lines.pop();
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = jsonObject(line);
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, skipped };
}

/** Return a non-array object, or null.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** Return the objects in a value that should be a list of objects; anything else gives none.
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function objects(value) {
  return Array.isArray(value) ? value.map(object).filter(/** @returns {row is Record<string, unknown>} */ row => row !== null) : [];
}

/** Return a string, or empty text when the value is not one.
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** Return a non-negative integer, or 0 when the value is not one.
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Return a log event's type, time and data, or null when it has no type or no valid time; missing data reads as empty.
 * @param {Record<string, unknown>} row
 * @returns {{type: string, at: string, data: Record<string, unknown>} | null}
 */
function event(row) {
  const type = str(row.type), at = str(row.timestamp);
  return type && at && !Number.isNaN(Date.parse(at)) ? { type, at, data: object(row.data) || {} } : null;
}

/** Return a tool call's arguments: an object as is, JSON text decoded, and other text (such as an apply_patch patch) as the tool's input.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function toolArgs(value) {
  if (typeof value === 'string') return jsonObject(value) || { input: value };
  return object(value) || {};
}

module.exports = { jsonObject, looseLines, object, objects, str, count, event, toolArgs };
