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

    // players almacenará el estado de los jugadores, ahora incluyendo el nombre de usuario
    // Ejemplo: { 'socketId1': { username: 'Player1', position: {...}, ... }, 'socketId2': { ... } }
    const players = {}; 

    io.on('connection', (socket) => {
        console.log('Un usuario se ha conectado:', socket.id);

        // --- NEW: Handle username registration from the menu page ---
        socket.on('registerUser', (userData) => {
            const { username, bio } = userData;
            console.log(`Usuario ${username} (${socket.id}) intentando registrarse.`);

            // Basic check for unique username (for simplicity, case-sensitive for now)
            const usernameExists = Object.values(players).some(p => p.username === username);

            if (usernameExists) {
                socket.emit('usernameExists', { username: username });
                console.log(`Intento de registro fallido: Nombre de usuario '${username}' ya existe.`);
            } else {
                // If username is unique, register it
                players[socket.id] = {
                    username: username, // Store the username
                    bio: bio, // Store the bio
                    position: { x: 0, y: 0.27, z: 0 }, 
                    rotation: 0, 
                    pitchRotation: 0, 
                    flashlightOn: true, 
                    playerAnimationState: 'idle'
                };
                socket.emit('usernameRegistered', { username: username, bio: bio });
                console.log(`Usuario '${username}' registrado con éxito para ID: ${socket.id}`);

                // Send current players to the newly connected player
                // **CORRECTION CLAVE:** Asegura que cada objeto de jugador tenga su 'id' interno
                const playersWithIds = {};
                for (const playerId in players) {
                    playersWithIds[playerId] = { id: playerId, ...players[playerId] };
                }
                socket.emit('currentPlayers', playersWithIds);

                // Send the new player (with their ID and username) to other players
                // Asegúrate de que el 'playerMoved' inicial también incluya el nombre de usuario
                socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] }); 
                console.log(`Nuevo jugador '${username}' emitido a otros.`);
            }
        });


        // Cuando un jugador se mueve (este evento ahora siempre incluirá el nombre de usuario del cliente)
        socket.on('playerMoved', (playerData) => {
            if (players[socket.id]) { // Asegúrate de que el jugador aún exista
                players[socket.id].position = playerData.position;
                players[socket.id].rotation = playerData.rotation;
                players[socket.id].pitchRotation = playerData.pitchRotation;
                players[socket.id].flashlightOn = playerData.flashlightOn; // Actualiza el estado de la linterna
                players[socket.id].playerAnimationState = playerData.playerAnimationState; // Actualiza el estado de la animación
                // El nombre de usuario ya debería estar establecido en `players[socket.id]` desde 'registerUser'
                // playerData.username ya viene del cliente y se actualiza en el cliente
                // No es necesario asignarlo aquí de nuevo si ya se gestionó en 'registerUser'
                // Si playerData.username viene aquí, simplemente aseguramos que se mantenga
                if (playerData.username) {
                    players[socket.id].username = playerData.username;
                }

                // Envía la actualización de la posición (con ID y nuevo estado, incluyendo nombre de usuario) a todos los demás jugadores
                socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });
            }
        });

        // Cuando un jugador envía un mensaje de chat
        socket.on('chatMessage', (message) => {
            const senderUsername = players[socket.id] ? players[socket.id].username : 'Desconocido';
            console.log(`Mensaje de chat de ${senderUsername} (${socket.id}): ${message}`);
            // Envía el mensaje a todos los clientes conectados, incluyendo el remitente
            io.emit('chatMessage', { senderId: senderUsername, text: message }); // Usa el nombre de usuario como senderId
        });

        // Cuando un jugador se desconecta
        socket.on('disconnect', () => {
            const disconnectedUsername = players[socket.id] ? players[socket.id].username : socket.id.substring(0,4) + '...';
            console.log(`Un usuario se ha desconectado: ${disconnectedUsername} (${socket.id})`);
            delete players[socket.id]; // Elimina al jugador del objeto
            // Envía el ID del jugador desconectado a los demás para que lo eliminen de la escena
            io.emit('playerDisconnected', socket.id); // Solo se necesita el ID para eliminar el modelo
        });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
    });
