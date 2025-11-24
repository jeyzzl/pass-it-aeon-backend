-- Agregamos las columnas que el nuevo worker está intentando usar
ALTER TABLE claims ADD COLUMN IF NOT EXISTS error_log TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;