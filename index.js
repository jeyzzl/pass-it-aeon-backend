// Cargar variables de entorno
require('dotenv').config();

// Importar dependencias
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { validateToken } = require('./utils/tokenService');
const { createHash } = require('./utils/hash');
const { verifyCaptcha } = require('./utils/captchaService');
const { claimLimiter, generalLimiter } = require('./middleware/rateLimit');
const { getSetting } = require('./utils/settingsService');
const { generateToken } = require('./utils/tokenService');

// Inicializar la app
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// =======================================================
// CONFIGURACIÓN DE CORS (CRÍTICO PARA PRODUCCIÓN)
// =======================================================
const allowedOrigins = [
  'http://localhost:3000',                    // Para pruebas locales
  'https://pass-it-aeon-frontend.vercel.app', // Tu dominio de Vercel por defecto
  'https://passitaeon.com',                   // Tu dominio final (cuando lo compres)
  'https://www.passitaeon.com'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origen (como Postman o scripts de servidor)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'La política CORS de este sitio no permite acceso desde el origen especificado.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true // Permitir cookies/headers autorizados si fuera necesario
}));

// Middlewares
app.use(express.json());

// =======================================================
// Endpoint 1 - /c/:token (Preflight)
// =======================================================
app.get('/c/:token', generalLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    // --- LOGS DE DIAGNÓSTICO (BORRAR LUEGO) ---
    console.log("🔍 DIAGNÓSTICO DE TOKEN:");
    console.log("1. Token Recibido:", token);

    const secret = process.env.TOKEN_SECRET_V1;
    // Imprimimos solo los primeros y últimos caracteres para ver si hay espacios sin revelar la clave
    if (secret) {
      console.log(`2. Secreto en Railway: '${secret.substring(0,3)}...${secret.substring(secret.length-3)}' (Longitud: ${secret.length})`);
    } else {
      console.error("❌ ERROR: TOKEN_SECRET_V1 no está definido en Railway");
    }
    // Paso 1: Validar el HMAC del token
    const { isValid, payload } = validateToken(token);

    if (!isValid) {
      return res.status(400).json({ valid: false, error: 'Token inválido o malformado.' });
    }

    // Paso 2: El token es legítimo, ¿pero sigue activo en nuestra BD?
    const { rows } = await db.query(
      'SELECT is_active, expires_at FROM qr_codes WHERE token = $1',
      [payload]
    );

    if (rows.length === 0) {
      return res.status(404).json({ valid: false, error: 'Token no encontrado.' });
    }

    const qrCode = rows[0];

    // 1. Chequeo de estado
    if (!qrCode.is_active) {
      return res.status(410).json({ valid: false, error: 'Este token ya fue reclamado.' });
    }

    // 2. Chequeo de expiración
    const now = new Date();
    const expiresAt = new Date(qrCode.expires_at);
    if (now > expiresAt) {
        return res.status(410).json({ valid: false, error: 'Este código ha expirado.' });
    }

    // El token es válido y está activo.
    res.json({ valid: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: 'Error interno del servidor' });
  }
});

