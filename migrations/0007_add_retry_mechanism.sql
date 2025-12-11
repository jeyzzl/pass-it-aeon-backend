-- Add retry columns to claims table
ALTER TABLE claims ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP WITH TIME ZONE;

-- Add index for efficient retry queries
CREATE INDEX idx_claims_retryable ON claims(status, next_retry_at) 
WHERE status = 'failed' AND retry_count < 3;

-- Add worker health monitoring table
CREATE TABLE worker_health (
    id SERIAL PRIMARY KEY,
    worker_type VARCHAR(50) NOT NULL,
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'healthy',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add faucet balance tracking
CREATE TABLE faucet_balances (
    id SERIAL PRIMARY KEY,
    blockchain VARCHAR(20) NOT NULL,
    native_balance DECIMAL(24, 8),
    token_balance DECIMAL(24, 8),
    last_checked TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add unique constraint to worker_health.worker_type
ALTER TABLE worker_health ADD CONSTRAINT worker_health_worker_type_key UNIQUE (worker_type);

-- Add unique constraint to faucet_balances.blockchain
ALTER TABLE faucet_balances ADD CONSTRAINT faucet_balances_blockchain_key UNIQUE (blockchain);