const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

// --- CORS CONFIGURATION ---
const io = new Server(server, {
  cors: {
    origin: "https://thehidergame.ballongame.io", // ¡IMPORTANTE! Asegúrate que sea EXACTAMENTE tu dominio de Hostinger
    methods: ["GET", "POST"]
  }
});

// NO HAY LÍNEAS DE app.use(express.static) O app.get('/') AQUÍ.
// Este servidor SOLO manejará las conexiones de Socket.IO.

const players = {}; // Almacena el estado de los jugadores

// --- NUEVO: Definir una semilla global para la generación del mapa ---
// Puedes usar un valor fijo para un mapa siempre igual, o generar uno aleatorio al inicio del servidor
const mapSeed = Math.random(); // Genera una semilla aleatoria cada vez que el servidor inicia
// const mapSeed = 12345; // Para un mapa fijo en cada reinicio del servidor

io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // Cuando un jugador se conecta, añade su ID y posición inicial
    players[socket.id] = {
        id: socket.id, // Añadir el ID del socket al objeto del jugador para fácil referencia
        position: { x: 0, y: 1.8, z: 0 }, // Posición inicial del jugador (la altura 1.8 es la del jugador)
        rotation: 0, // Rotación Y
        pitchRotation: 0, // Rotación X de la cámara (arriba/abajo)
        flashlightOn: true // Estado inicial de la linterna
    };

    // --- NUEVO: Enviar la semilla del mapa al cliente que se conecta ---
    socket.emit('mapSeed', mapSeed);

    // Envía a los jugadores actuales al nuevo jugador
    // Se envía una copia para evitar referencias directas que puedan causar problemas de estado
    const currentPlayersCopy = {};
    for (const id in players) {
        if (id !== socket.id) { // No enviar el propio jugador en 'currentPlayers'
            currentPlayersCopy[id] = players[id];
        }
    }
    socket.emit('currentPlayers', currentPlayersCopy);


    // Envía el nuevo jugador a los otros jugadores
    socket.broadcast.emit('playerMoved', players[socket.id]); // Envía su propio estado inicial a los demás

    // Cuando un jugador se mueve
    socket.on('playerMoved', (playerData) => {
        if (players[socket.id]) { // Asegúrate de que el jugador aún exista
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn; // Actualiza el estado de la linterna

            // Envía la actualización de la posición a todos los demás jugadores
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // Cuando un jugador se desconecta
    socket.on('disconnect', () => {
        console.log('Un usuario se ha desconectado:', socket.id);
        delete players[socket.id]; // Elimina al jugador del objeto
        // Envía el ID del jugador desconectado a los demás para que lo eliminen de la escena
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Socket.IO escuchando en el puerto ${PORT}`);
});
