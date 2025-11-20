// 1. Configurar dotenv para que encuentre el archivo .env en la raíz
require('dotenv').config({ path: '.env' });

// 2. Importar nuestros módulos
const db = require('../db');
const { generateToken } = require('../utils/tokenService');

async function createAndStoreToken(userId = null) {
  console.log('Generando nuevo token...');
  
  // 1. Generar el token completo (ej: "payload.v1.signature")
  const fullToken = generateToken();
  
  // 2. Separar las partes para la base de datos
  const [payload, versionStr, signature] = fullToken.split('.');
  
  // Convertir 'v1' a un número 1
  const version = parseInt(versionStr.replace('v', ''), 10);

  // Definir expiración (24 horas desde ahora)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  if (!payload || !signature || isNaN(version)) {
    throw new Error('Error al parsear el token generado.');
  }

  try {
    // 3. Insertar las partes en la base de datos
    const query = `
      INSERT INTO qr_codes (token, hmac_signature, version, expires_at, generated_by) 
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, token, is_active, expires_at;
    `;
    
    const { rows } = await db.query(query, [payload, signature, version, expiresAt, userId]);
    
    console.log('¡Éxito! Token guardado en la base de datos:');
    console.log(rows[0]);
    console.log('\n--- TOKEN COMPLETO (para tu QR) ---');
    console.log(fullToken);
    console.log('-----------------------------------');

  } catch (err) {
    console.error('Error al guardar el token en la BD:', err.message);
  } finally {
    // Cierra el pool de la base de datos para que el script termine
    db.query('SELECT 1', [], () => db.getClient(true));
    
    process.exit(0);
  }
}

// Ejecutar la función
if (require.main === module) {
    createAndStoreToken();
}

module.exports = { createAndStoreToken };