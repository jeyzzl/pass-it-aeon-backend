// index.js

// 1. Cargar variables de entorno
require('dotenv').config();

// 2. Importar dependencias
const express = require('express');

// 3. Inicializar la app de Express
const app = express();
const PORT = process.env.PORT || 3000;

// 4. Definir una ruta de prueba
app.get('/', (req, res) => {
  res.send('¡El servidor "pass-it-aeon" está funcionando!');
});

// 5. Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});