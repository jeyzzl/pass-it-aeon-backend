const rateLimit = require('express-rate-limit');

// Limitador estricto para el endpoint de reclamo (Faucet)
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Límite de 5 peticiones por IP por ventana
  standardHeaders: true, // Devuelve info en los headers `RateLimit-*`
  legacyHeaders: false, // Deshabilita los headers `X-RateLimit-*`
  message: {
    success: false,
    error: 'Demasiados intentos de reclamo desde esta IP. Intenta de nuevo en 15 minutos.'
  }
});

// Limitador más suave para lecturas (ej. ver si un token es válido)
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 peticiones por minuto
  message: { success: false, error: 'Calma, demasiadas peticiones.' }
});

module.exports = { claimLimiter, generalLimiter };