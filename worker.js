require('dotenv').config();
const db = require('./db'); 
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58'); 
const { ethers } = require('ethers');
const { monitorBalances } = require('./utils/balanceMonitor');

const EVM_NETWORKS = {
  'ethereum': {
    rpc: process.env.ETH_RPC_URL,
    contract: process.env.SPX_ERC20_ADDRESS_ETH, // Contrato en Sepolia
    name: 'Ethereum'
  },
  'base': {
    rpc: process.env.BASE_RPC_URL,
    contract: process.env.SPX_ERC20_ADDRESS_BASE, // Contrato en Base
    name: 'Base'
  }
};

// --- CONFIGURACION ETHEREUM ---
const FAUCET_PRIVATE_KEY_EVM = process.env.FAUCET_PRIVATE_KEY_EVM;

// --- CONFIGURACIÓN SOLANA ---
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const TOKEN_MINT_ADDRESS = new PublicKey(process.env.SPX_TOKEN_MINT);
const SPX_DECIMALS = 8; 
const SOL_FOR_GAS = 0.002 * 1000000000; 

// --- DECODIFICACIÓN LLAVE ---
let faucetKeypair;
try {
  const rawKey = process.env.FAUCET_PRIVATE_KEY_SOLANA;
  if (rawKey.trim().startsWith('[')) {
    faucetKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(rawKey)));
  } else {
    faucetKeypair = Keypair.fromSecretKey(bs58.decode(rawKey));
  }
} catch (e) {
  console.error("❌ Error fatal: Formato de llave privada inválido en .env");
  process.exit(1);
}

const POLLING_INTERVAL_MS = 5000;

// --- LEER CONFIG ---
async function getSetting(client, key, defaultValue) {
  const res = await client.query('SELECT value FROM game_settings WHERE key = $1', [key]);
  if (res.rows.length > 0) {
    let val = res.rows[0].value;
    if (typeof val === 'string') val = val.replace(/"/g, ''); 
    return val;
  }
  return defaultValue;
}

// --- CONFIGURACION DE RETRY ---
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30000, 60000, 120000]; // 30s, 1min, 2min in milliseconds

// --- CONFIGURACION DE WORKER HEALTH ---
const BALANCE_CHECK_INTERVAL = 30 * 60 * 1000;
let lastBalanceCheck = 0;

// ============================================================
// LÓGICA WORKER HEALTH
// ============================================================
async function updateWorkerHealth(status = 'healthy', errorMessage = null) {
  const client = await db.getClient();
  try {
    await client.query(
      `INSERT INTO worker_health (worker_type, last_heartbeat, status, error_message)
       VALUES ('faucet_worker', NOW(), $1, $2)
       ON CONFLICT (worker_type) DO UPDATE SET
       last_heartbeat = NOW(),
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message`,
      [status, errorMessage]
    );
  } catch (error) {
    console.error('[HEALTH MONITOR] Error updating health:', error.message);
  } finally {
    client.release();
  }
}

async function workerLoop() {
  try {
    await checkDatabaseForJobs();
    await updateWorkerHealth('healthy');
    
    // Check balances every 30 minutes
    const now = Date.now();
    if (now - lastBalanceCheck > BALANCE_CHECK_INTERVAL) {
      lastBalanceCheck = now;
      await monitorBalances();
    }
    
  } catch (error) {
    console.error('[WORKER LOOP ERROR]', error.message);
    await updateWorkerHealth('error', error.message);
  }
}


