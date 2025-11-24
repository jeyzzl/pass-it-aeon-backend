const { Pool } = require('pg');
require('dotenv').config();

// --- DIAGNÓSTICO DE CONEXIÓN ---
try {
  const dbUrl = new URL(process.env.DATABASE_URL);
  console.log("--------------------------------------------------");
  console.log("🕵️‍♂️ EL WORKER ESTÁ MIRANDO AQUÍ:");
  console.log("HOST:", dbUrl.hostname);  // Ej: roundhouse.proxy.rlwy.net
  console.log("DB NAME:", dbUrl.pathname); // Ej: /railway
  console.log("PORT:", dbUrl.port);
  console.log("--------------------------------------------------");
} catch (e) {
  console.log("❌ URL de base de datos inválida");
}
// ------------------------------

// 1. Diagnóstico: Imprimir si la variable existe (sin revelar la contraseña)
if (!process.env.DATABASE_URL) {
  console.error("❌ ERROR CRÍTICO: La variable DATABASE_URL no está definida.");
  console.error("   El sistema intentará conectarse a localhost y fallará.");
} else {
  console.log("✅ DATABASE_URL detectada. Conectando a la base de datos remota...");
}

// 2. Configuración del Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway requiere SSL para conexiones externas, pero a veces es permisivo internamente.
  // Esta configuración es la más compatible:
  ssl: {
    rejectUnauthorized: false 
  }
});

// 3. Manejo de errores del Pool (evita que el worker muera silenciosamente)
pool.on('error', (err, client) => {
  console.error('❌ Error inesperado en el cliente de base de datos:', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};