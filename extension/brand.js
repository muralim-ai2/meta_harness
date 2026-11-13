'use strict';
/** Brand settings and derived extension identifiers from runtime/brand.json, preserving default ARIA IDs for in-place upgrades. */

const fs = require('fs');
const path = require('path');

/** @typedef {{product: string, prefix: string, state_dir: string, logo?: string, activity_icon?: string, publisher?: string, extension_name?: string, command_prefix?: string}} BrandConfig */

/** @type {BrandConfig} */
const BRAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime', 'brand.json'), 'utf8'));
const DEFAULT_ARIA = BRAND.prefix === 'aria' && !BRAND.command_prefix && !BRAND.extension_name;
const CMD_PREFIX = BRAND.command_prefix || (DEFAULT_ARIA ? 'frontierHve' : BRAND.prefix);
const EXT_NAME = BRAND.extension_name || (DEFAULT_ARIA ? 'frontier-hve' : BRAND.prefix);
const PUBLISHER = BRAND.publisher || 'pwc';
const LOGO_FILE = BRAND.logo ? path.basename(BRAND.logo) : 'aria.png';
const ICON_FILE = BRAND.activity_icon ? path.basename(BRAND.activity_icon) : 'aria.svg';

/** Return a command or view identifier under this build's prefix.
 * @param {string} suffix
 * @returns {string}
 */
function cmd(suffix) {
  return `${CMD_PREFIX}.${suffix}`;
}

module.exports = { BRAND, DEFAULT_ARIA, CMD_PREFIX, EXT_NAME, PUBLISHER, LOGO_FILE, ICON_FILE, cmd };
