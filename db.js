// db.js
const { Pool } = require('pg');

// PGHOST, PGUSER, PGDATABASE, PGPASSWORD, PGPORT
const pool = new Pool();

module.exports = {
  query: (text, params) => pool.query(text, params),
  // Usado para transacciones
  getClient: () => pool.connect(), 
};