// ============================================================
// LÓGICA EVM
// ============================================================
async function processEvmClaim(client, claim) {
  // 1. Identificar la configuración de red
  const networkConfig = EVM_NETWORKS[claim.blockchain];
  
  if (!networkConfig || !networkConfig.rpc) {
    return { success: false, error: `Red EVM no configurada: ${claim.blockchain}` };
  }
  
  if (!networkConfig.contract) {
    return { success: false, error: `Contrato SPX no configurado para ${claim.blockchain}` };
  }
    
  if (!FAUCET_PRIVATE_KEY_EVM) return { success: false, error: "Falta EVM Private Key." };

  try {
    // Conexión dinámica a la red específica
    const provider = new ethers.JsonRpcProvider(networkConfig.rpc);
    const wallet = new ethers.Wallet(FAUCET_PRIVATE_KEY_EVM, provider);
    
    const amountStr = await getSetting(client, 'faucet_amount_spx', '1');
    console.log(`[${networkConfig.name.toUpperCase()}] Enviando ${amountStr} SPX a ${claim.wallet_address}...`);

    // Contrato (ABI Mínimo)
    const abi = [
      "function transfer(address to, uint256 amount) returns (bool)",
      "function balanceOf(address account) view returns (uint256)", 
      "function decimals() view returns (uint8)"];
    const contract = new ethers.Contract(networkConfig.contract, abi, wallet);

    // Como es testnet, asumimos 18 decimales o leemos del contrato
    // const decimals = await contract.decimals(); 
    const decimals = await contract.decimals(); 
    console.log(` Decimales detectados en contrato: ${decimals}`);
    
    const amountToSend = ethers.parseUnits(String(amountStr), decimals);

    const balance = await contract.balanceOf(wallet.address);
    console.log(`   💰 Saldo del Faucet: ${ethers.formatUnits(balance, decimals)} SPX`);

    if (balance < amountToSend) {
      throw new Error(`Saldo insuficiente en Faucet. Tienes ${ethers.formatUnits(balance, decimals)}, intentas enviar ${amountStr}`);
    }
    
    const tx = await contract.transfer(claim.wallet_address, amountToSend);
    console.log(`   Tx enviada: ${tx.hash}. Esperando confirmación...`);
    
    await tx.wait(1); // Esperar 1 bloque

    return { success: true, txHash: tx.hash };
  } catch (err) {
      console.error(`[EVM ERROR - ${claim.blockchain}]`, err.message);
      return { success: false, error: err.message };
  }
}

// ============================================================
// LÓGICA SOLANA
// ============================================================
async function processSolanaClaim(client, claim) {
  let signature = null; // Guardaremos la firma aquí para verificarla luego

  try {
    const amountStr = await getSetting(client, 'faucet_amount_spx', '1');
    const amountToSend = BigInt(Math.floor(parseFloat(amountStr) * (10 ** SPX_DECIMALS)));
    
    console.log(`[SOLANA] Configurado para enviar ${amountStr} SPX...`);

    const userPublicKey = new PublicKey(claim.wallet_address);

    // 1. Cuentas
    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      faucetKeypair,
      TOKEN_MINT_ADDRESS,
      faucetKeypair.publicKey
    );

    const accountInfo = await getAccount(connection, fromTokenAccount.address);
    if (BigInt(accountInfo.amount) < amountToSend) {
      return { success: false, error: `Faucet vacío. Tiene ${accountInfo.amount}, requiere ${amountToSend}` };
    }

    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      faucetKeypair, 
      TOKEN_MINT_ADDRESS,
      userPublicKey
    );

    // 2. Construir Transacción
    const transaction = new Transaction();

    // Prioridad (Ayuda a evitar timeouts)
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }));
    
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: faucetKeypair.publicKey,
        toPubkey: userPublicKey,
        lamports: SOL_FOR_GAS,
      })
    );

    transaction.add(
      createTransferInstruction(
        fromTokenAccount.address, 
        toTokenAccount.address,   
        faucetKeypair.publicKey,  
        amountToSend
      )
    );

    // 3. FIRMA MANUAL Y ENVÍO SEGURO
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = faucetKeypair.publicKey;

    // Firmamos localmente
    transaction.sign(faucetKeypair);
    
    // Obtenemos la firma ANTES de enviar
    signature = bs58.encode(transaction.signature);

    console.log(`[ENVIANDO] Firma generada: ${signature}. Esperando confirmación...`);

    // Enviamos la versión cruda
    const rawTransaction = transaction.serialize();
    
    // SendRawTransaction
    await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        maxRetries: 5
    });

    // Confirmación explícita
    await connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: signature
    }, 'confirmed');
    
    return { success: true, txHash: signature };

  } catch (err) {
    console.error("[SOLANA ERROR INICIAL]", err.message);

    // --- RED DE SEGURIDAD ---
    if (signature) {
      console.log(`[VERIFICANDO] Comprobando estado real de ${signature} en la blockchain...`);
      try {
        const status = await connection.getSignatureStatus(signature);
        if (status.value && (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized')) {
          console.log("✅ [RECUPERADO] La transacción sí fue exitosa a pesar del timeout.");
          return { success: true, txHash: signature };
        }
      } catch (checkErr) {
        console.log("No se pudo verificar el estado:", checkErr.message);
      }
    }

    return { success: false, error: err.message };
  }
}

