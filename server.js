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

    // Este servidor SOLO manejará las conexiones de Socket.IO.
    // No hay rutas de Express para servir archivos estáticos aquí.

    // players almacenará el estado de los jugadores, incluyendo su nombre de usuario y la sala en la que están
    // Ejemplo: { 'socketId1': { username: 'Player1', bio: '...', position: {...}, roomId: 'room123', ... } }
    const players = {}; 

    // rooms almacenará el estado de las salas
    // Ejemplo: { 'room123': { id: 'room123', name: 'Sala de Prueba', hostId: 'socketId1', players: [{ socketId: 'socketId1', username: 'Player1' }], maxPlayers: 6, status: 'waiting' } }
    const rooms = {};

    // Función para generar un ID único para las salas
    function generateRoomId() {
        return Math.random().toString(36).substring(2, 9); // Genera una cadena alfanumérica corta
    }

    // Función para obtener una lista de salas para enviar a los clientes
    function getPublicRoomList() {
        const publicRooms = [];
        for (const roomId in rooms) {
            const room = rooms[roomId];
            publicRooms.push({
                id: room.id,
                name: room.name,
                currentPlayers: room.players.length,
                maxPlayers: room.maxPlayers,
                status: room.status // 'waiting', 'playing', 'full'
            });
        }
        return publicRooms;
    }

    io.on('connection', (socket) => {
        console.log(`[CONEXIÓN] Un usuario se ha conectado: ${socket.id}`);

        // --- Manejo del registro de usuario desde la página del menú ---
        socket.on('registerUser', (userData) => {
            const { username, bio } = userData;
            console.log(`[REGISTRO] Usuario '${username}' (${socket.id}) intentando registrarse.`);

            // Verifica si el nombre de usuario ya está en uso por algún jugador conectado
            const usernameExists = Object.values(players).some(p => p.username === username);

            if (usernameExists) {
                console.log(`[REGISTRO FALLIDO] Nombre de usuario '${username}' ya existe.`);
                socket.emit('usernameExists', { username: username });
            } else {
                // Si el nombre de usuario es único, lo registra
                players[socket.id] = {
                    username: username, // Almacena el nombre de usuario
                    bio: bio, // Almacena la bio
                    position: { x: 0, y: 0.27, z: 0 }, 
                    rotation: 0, 
                    pitchRotation: 0, 
                    flashlightOn: true, 
                    playerAnimationState: 'idle',
                    roomId: null // El jugador aún no está en ninguna sala
                };
                console.log(`[REGISTRO EXITOSO] Usuario '${username}' registrado con éxito para ID: ${socket.id}`);
                socket.emit('usernameRegistered', { username: username, bio: bio });

                // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
                io.emit('updateRoomList', getPublicRoomList());
                console.log(`[LOBBY] Lista de salas actualizada emitida a todos los clientes.`);
            }
        });

        // --- Manejo de la creación de salas ---
        socket.on('createRoom', (roomData) => {
            const { roomName, maxPlayers } = roomData;
            const creatorId = socket.id;
            const creatorUsername = players[creatorId] ? players[creatorId].username : 'Desconocido';

            if (!players[creatorId]) {
                console.log(`[CREAR SALA FALLIDO] Creador no registrado: ${creatorId}`);
                socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                return;
            }

            const roomId = generateRoomId();
            rooms[roomId] = {
                id: roomId,
                name: roomName,
                hostId: creatorId,
                players: [{ socketId: creatorId, username: creatorUsername }],
                maxPlayers: maxPlayers,
                status: 'waiting' // Estado inicial de la sala
            };

            // El creador se une a la sala de Socket.IO
            socket.join(roomId);
            players[creatorId].roomId = roomId; // Actualiza el roomId del jugador

            console.log(`[SALA CREADA] Sala '${roomName}' (ID: ${roomId}) creada por ${creatorUsername}.`);
            socket.emit('roomCreated', { roomId: roomId, roomName: roomName });

            // Envía la lista de salas actualizada a todos los clientes
            io.emit('updateRoomList', getPublicRoomList());
            console.log(`[LOBBY] Lista de salas actualizada después de creación de '${roomName}'.`);
        });

        // --- Manejo de unirse a una sala ---
        socket.on('joinRoom', (data) => {
            const { roomId } = data;
            const joiningPlayerId = socket.id;
            const joiningPlayerUsername = players[joiningPlayerId] ? players[joiningPlayerId].username : 'Desconocido';

            if (!players[joiningPlayerId]) {
                console.log(`[UNIRSE SALA FALLIDO] Jugador no registrado: ${joiningPlayerId}`);
                socket.emit('roomError', { message: 'Debes registrar un perfil de usuario primero.' });
                return;
            }

            const room = rooms[roomId];

            if (!room) {
                console.log(`[UNIRSE SALA FALLIDO] Sala ${roomId} no encontrada.`);
                socket.emit('roomError', { message: `La sala '${roomId}' no existe.` });
                return;
            }

            if (room.players.length >= room.maxPlayers) {
                console.log(`[UNIRSE SALA FALLIDO] Sala ${roomId} está llena.`);
                socket.emit('roomError', { message: `La sala '${room.name}' está llena.` });
                return;
            }

            // Si el jugador ya está en una sala, lo saca de ella
            if (players[joiningPlayerId].roomId && players[joiningPlayerId].roomId !== roomId) {
                const oldRoomId = players[joiningPlayerId].roomId;
                const oldRoom = rooms[oldRoomId];
                if (oldRoom) {
                    oldRoom.players = oldRoom.players.filter(p => p.socketId !== joiningPlayerId);
                    socket.leave(oldRoomId);
                    console.log(`[SALA] Jugador ${joiningPlayerUsername} dejó la sala ${oldRoom.name} (${oldRoomId}).`);
                    // Notificar a los demás jugadores en la sala antigua que alguien se fue
                    io.to(oldRoomId).emit('playerLeftRoom', { socketId: joiningPlayerId, username: joiningPlayerUsername });
                    if (oldRoom.players.length === 0) {
                        delete rooms[oldRoomId];
                        console.log(`[SALA] Sala ${oldRoom.name} (${oldRoomId}) vacía y eliminada.`);
                    }
                }
            }

            // El jugador se une a la sala de Socket.IO
            socket.join(roomId);
            players[joiningPlayerId].roomId = roomId; // Actualiza el roomId del jugador

            // Añade el jugador a la lista de jugadores de la sala si no está ya
            const playerAlreadyInRoom = room.players.some(p => p.socketId === joiningPlayerId);
            if (!playerAlreadyInRoom) {
                room.players.push({ socketId: joiningPlayerId, username: joiningPlayerUsername });
            }

            console.log(`[SALA UNIDA] Jugador '${joiningPlayerUsername}' se unió a la sala '${room.name}' (ID: ${roomId}).`);
            
            // Envía la confirmación al jugador que se unió
            socket.emit('roomJoined', { 
                roomId: roomId, 
                roomName: room.name, 
                playersInRoom: room.players.map(p => ({ id: p.socketId, username: p.username })) 
            });

            // Envía la lista de jugadores actuales a este jugador (esto lo haremos más adelante desde el cliente del juego)
            // Por ahora, 'roomJoined' ya incluye la lista de jugadores en la sala.

            // Notifica a los demás jugadores en la sala que alguien se unió
            socket.to(roomId).emit('playerJoinedRoom', { id: joiningPlayerId, username: joiningPlayerUsername, position: players[joiningPlayerId].position });

            // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
            io.emit('updateRoomList', getPublicRoomList());
            console.log(`[LOBBY] Lista de salas actualizada después de que ${joiningPlayerUsername} se uniera a '${room.name}'.`);
        });

        // Cuando un jugador se mueve, las actualizaciones se emiten SOLO a los de la misma sala
        socket.on('playerMoved', (playerData) => {
            const playerId = socket.id;
            if (players[playerId] && players[playerId].roomId) { // Verifica que el jugador esté en una sala
                const currentRoomId = players[playerId].roomId;
                
                // Actualiza los datos del jugador
                players[playerId].position = playerData.position;
                players[playerId].rotation = playerData.rotation;
                players[playerId].pitchRotation = playerData.pitchRotation;
                players[playerId].flashlightOn = playerData.flashlightOn;
                players[playerId].playerAnimationState = playerData.playerAnimationState;

                // Emite la actualización de movimiento SÓLO a los demás jugadores en la misma sala
                socket.to(currentRoomId).emit('playerMoved', { id: playerId, ...players[playerId] });
            } else {
                console.log(`[MOVIMIENTO IGNORADO] Jugador ${playerId} intentó moverse sin estar en una sala.`);
            }
        });

        // Cuando un jugador envía un mensaje de chat, ahora se envía solo a la sala actual
        socket.on('chatMessage', (message) => {
            const senderUsername = players[socket.id] ? players[socket.id].username : 'Desconocido';
            const senderRoomId = players[socket.id] ? players[socket.id].roomId : null;

            if (senderRoomId) {
                console.log(`[CHAT EN SALA] Mensaje de ${senderUsername} (${socket.id}) en sala ${senderRoomId}: ${message}`);
                // Envía el mensaje a todos los clientes en la misma sala, incluyendo el remitente
                io.to(senderRoomId).emit('chatMessage', { senderId: senderUsername, text: message });
            } else {
                console.log(`[CHAT LOBBY] Mensaje de ${senderUsername} (${socket.id}) en el lobby: ${message}`);
                // Si no está en una sala, lo tratamos como un mensaje de lobby (enviado a todos por defecto)
                io.emit('chatMessage', { senderId: senderUsername, text: message });
            }
        });

        // Cuando un jugador se desconecta
        socket.on('disconnect', () => {
            const disconnectedUsername = players[socket.id] ? players[socket.id].username : socket.id.substring(0,4) + '...';
            const disconnectedRoomId = players[socket.id] ? players[socket.id].roomId : null;

            console.log(`[DESCONEXIÓN] Un usuario se ha desconectado: ${disconnectedUsername} (${socket.id})`);
            
            // Si el jugador estaba en una sala, lo elimina de ella
            if (disconnectedRoomId && rooms[disconnectedRoomId]) {
                const room = rooms[disconnectedRoomId];
                room.players = room.players.filter(p => p.socketId !== socket.id);
                console.log(`[SALA] Jugador ${disconnectedUsername} dejó la sala ${room.name} (${disconnectedRoomId}).`);
                
                // Notifica a los demás jugadores en esa sala que alguien se desconectó
                io.to(disconnectedRoomId).emit('playerDisconnected', socket.id);

                // Si la sala se queda vacía, la elimina
                if (room.players.length === 0) {
                    delete rooms[disconnectedRoomId];
                    console.log(`[SALA] Sala ${room.name} (${disconnectedRoomId}) vacía y eliminada.`);
                } else if (room.hostId === socket.id) {
                    // Si el host se desconecta, asigna un nuevo host o cierra la sala (por simplicidad, cerramos la sala)
                    console.log(`[SALA HOST DESCONECTADO] El host de la sala ${room.name} (${disconnectedRoomId}) se desconectó. Cerrando sala.`);
                    io.to(disconnectedRoomId).emit('roomClosed', { roomId: disconnectedRoomId, message: 'El host se desconectó.' });
                    delete rooms[disconnectedRoomId];
                }
            } else {
                // Si el jugador no estaba en una sala, simplemente se elimina
                console.log(`[LOBBY] Jugador ${disconnectedUsername} desconectado del lobby.`);
            }

            delete players[socket.id]; // Elimina al jugador del objeto global de jugadores
            
            // Envía la lista de salas actualizada a todos los clientes (especialmente al menú)
            io.emit('updateRoomList', getPublicRoomList());
            console.log(`[LOBBY] Lista de salas actualizada después de la desconexión de ${disconnectedUsername}.`);
        });

        // Al desconectarse, un socket abandona automáticamente todas las salas, excepto la default (su propio ID de socket)
        // No necesitamos `socket.leave(roomId)` explícitamente en `disconnect` para la sala de Socket.IO,
        // pero sí necesitamos limpiar nuestros objetos `players` y `rooms`.
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Servidor de Socket.IO escuchando en el puerto ${PORT}`);
    });
