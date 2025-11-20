const axios = require('axios');

// Clave secreta de tu sitio en Cloudflare (ponla en tu .env)
// Para pruebas locales, Cloudflare tiene claves dummy:
// Secret: 1x0000000000000000000000000000000AA
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

async function verifyCaptcha(token, ip) {
  if (!token) return false;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const result = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      formData
    );

    // result.data.success es true si la verificación pasó
    return result.data.success;
  } catch (err) {
    console.error('Error verificando Turnstile:', err.message);
    // En caso de error de conexión con Cloudflare, decidimos si bloquear o permitir.
    // Por seguridad, mejor bloquear (return false).
    return false;
  }
}

module.exports = { verifyCaptcha };