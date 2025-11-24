// require('dotenv').config(); 

const crypto = require('crypto');

// Carga la clave secreta desde las variables de entorno
const TOKEN_SECRET_V1 = process.env.TOKEN_SECRET_V1;

if (!TOKEN_SECRET_V1) {
  throw new Error("TOKEN_SECRET_V1 no está definida en .env");
}

/**
 * Genera un nuevo token firmado con HMAC y versión.
 * @returns {string} El token final (ej: "payload.v1.signature")
 */
function generateToken() {
  const payload = crypto.randomBytes(16).toString('hex'); // Datos únicos
  const version = 'v1';
  
  // Crea la firma HMAC
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET_V1);
  hmac.update(`${payload}.${version}`);
  const signature = hmac.digest('hex');
  
  // El token final une las tres partes
  const finalToken = `${payload}.${version}.${signature}`;
  
  return finalToken;
}

/**
 * Valida un token.
 * @param {string} token El token recibido (ej: "payload.v1.signature")
 * @returns {{isValid: boolean, payload: string|null}}
 */
function validateToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { isValid: false, payload: null }; // Formato inválido
    }
    
    const [payload, version, signature] = parts;

    let secret;
    if (version === 'v1') {
      secret = TOKEN_SECRET_V1;
    } else {
      // Aquí podrías manejar v2, v3, etc.
      return { isValid: false, payload: null }; // Versión desconocida
    }

    // Re-calculamos la firma que *debería* tener
    const expectedHmac = crypto.createHmac('sha256', secret);
    expectedHmac.update(`${payload}.${version}`);
    const expectedSignature = expectedHmac.digest('hex');

    // Comparamos las firmas de forma segura (previene ataques de tiempo)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );

    return { isValid, payload: isValid ? payload : null };

  } catch (error) {
    return { isValid: false, payload: null }; // Error en la validación
  }
}

// --- Exportamos las funciones ---
module.exports = { generateToken, validateToken };