require('dotenv').config();
const { 
  Connection, 
  Keypair 
} = require('@solana/web3.js');
const { 
  createMint, 
  getOrCreateAssociatedTokenAccount, 
  mintTo 
} = require('@solana/spl-token');
const bs58 = require('bs58');

// Configuración
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

async function main() {
  // 1. Conectar a Solana
  const connection = new Connection(RPC_URL, 'confirmed');

  let payer;
  try {
    const rawKey = process.env.FAUCET_PRIVATE_KEY_SOLANA;
    if (rawKey.trim().startsWith('[')) {
      // Formato JSON Array
      payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(rawKey)));
    } else {
      // Formato Base58
      payer = Keypair.fromSecretKey(bs58.decode(rawKey));
    }
  } catch (e) {
    console.error("❌ Error: Formato de llave privada inválido en .env");
    process.exit(1);
  }
  
  console.log("Conectado con wallet:", payer.publicKey.toBase58());

  // 2. Crear el Token Mint (La "fábrica" de monedas)
  console.log("Creando Token Mint...");
  const mint = await createMint(
    connection,
    payer,             // Quién paga el fee
    payer.publicKey,   // Quién es la autoridad del mint
    null,              // Autoridad de congelamiento (null = nadie)
    9                  // Decimales (igual que SOL, 9 es estándar)
  );

  console.log("✅ TOKEN CREADO (MINT ADDRESS):", mint.toBase58());

  // 3. Crear la cuenta de token para el Faucet (su bolsillo para guardar SPX)
  console.log("Creando cuenta asociada para el Faucet...");
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey
  );

  console.log("Cuenta de Token del Faucet:", tokenAccount.address.toBase58());

  // 4. Mintear suministro inicial (1 Millón de tokens)
  console.log("Minteando 1,000,000 tokens al Faucet...");
  await mintTo(
    connection,
    payer,
    mint,
    tokenAccount.address,
    payer,
    1000000 * 1000000000 // Cantidad * 10^9 decimales
  );

  console.log("---------------------------------------------------");
  console.log("🎉 ¡LISTO! GUARDA ESTA DIRECCIÓN EN TU .ENV:");
  console.log(`SPX_TOKEN_MINT=${mint.toBase58()}`);
  console.log("---------------------------------------------------");
}

main().catch(err => {
  console.error(err);
});