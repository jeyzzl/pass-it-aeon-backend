INSERT INTO game_settings (key, value) VALUES ('points_level_2_percentage', '20')
ON CONFLICT (key) DO NOTHING;

INSERT INTO game_settings (key, value) VALUES ('refill_codes_per_success', '1')
ON CONFLICT (key) DO NOTHING;