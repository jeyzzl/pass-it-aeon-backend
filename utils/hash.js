// utils/hash.js
const crypto = require('crypto');
const HASH_SALT = process.env.HASH_SALT;

if (!HASH_SALT) {
  throw new Error("HASH_SALT no está definida en .env");
}

/**
 * Crea un hash SHA-256 con "salt"
 * @param {string} data - El dato a hashear (ej. una IP o User Agent)
 * @returns {string} - El hash en formato hex
 */
function createHash(data) {
  return crypto.createHmac('sha256', HASH_SALT)
               .update(data)
               .digest('hex');
}

module.exports = { createHash };