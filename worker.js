require('dotenv').config();
const db = require('./db'); 
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58'); 

// --- CONFIGURACIÓN SOLANA ---
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const TOKEN_MINT_ADDRESS = new PublicKey(process.env.SPX_TOKEN_MINT);
const SPX_DECIMALS = 9; 
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

// --- LÓGICA DE ENVÍO ROBUSTA ---
async function processSolanaClaim(client, claim) {
  let signature = null; // Guardaremos la firma aquí para verificarla luego

  try {
    const amountStr = await getSetting(client, 'faucet_amount_spx', '6900');
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
    // Obtenemos el blockhash más reciente
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = faucetKeypair.publicKey;

    // Firmamos localmente
    transaction.sign(faucetKeypair);
    
    // Obtenemos la firma ANTES de enviar (Esta es la clave)
    // Si la red falla, ya tenemos el ID para buscar el recibo después
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
    // Si tenemos una firma, verificamos si de pura casualidad sí pasó
    if (signature) {
        console.log(`[VERIFICANDO] Comprobando estado real de ${signature} en la blockchain...`);
        try {
            const status = await connection.getSignatureStatus(signature);
            // Si la red dice que no tiene error y tiene confirmaciones, ¡fue un éxito!
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

// --- BUCLE PRINCIPAL ---
async function checkDatabaseForJobs() {
  const client = await db.getClient(); 
  try {
    await client.query('BEGIN');

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
      await client.query('COMMIT');
      return;
    }

    const claim = rows[0];
    console.log(`[WORKER] Procesando claim ID: ${claim.id} para ${claim.blockchain}`);

    let result;
    
    switch (claim.blockchain) {
      case 'solana':
        result = await processSolanaClaim(client, claim);
        break;
      
      default:
        result = { success: false, error: 'Blockchain no soportada.' };
    }

    if (result.success) {
      console.log(`[ÉXITO FINAL] Tx: ${result.txHash}`);
      await client.query(
        "UPDATE claims SET status = 'success', tx_hash = $1, updated_at = NOW() WHERE id = $2",
        [result.txHash, claim.id]
      );
    } else {
      console.log(`[FALLO FINAL] ${result.error}`);
      await client.query(
        "UPDATE claims SET status = 'failed', error_log = $1, updated_at = NOW() WHERE id = $2",
        [result.error, claim.id]
      );
    }

    await client.query('COMMIT');

  } catch (err) {
    console.error('[WORKER CRASH]', err.message);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

console.log('--- Iniciando Faucet Worker (Anti-Timeout Edition) ---');
console.log(`--- Wallet Faucet: ${faucetKeypair.publicKey.toBase58()} ---`);
setInterval(checkDatabaseForJobs, POLLING_INTERVAL_MS);