// =======================================================
// Endpoint 2 - /api/claim 
// =======================================================
app.post('/api/claim', claimLimiter, async (req, res) => {
  const { token, walletAddress, blockchain, captchaToken } = req.body;

  // Obtener y hashear IP/Device
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Verificar Captcha
  const isHuman = await verifyCaptcha(captchaToken, ip);
  if (!isHuman) {
    // Si falla el captcha, rechazamos antes de tocar la base de datos
    return res.status(400).json({ success: false, error: 'Falló la verificación de CAPTCHA (o eres un robot).' });
  }

  const userAgent = req.headers['user-agent'] || 'unknown';
  const ipHash = createHash(ip);
  const deviceHash = createHash(userAgent);

  // Validación básica de entrada
  if (!token || !walletAddress || !blockchain) {
    return res.status(400).json({ success: false, error: 'Faltan token, walletAddress o blockchain.' });
  }

  // Validar que el formato de wallet corresponde al blockchain
  const validateAddressFormat = (address, blockchain) => {
    if (blockchain === 'solana') {
      // Solana addresses are base58 encoded, length 32-44 chars
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    } 
    else if (['ethereum', 'base', 'bnb'].includes(blockchain)) {
      // EVM addresses: 0x followed by 40 hex chars
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }
    return true;
  };

  if (!validateAddressFormat(walletAddress, blockchain)) {
    return res.status(400).json({ success: false, error: `Invalid ${blockchain} address format.` });
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
      'SELECT id, is_active, generated_by FROM qr_codes WHERE token = $1 FOR UPDATE',
      [payload]
    );

    if (qrResult.rows.length === 0) {
      throw new Error('Token no encontrado.');
    }

    const qrCode = qrResult.rows[0];
    if (!qrCode.is_active) {
      throw new Error('Este token ya fue reclamado.');
    }

    // Lógica de Límite (Revisión de Usuario)
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
        throw new Error('Límite de reclamación alcanzado para esta billetera, IP o dispositivo.');
      }

    } else {
      // 3. Si no existe, es un usuario nuevo. Lo creamos.
      const newUser = await client.query(
        'INSERT INTO users (wallet_address, ip_hash, device_hash) VALUES ($1, $2, $3) RETURNING id',
        [walletAddress, ipHash, deviceHash]
      );
      userId = newUser.rows[0].id;
    }


    // Paso 4: Crear el registro de la reclamación
    // --- PREVIOUS
    // await client.query(
    //   'INSERT INTO claims (user_id, qr_code_id, blockchain) VALUES ($1, $2, $3)',
    //   [userId, qrCode.id, blockchain]
    // );
    // --- NEW: STATUS POLLING
    const claimResult = await client.query(
      'INSERT INTO claims (user_id, qr_code_id, blockchain) VALUES ($1, $2, $3) RETURNING id',
      [userId, qrCode.id, blockchain]
    );
    const claimId = claimResult.rows[0].id;

    // 1. Leer configuración
    const codesToGenerateStr = await getSetting('child_codes_per_claim', '3');
    const codesToGenerate = parseInt(codesToGenerateStr, 10);
    
    const expirationHoursStr = await getSetting('code_expiration_hours', '24');
    const expirationHours = parseInt(expirationHoursStr, 10);

    // 2. Calcular fecha de expiración para los nuevos códigos
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expirationHours);

    // 3. Generar los códigos hijos
    const newCodes = [];
    
    for (let i = 0; i < codesToGenerate; i++) {
        // Generamos el string criptográfico
        const fullToken = generateToken(); // Asegúrate que tu generateToken() exportado devuelva el string
        const [payload, versionStr, signature] = fullToken.split('.');
        const version = parseInt(versionStr.replace('v', ''), 10);

        // Insertamos en la DB vinculando al 'userId' actual (el Padre)
        await client.query(
            `INSERT INTO qr_codes (token, hmac_signature, version, expires_at, generated_by) 
             VALUES ($1, $2, $3, $4, $5)`,
            [payload, signature, version, expiresAt, userId]
        );
        
        newCodes.push(fullToken);
    }

    // --- LOGICA DE PUNTOS MULTINIVEL & REFILL (PADRE + ABUELO) ---
    if (qrCode.generated_by && qrCode.generated_by !== userId) {
        
        const fatherId = qrCode.generated_by;

        // 1. Configuración de Puntos Base
        const pointsPerRefStr = await getSetting('points_per_referral', '100');
        const pointsBase = parseInt(pointsPerRefStr, 10);

        // --- A) PAGO DE PUNTOS (NIVEL 1) ---
        await client.query(
            'UPDATE users SET points = points + $1 WHERE id = $2',
            [pointsBase, fatherId]
        );
        console.log(`[PUNTOS L1] Usuario ${fatherId} ganó ${pointsBase} pts.`);

        // --- B) LOGICA DE REFILL (MUNICIÓN INFINITA) ---
        // Leemos cuántos códigos regalar al padre por este éxito
        const refillAmountStr = await getSetting('refill_codes_per_success', '1');
        const refillAmount = parseInt(refillAmountStr, 10);

        if (refillAmount > 0) {
            // Calculamos expiración (usamos la misma config global o 24h por defecto)
            const expirationHoursStr = await getSetting('code_expiration_hours', '24');
            const expirationHours = parseInt(expirationHoursStr, 10);
            const refillExpiresAt = new Date();
            refillExpiresAt.setHours(refillExpiresAt.getHours() + expirationHours);

            for (let k = 0; k < refillAmount; k++) {
                // Generamos token usando la misma función que usaste arriba
                const fullTokenRefill = generateToken(); 
                const [payloadR, versionStrR, signatureR] = fullTokenRefill.split('.');
                const versionR = parseInt(versionStrR.replace('v', ''), 10);

                // Insertamos vinculado al PADRE (fatherId)
                await client.query(
                    `INSERT INTO qr_codes (token, hmac_signature, version, expires_at, generated_by) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [payloadR, signatureR, versionR, refillExpiresAt, fatherId]
                );
            }
            console.log(`[REFILL] Se generaron ${refillAmount} nuevos códigos para el usuario ${fatherId}`);
        }
        // --- FIN REFILL ---

        // --- C) PAGO DE PUNTOS (NIVEL 2 - ABUELO) ---
        const grandfatherCheck = await client.query(`
            SELECT q.generated_by as grandfather_id
            FROM claims c
            JOIN qr_codes q ON c.qr_code_id = q.id
            WHERE c.user_id = $1 AND c.status = 'success'
            LIMIT 1
        `, [fatherId]);

        if (grandfatherCheck.rows.length > 0) {
            const grandfatherId = grandfatherCheck.rows[0].grandfather_id;

            if (grandfatherId && grandfatherId !== fatherId) {
                const level2PctStr = await getSetting('points_level_2_percentage', '20');
                const level2Pct = parseInt(level2PctStr, 10);
                const pointsLevel2 = Math.floor((pointsBase * level2Pct) / 100);

                if (pointsLevel2 > 0) {
                    await client.query(
                        'UPDATE users SET points = points + $1 WHERE id = $2',
                        [pointsLevel2, grandfatherId]
                    );
                    console.log(`[PUNTOS L2] Abuelo ${grandfatherId} ganó ${pointsLevel2} pts.`);
                }
            }
        }
    }
    // --- FIN LOGICA PUNTOS --- 

    // Paso 5: Desactivar el token QR
    await client.query(
      'UPDATE qr_codes SET is_active = false WHERE id = $1',
      [qrCode.id]
    );

    // Paso 6: Confirmar la transacción
    await client.query('COMMIT');
    
    res.status(201).json({ 
      success: true, 
      message: '¡Reclamación encolada! El Faucet la procesará pronto.',
      newCodes: newCodes,
      claimId: claimId
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /api/claim:', err.message);
    res.status(400).json({ success: false, error: err.message || 'Error al procesar la reclamación.' });
  
  } finally {
    client.release();
  }
});

// =======================================================
// Endpoint 3 - /api/regenerate
// =======================================================
app.post('/api/regenerate', generalLimiter, async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet required' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Obtener ID del usuario
    const userRes = await client.query('SELECT id FROM users WHERE wallet_address = $1', [walletAddress]);
    if (userRes.rows.length === 0) throw new Error('Usuario no encontrado');
    const userId = userRes.rows[0].id;

    // 2. Contar códigos VÁLIDOS (Activos y NO expirados)
    const activeQuery = `
      SELECT count(*) FROM qr_codes 
      WHERE generated_by = $1 
      AND is_active = true 
      AND expires_at > NOW()
    `;
    const { rows } = await client.query(activeQuery, [userId]);
    const activeCount = parseInt(rows[0].count);

    // 3. Obtener límite dinámico desde DB
    const limitStr = await getSetting('child_codes_per_claim', '3');
    const limit = parseInt(limitStr, 10);
    
    if (activeCount >= limit) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Ya tienes el máximo de ${limit} códigos activos.` });
    }

    // 4. Calcular cuántos faltan y generarlos
    const needed = limit - activeCount;
    const expirationHoursStr = await getSetting('code_expiration_hours', '24');
    const expirationHours = parseInt(expirationHoursStr, 10);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expirationHours);

    const newCodes = [];

    for (let i = 0; i < needed; i++) {
        const fullToken = generateToken(); 
        const [payload, versionStr, signature] = fullToken.split('.');
        const version = parseInt(versionStr.replace('v', ''), 10);

        await client.query(
            `INSERT INTO qr_codes (token, hmac_signature, version, expires_at, generated_by) 
             VALUES ($1, $2, $3, $4, $5)`,
            [payload, signature, version, expiresAt, userId]
        );
        newCodes.push(fullToken);
    }

    await client.query('COMMIT');
    res.json({ success: true, newCodes });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error regenerando:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =======================================================
