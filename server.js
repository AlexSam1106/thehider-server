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

    io.on('connection', (socket) => {
        console.log('Un usuario se ha conectado:', socket.id);

        // Cuando un jugador se conecta, añade su ID y posición inicial
        // Se corrige la altura inicial Y a 0.27 para que coincida con la base del modelo Cannon.js del cliente
        players[socket.id] = {
            position: { x: 0, y: 0.27, z: 0 }, // **CORREGIDO: Posición inicial Y para que el jugador esté en el suelo**
            rotation: 0, // Rotación Y
            pitchRotation: 0, // Rotación X de la cámara (arriba/abajo)
            flashlightOn: true, // Estado inicial de la linterna
            playerAnimationState: 'idle' // **AÑADIDO: Estado inicial de la animación**
        };

        // Envía a los jugadores actuales al nuevo jugador
        // **CORRECCIÓN CLAVE:** Asegura que cada objeto de jugador tenga su 'id' interno
        const playersWithIds = {};
        for (const playerId in players) {
            playersWithIds[playerId] = { id: playerId, ...players[playerId] };
        }
        socket.emit('currentPlayers', playersWithIds);

        // Envía el nuevo jugador (con su ID) a los otros jugadores
        socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] }); // Envía su propio estado inicial a los demás

        // Cuando un jugador se mueve
        socket.on('playerMoved', (playerData) => {
            if (players[socket.id]) { // Asegúrate de que el jugador aún exista
                players[socket.id].position = playerData.position;
                players[socket.id].rotation = playerData.rotation;
                players[socket.id].pitchRotation = playerData.pitchRotation;
                players[socket.id].flashlightOn = playerData.flashlightOn; // Actualiza el estado de la linterna
                players[socket.id].playerAnimationState = playerData.playerAnimationState; // **AÑADIDO: Actualiza el estado de la animación**

                // Envía la actualización de la posición (con ID y nuevo estado) a todos los demás jugadores
                socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });
            }
        });

        // Cuando un jugador envía un mensaje de chat
        socket.on('chatMessage', (message) => {
            console.log(`Mensaje de chat de ${socket.id}: ${message}`);
            // Envía el mensaje a todos los clientes conectados, incluyendo el remitente
            io.emit('chatMessage', { senderId: socket.id, text: message });
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
      console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
    });
