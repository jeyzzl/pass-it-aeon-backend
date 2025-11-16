// 1. Cargar variables de entorno
require('dotenv').config();

// 2. Importar dependencias
const express = require('express');
const db = require('./db'); // Nuestro pool de base de datos
const { validateToken } = require('./utils/tokenService'); // Nuestro validador
const { createHash } = require('./utils/hash');

// 3. Inicializar la app
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// 4. Middlewares
app.use(express.json()); // <-- ¡MUY IMPORTANTE! Para leer JSON del body

// =======================================================
// TAREA 3: Endpoint 1 - /c/:token (Preflight)
// =======================================================
app.get('/c/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Paso 1: Validar el HMAC del token (Tarea 2)
    const { isValid, payload } = validateToken(token);
    if (!isValid) {
      return res.status(400).json({ valid: false, error: 'Token inválido o malformado.' });
    }

    // Paso 2: El token es legítimo, ¿pero sigue activo en nuestra BD?
    const { rows } = await db.query(
      'SELECT is_active FROM qr_codes WHERE token = $1',
      [payload]
    );

    if (rows.length === 0) {
      // Nota: ¡Esto significa que generaste un token pero NUNCA lo guardaste en la BD!
      return res.status(404).json({ valid: false, error: 'Token no encontrado.' });
    }

    if (!rows[0].is_active) {
      return res.status(410).json({ valid: false, error: 'Este token ya fue reclamado.' });
    }

    // ¡Éxito! El token es válido y está activo.
    res.json({ valid: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: 'Error interno del servidor' });
  }
});

// =======================================================
// TAREA 3: Endpoint 2 - /api/claim 
// =======================================================
app.post('/api/claim', async (req, res) => {
  // TODO: Implementar CAPTCHA y Rate Limits aquí

  const { token, walletAddress, blockchain } = req.body;

  // --- TAREA 5: Obtener y hashear IP/Device ---
  const ip = req.ip; // Gracias a 'trust proxy'
  const userAgent = req.headers['user-agent'] || 'unknown';
  const ipHash = createHash(ip);
  const deviceHash = createHash(userAgent);
  // ------------------------------------------

  // Validación básica de entrada
  if (!token || !walletAddress || !blockchain) {
    return res.status(400).json({ success: false, error: 'Faltan token, walletAddress o blockchain.' });
  }

  const client = await db.getClient();

  try {
    // Paso 1: Validar el HMAC del token
    const { isValid, payload } = validateToken(token);
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Token inválido.' });
    }
    
    await client.query('BEGIN');

    // Paso 2: Obtener el qr_code y bloquearlo
    const qrResult = await client.query(
      'SELECT id, is_active FROM qr_codes WHERE token = $1 FOR UPDATE',
      [payload]
    );

    if (qrResult.rows.length === 0) {
      throw new Error('Token no encontrado.');
    }

    const qrCode = qrResult.rows[0];
    if (!qrCode.is_active) {
      throw new Error('Este token ya fue reclamado.');
    }

    // --- TAREA 5: Lógica de Límite (Revisión de Usuario) ---
    let userId;

    // 1. Buscar si esta billetera, IP, o dispositivo ya existe
    const userCheck = await client.query(
      `SELECT id FROM users 
       WHERE wallet_address = $1 OR ip_hash = $2 OR device_hash = $3`,
      [walletAddress, ipHash, deviceHash]
    );

    if (userCheck.rows.length > 0) {
      // 2. Si existe, verificar si ya tiene un reclamo exitoso
      userId = userCheck.rows[0].id;
      const existingClaim = await client.query(
        `SELECT id FROM claims WHERE user_id = $1 AND status = 'success'`,
        [userId]
      );
      
      if (existingClaim.rows.length > 0) {
        // ¡Este usuario (billetera/ip/dispositivo) ya reclamó con éxito!
        throw new Error('Límite de reclamación alcanzado para esta billetera, IP o dispositivo.');
      }
      
      // Si el usuario existe pero sus reclamos anteriores fallaron,
      // se le permite volver a intentarlo (con este nuevo token).

    } else {
      // 3. Si no existe, es un usuario nuevo. Lo creamos.
      const newUser = await client.query(
        'INSERT INTO users (wallet_address, ip_hash, device_hash) VALUES ($1, $2, $3) RETURNING id',
        [walletAddress, ipHash, deviceHash]
      );
      userId = newUser.rows[0].id;
    }
    // --- FIN LÓGICA TAREA 5 ---


    // Paso 4: Crear el registro de la reclamación
    await client.query(
      'INSERT INTO claims (user_id, qr_code_id, blockchain) VALUES ($1, $2, $3)',
      [userId, qrCode.id, blockchain]
    );

    // Paso 5: Desactivar el token QR
    await client.query(
      'UPDATE qr_codes SET is_active = false WHERE id = $1',
      [qrCode.id]
    );

    // Paso 6: Confirmar la transacción
    await client.query('COMMIT');
    
    res.status(201).json({ success: true, message: '¡Reclamación encolada! El Faucet la procesará pronto.' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /api/claim:', err.message);
    res.status(400).json({ success: false, error: err.message || 'Error al procesar la reclamación.' });
  
  } finally {
    client.release();
  }
});

// 5. Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor de pass-it-aeon corriendo en http://localhost:${PORT}`);
});