// ============================================================
// --- BUCLE PRINCIPAL ---
// ============================================================
async function checkDatabaseForJobs() {
  const client = await db.getClient(); 
  try {
    await client.query('BEGIN');

    const jobQuery = `
      SELECT c.*, u.wallet_address 
      FROM claims c
      JOIN users u ON c.user_id = u.id
      WHERE (
        c.status = 'pending' 
        OR (
          c.status = 'failed' 
          AND c.retry_count < $1
          AND (
            c.next_retry_at IS NULL 
            OR c.next_retry_at <= NOW()
          )
        )
      )
      ORDER BY 
        CASE WHEN c.status = 'pending' THEN 1 ELSE 2 END,
        c.claimed_at ASC
      LIMIT 1 
      FOR UPDATE SKIP LOCKED;
    `;

    const { rows } = await client.query(jobQuery, [MAX_RETRIES]);

    if (rows.length === 0) {
      await client.query('COMMIT');
      return;
    }

    const claim = rows[0];
    console.log(`[WORKER] Procesando claim ID: ${claim.id} para ${claim.blockchain} | Address: ${claim.wallet_address} | Retry: ${claim.retry_count}/${MAX_RETRIES}`);

    let result;

    if (claim.blockchain === 'solana') {
      result = await processSolanaClaim(client, claim);
    }
    else if (EVM_NETWORKS[claim.blockchain]) {
      result = await processEvmClaim(client, claim);
    }
    else {
      result = { success: false, error: `Red no soportada: ${claim.blockchain}` };
    }

    if (result.success) {
      console.log(`[ÉXITO FINAL] Tx: ${result.txHash}`);
      await client.query(
        `UPDATE claims 
         SET status = 'success', 
             tx_hash = $1, 
             updated_at = NOW(),
             retry_count = 0,
             next_retry_at = NULL
         WHERE id = $2`,
        [result.txHash, claim.id]
      );
    } else {
      console.log(`[FALLO TEMPORAL] ${result.error}`);

      const newRetryCount = claim.retry_count + 1;
      const nextRetryAt = new Date(Date.now() + RETRY_DELAYS[newRetryCount - 1]);

      if (newRetryCount < MAX_RETRIES) {
        // Schedule retry
        await client.query(
          `UPDATE claims 
            SET status = 'failed', 
              error_log = $1, 
              updated_at = NOW(),
              retry_count = $2,
              last_retry_at = NOW(),
              next_retry_at = $3
            WHERE id = $4`,
          [result.error, newRetryCount, nextRetryAt, claim.id]
        );

        console.log(`[RETRY SCHEDULED] Next retry at ${nextRetryAt.toISOString()}`);
      } else {
        // Final failure
        await client.query(
          `UPDATE claims 
           SET status = 'failed', 
              error_log = $1,
              updated_at = NOW(),
              retry_count = $2,
              last_retry_at = NOW(),
              next_retry_at = NULL
           WHERE id = $3`,
          [result.error, newRetryCount, claim.id]
        );

        console.log(`[FINAL FAILURE] Max retries reached for claim ${claim.id}`);
      }
    }

    await client.query('COMMIT');

  } catch (err) {
    console.error('[WORKER CRASH]', err.message);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

console.log('--- Iniciando Faucet Worker (SOL Mainnet) ---');
if (faucetKeypair) console.log(`[SOLANA] Activo: ${faucetKeypair.publicKey.toBase58()}`);

// --- EMPEZAR HEALTH CHECKER ---
updateWorkerHealth('starting');
setTimeout(() => monitorBalances(), 5000);

setInterval(workerLoop, POLLING_INTERVAL_MS);