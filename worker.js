// worker.js
require('dotenv').config();
const db = require('./db');
const { sendEVMToken } = require('./utils/evmFaucet');
const { sendSolanaToken } = require('./utils/solanaFaucet');

// Intervalo de sondeo (cada 10 segundos)
const POLLING_INTERVAL_MS = 10000;

async function processClaim(claim) {
  let result;
  switch (claim.blockchain) {
    case 'ethereum':
    case 'base':
    case 'bnb':
      result = await sendEVMToken(claim);
      break;
    
    case 'solana':
      result = await sendSolanaToken(claim);
      break;

    case 'sui':
      console.log(`[WORKER] 'sui' aún no implementado. Marcando como fallido.`);
      result = { success: false, error: 'Sui faucet no implementado.' };
      break;
    
    default:
      console.log(`[WORKER] Blockchain desconocida: ${claim.blockchain}`);
      result = { success: false, error: 'Blockchain no soportada.' };
  }
  return result;
}

async function checkDatabaseForJobs() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. Buscar un trabajo 'pending' y bloquear la fila
    // FOR UPDATE SKIP LOCKED es clave: permite que múltiples workers
    // corran sin agarrar el mismo trabajo.
    const jobQuery = `
      SELECT c.*, u.wallet_address 
      FROM claims c
      JOIN users u ON c.user_id = u.id
      WHERE c.status = 'pending' 
      LIMIT 1 
      FOR UPDATE SKIP LOCKED;
    `;
    const { rows } = await client.query(jobQuery);

    if (rows.length === 0) {
      // No hay trabajo, terminar transacción
      await client.query('COMMIT');
      return;
    }

    const claim = rows[0];
    console.log(`[WORKER] Procesando claim ID: ${claim.id}`);

    // 2. Procesar el pago
    const result = await processClaim(claim);

    // 3. Actualizar la base de datos con el resultado
    if (result.success) {
      await client.query(
        'UPDATE claims SET status = $1, tx_hash = $2 WHERE id = $3',
        ['success', result.txHash, claim.id]
      );
    } else {
      await client.query(
        'UPDATE claims SET status = $1, error_message = $2 WHERE id = $3',
        ['failed', result.error.substring(0, 255), claim.id] // Limita el error
      );
    }

    // 4. Confirmar la transacción
    await client.query('COMMIT');
    console.log(`[WORKER] Claim ID: ${claim.id} finalizado.`);

  } catch (err) {
    console.error('[WORKER] Error en el bucle principal:', err.message);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

// Iniciar el bucle principal
console.log('--- Iniciando Faucet Worker ---');
setInterval(checkDatabaseForJobs, POLLING_INTERVAL_MS);