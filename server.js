const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

// --- CORS CONFIGURATION ---
const io = new Server(server, {
  cors: {
    origin: "https://thehidergame.ballongame.io", // 
    methods: ["GET", "POST"]
  }
});

const players = {}; // Almacena el estado de los jugadores

io.on('connection', (socket) => {
    console.log('Un usuario se ha conectado:', socket.id);

    // Cuando un jugador se conecta, añade su ID y posición inicial
    // Se corrige la altura inicial Y a 0.27 para que coincida con la base del modelo Cannon.js del cliente
    players[socket.id] = {
        position: { x: 0, y: 1.8, z: 0 }, 
        rotation: 0, // Rotación Y
        pitchRotation: 0, // Rotación X de la cámara (arriba/abajo)
        flashlightOn: true, // Estado inicial de la linterna
        playerAnimationState: 'idle' // Estado inicial de la animación
    };

    // Envía a los jugadores actuales al nuevo jugador
    socket.emit('currentPlayers', players);

    // Envía el nuevo jugador a los otros jugadores
    socket.broadcast.emit('playerMoved', players[socket.id]); // Envía su propio estado inicial a los demás

    // Cuando un jugador se mueve
    socket.on('playerMoved', (playerData) => {
        if (players[socket.id]) { // Asegúrate de que el jugador aún exista
            players[socket.id].position = playerData.position;
            players[socket.id].rotation = playerData.rotation;
            players[socket.id].pitchRotation = playerData.pitchRotation;
            players[socket.id].flashlightOn = playerData.flashlightOn; // Actualiza el estado de la linterna
            players[socket.id].playerAnimationState = playerData.playerAnimationState; // Actualiza el estado de la animación

            // Envía la actualización de la posición a todos los demás jugadores
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // Nuevo: Cuando se recibe un mensaje de chat
    socket.on('chatMessage', (messageText) => {
        console.log(`Mensaje de chat de ${socket.id}: ${messageText}`);
        // Guarda el mensaje (opcional, si quieres un historial en el servidor)
        // No es estrictamente necesario almacenar el chat en 'players' a menos que sea un historial persistente por jugador.
        // Lo importante es retransmitirlo.

        // Envía el mensaje de chat a TODOS los clientes conectados
        io.emit('chatMessage', { senderId: socket.id, text: messageText });
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
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
