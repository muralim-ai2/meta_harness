'use strict';
/** Brand settings from the packaged runtime's brand.json: product name, agent prefix and workspace state folder. */

const fs = require('fs');
const path = require('path');

/** @type {{product: string, prefix: string, state_dir: string}} */
const BRAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime', 'brand.json'), 'utf8'));

module.exports = { BRAND };
