// utils/solanaFaucet.js
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58');

// Monto fijo a enviar (ej. 0.01 SOL)
const AMOUNT_TO_SEND_LAMPORTS = 0.01 * solanaWeb3.LAMPORTS_PER_SOL;

const RPC_URL = process.env.SOLANA_RPC_URL;
const PRIVATE_KEY_STRING = process.env.FAUCET_PRIVATE_KEY_SOLANA;

async function sendSolanaToken(claim) {
  try {
    // 1. Conectar a la red
    const connection = new solanaWeb3.Connection(RPC_URL, 'confirmed');

    // 2. Cargar nuestra billetera de faucet
    // (Asume que la clave está guardada como un string JSON "[1,2,3...]")
    const secretKey = bs58.decode(PRIVATE_KEY_STRING);
    const faucetKeypair = solanaWeb3.Keypair.fromSecretKey(secretKey);

    console.log(`[SOL] Dirección PÚBLICA del Faucet: ${faucetKeypair.publicKey.toBase58()}`);

    // 3. Destino
    const destPubkey = new solanaWeb3.PublicKey(claim.wallet_address);

    // 4. Crear y enviar la transacción
    console.log(`[SOL] Enviando ${AMOUNT_TO_SEND_LAMPORTS / solanaWeb3.LAMPORTS_PER_SOL} SOL a ${claim.wallet_address}...`);

    const transaction = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: faucetKeypair.publicKey,
        toPubkey: destPubkey,
        lamports: AMOUNT_TO_SEND_LAMPORTS,
      })
    );

    const signature = await solanaWeb3.sendAndConfirmTransaction(
      connection,
      transaction,
      [faucetKeypair]
    );

    console.log(`[SOL] ¡Éxito! Firma: ${signature}`);
    return { success: true, txHash: signature };

  } catch (err) {
    console.error(`[SOL] Error al procesar ${claim.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendSolanaToken };