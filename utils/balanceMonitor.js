const db = require('./db');
const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');

const EVM_NETWORKS = {
  'ethereum': {
    rpc: process.env.ETH_RPC_URL,
    contract: process.env.SPX_ERC20_ADDRESS_ETH,
    name: 'Ethereum',
    explorer: 'https://etherscan.io'
  },
  'base': {
    rpc: process.env.BASE_RPC_URL,
    contract: process.env.SPX_ERC20_ADDRESS_BASE,
    name: 'Base',
    explorer: 'https://basescan.org'
  }
};

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SPX_TOKEN_MINT = process.env.SPX_TOKEN_MINT;
const FAUCET_PRIVATE_KEY_EVM = process.env.FAUCET_PRIVATE_KEY_EVM;
const FAUCET_PRIVATE_KEY_SOLANA = process.env.FAUCET_PRIVATE_KEY_SOLANA;

async function checkEVMBalances() {
  const balances = [];

  for (const [chain, config] of Object.entries(EVM_NETWORKS)) {
    try {
      if (!config.rpc || !config.contract) continue;

      const provider = new ethers.JsonRpcProvider(config.rpc);
      const wallet = new ethers.Wallet(FAUCET_PRIVATE_KEY_EVM, provider);

      // Check native balance
      const nativeBalance = await provider.getBalance(wallet.address);
      const nativeFormatted = ethers.formatEther(nativeBalance);
    
      // Check token balance
      const contract = new ethers.Contract(config.contract, [
        "function balanceOf(address) view returns (uint256)",
        "function decimals() view returns (uint8)"
      ], provider);
      
      const tokenBalance = await contract.balanceOf(wallet.address);
      const decimals = await contract.decimals();
      const tokenFormatted = ethers.formatUnits(tokenBalance, decimals);
      
      balances.push({
        blockchain: chain,
        wallet_address: wallet.address,
        native_balance: parseFloat(nativeFormatted),
        token_balance: parseFloat(tokenFormatted),
        native_threshold: 0.001, // Alert if below 0.01 ETH
        token_threshold: 10, // Alert if below 10 SPX
        is_low: parseFloat(nativeFormatted) < 0.01 || parseFloat(tokenFormatted) < 10,
        explorer_url: `${config.explorer}/address/${wallet.address}`
      });
      
    } catch (error) {
      console.error(`[BALANCE MONITOR] Error checking ${chain}:`, error.message);
    }
  }
  
  return balances;
}

async function checkSolanaBalances() {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const faucetPublicKey = new PublicKey(FAUCET_PRIVATE_KEY_SOLANA);
    
    // Check SOL balance
    const solBalance = await connection.getBalance(faucetPublicKey);
    const solFormatted = solBalance / 1e9;
    
    // Check SPX token balance
    const tokenAccount = await getAssociatedTokenAddress(
      new PublicKey(SPX_TOKEN_MINT),
      faucetPublicKey
    );
    
    let tokenBalance = 0;
    try {
      const accountInfo = await getAccount(connection, tokenAccount);
      tokenBalance = Number(accountInfo.amount) / 1e8; // Assuming 8 decimals for SPX
    } catch (error) {
      // Token account might not exist yet
      tokenBalance = 0;
    }
    
    return [{
      blockchain: 'solana',
      wallet_address: faucetPublicKey.toBase58(),
      native_balance: solFormatted,
      token_balance: tokenBalance,
      native_threshold: 0.01, // Alert if below 0.1 SOL
      token_threshold: 10, // Alert if below 10 SPX
      is_low: solFormatted < 0.1 || tokenBalance < 10,
      explorer_url: `https://solscan.io/account/${faucetPublicKey.toBase58()}`
    }];
    
  } catch (error) {
    console.error('[BALANCE MONITOR] Error checking Solana:', error.message);
    return [];
  }
}

async function updateBalanceInDatabase(balances) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    for (const balance of balances) {
      await client.query(
        `INSERT INTO faucet_balances 
         (blockchain, native_balance, token_balance, last_checked) 
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (blockchain) DO UPDATE SET
         native_balance = EXCLUDED.native_balance,
         token_balance = EXCLUDED.token_balance,
         last_checked = NOW()`,
        [balance.blockchain, balance.native_balance, balance.token_balance]
      );
      
      // Log low balance warnings
      if (balance.is_low) {
        console.warn(`⚠️ LOW BALANCE ALERT: ${balance.blockchain.toUpperCase()}`);
        console.warn(`   Native: ${balance.native_balance} (threshold: ${balance.native_threshold})`);
        console.warn(`   Token: ${balance.token_balance} SPX (threshold: ${balance.token_threshold})`);
        console.warn(`   Wallet: ${balance.wallet_address}`);
        
        // TODO: Add notification system (email, Discord, Telegram)
      }
    }
    
    await client.query('COMMIT');
  } catch (error) {
    console.error('[BALANCE MONITOR] Database error:', error.message);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function monitorBalances() {
  console.log('[BALANCE MONITOR] Starting balance check...');
  
  try {
    const evmBalances = await checkEVMBalances();
    const solanaBalances = await checkSolanaBalances();
    const allBalances = [...evmBalances, ...solanaBalances];
    
    await updateBalanceInDatabase(allBalances);
    
    // Log summary
    allBalances.forEach(balance => {
      console.log(`[${balance.blockchain.toUpperCase()}] 
        Native: ${balance.native_balance.toFixed(4)} 
        Token: ${balance.token_balance.toFixed(2)} SPX
        Status: ${balance.is_low ? '⚠️ LOW' : '✅ OK'}`);
    });
    
  } catch (error) {
    console.error('[BALANCE MONITOR] Fatal error:', error.message);
  }
}

module.exports = { monitorBalances };