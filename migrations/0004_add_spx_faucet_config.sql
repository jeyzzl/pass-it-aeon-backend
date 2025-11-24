-- Insertamos la configuración para dar 6900 tokens por defecto
INSERT INTO game_settings (key, value) VALUES ('faucet_amount_spx', '6.9')
ON CONFLICT (key) DO NOTHING;