-- 1. TRAZABILIDAD VIRAL
-- Agregamos 'generated_by' para saber quién creó el código (el "padre" en el árbol viral).
-- Puede ser NULL para los "Genesis Codes" (creados por el admin).
ALTER TABLE qr_codes 
ADD COLUMN generated_by UUID REFERENCES users(id);

-- Agregamos 'expires_at' para que los códigos no duren para siempre.
ALTER TABLE qr_codes 
ADD COLUMN expires_at TIMESTAMPTZ;

-- Índice para limpiar/buscar códigos expirados rápidamente.
CREATE INDEX idx_qr_codes_expires ON qr_codes(expires_at);


-- 2. PREVENCIÓN DE FARMING (Límite estricto)
-- Tu código en JS ya revisa esto, pero la Base de Datos es la última línea de defensa.
-- Queremos asegurar que un usuario (user_id) solo tenga UN reclamo exitoso ('success') 
-- en toda su historia. Esto evita que una wallet drene el faucet.

-- Índice condicional: Solo permite un 'success' por usuario.
-- Si intenta tener otro claim exitoso, la base de datos lanzará error.
CREATE UNIQUE INDEX idx_one_claim_per_user 
ON claims(user_id) 
WHERE status = 'success';