// Endpoint 4 - /api/admin/genesis
// =======================================================
app.post('/api/admin/genesis', async (req, res) => {
  const { secret, count, days } = req.body;

  if (secret !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  try {
    const loopCount = count || 1;
    const validDays = days || 14; // 14 días default
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + validDays);

    const generatedCodes = [];

    for (let i = 0; i < loopCount; i++) {
      const fullToken = generateToken();
      const [payload, versionStr, signature] = fullToken.split('.');
      const version = parseInt(versionStr.replace('v', ''), 10);

      // Insertamos con generated_by = NULL (o un ID de admin si tienes uno en users)
      // Al ser NULL, no dará puntos a nadie (o podrías asignarlo a tu wallet)
      await db.query(
        `INSERT INTO qr_codes (token, hmac_signature, version, expires_at, generated_by, is_active) 
         VALUES ($1, $2, $3, $4, NULL, true)`,
        [payload, signature, version, expiresAt]
      );

      generatedCodes.push(fullToken);
    }

    res.json({ success: true, codes: generatedCodes });

  } catch (error) {
    console.error('Error admin genesis:', error);
    res.status(500).json({ error: 'Error generando genesis' });
  }
});

// =======================================================
// Endpoint 5 - /api/profile/:walletAddress 
// =======================================================
app.get('/api/profile/:walletAddress', async (req, res) => {
  const { walletAddress } = req.params;

  try {
    const limitStr = await getSetting('child_codes_per_claim', '3');
    const maxCodes = parseInt(limitStr, 10);

    // 1. Obtener datos del usuario (Puntos y Ranking)
    const userQuery = await db.query(`
      SELECT 
        id, 
        points, 
        wallet_address,
        (SELECT COUNT(*) + 1 FROM users u2 WHERE u2.points > u1.points) as rank
      FROM users u1 
      WHERE wallet_address = $1
    `, [walletAddress]);

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userQuery.rows[0];

    // 2. Obtener sus códigos activos para compartir
    const codesQuery = await db.query(`
      SELECT token, version, hmac_signature
      FROM qr_codes 
      WHERE generated_by = $1
      AND is_active = true
      AND expires_at > NOW()
      ORDER BY created_at DESC
    `, [user.id]);

    // 3. Obtener el Top 5 para el Leaderboard global
    const leaderboardQuery = await db.query(`
      SELECT wallet_address, points 
      FROM users 
      ORDER BY points DESC 
      LIMIT 5
    `);

    res.json({
      points: user.points,
      rank: user.rank,
      myCodes: codesQuery.rows.map(r => `${r.token}.v${r.version}.${r.hmac_signature}`),
      globalLeaderboard: leaderboardQuery.rows,
      maxCodes: maxCodes
    });

  } catch (error) {
    console.error('Error en profile:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// =======================================================
// Endpoint 6 - /api/leaderboard (Público)
// =======================================================
app.get('/api/leaderboard', generalLimiter, async (req, res) => {
  try {
    // Obtenemos el Top 50 ordenado por puntos
    const query = `
      SELECT wallet_address, points 
      FROM users 
      WHERE points > 0
      ORDER BY points DESC 
      LIMIT 50
    `;
    const { rows } = await db.query(query);

    // Opcional: Enmascarar las wallets para privacidad (ej: 0x123...456)
    const sanitizedRows = rows.map(row => ({
      ...row,
      wallet_address: `${row.wallet_address.substring(0, 6)}...${row.wallet_address.substring(row.wallet_address.length - 4)}`
    }));

    res.json({ leaderboard: sanitizedRows });
  } catch (error) {
    console.error('Error leaderboard:', error);
    res.status(500).json({ error: 'Error al obtener ranking' });
  }
});

// =======================================================
// Endpoint 7 - /api/claim/:claimId/status
// =======================================================
app.get('/api/claim/:claimId/status', generalLimiter, async (req, res) => {
  const { claimId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT c.*, u.wallet_address, qr.token as qr_token
       FROM claims c
       JOIN users u ON c.user_id = u.id
       JOIN qr_codes qr ON c.qr_code_id = qr.id
       WHERE c.id = $1`,
      [claimId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    const claim = rows[0];
    
    // Generate explorer links based on blockchain
    let explorerLink = null;
    if (claim.tx_hash) {
      switch (claim.blockchain) {
        case 'solana':
          explorerLink = `https://solscan.io/tx/${claim.tx_hash}`;
          break;
        case 'ethereum':
          explorerLink = `https://etherscan.io/tx/${claim.tx_hash}`;
          break;
        case 'base':
          explorerLink = `https://basescan.org/tx/${claim.tx_hash}`;
          break;
        default:
          explorerLink = null;
      }
    }

    res.json({
      claimId: claim.id,
      status: claim.status,
      txHash: claim.tx_hash,
      explorerLink,
      blockchain: claim.blockchain,
      walletAddress: claim.wallet_address,
      error: claim.error_log,
      createdAt: claim.claimed_at,
      updatedAt: claim.updated_at
    });

  } catch (error) {
    console.error('Error fetching claim status:', error);
    res.status(500).json({ error: 'Error fetching claim status' });
  }
});

// 5. Iniciar el servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT} (Escuchando en 0.0.0.0)`);
});