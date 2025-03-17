/*******************************************************
 * server.js
 *******************************************************/
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { customAlphabet } = require('nanoid/non-secure');
const cors = require('cors');
const Redis = require("ioredis");
const B2 = require('backblaze-b2');


// Load environment variables from .env
dotenv.config();

const app = express();
const server = http.createServer(app);
const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',20);
const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 50, 2000), // Retry logic
  reconnectOnError: (err) => {
    console.error("Redis error:", err);
    return true;
  },
  tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined, // Secure TLS
});

const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});


// -----------------------------
// 1) MIDDLEWARE
// -----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    // Adjust this array for all allowed front-end URLs
    origin: [
      'http://localhost:5173',
      'http://192.168.1.100:5173',
      'https://sw-frontend-25jq.onrender.com',
      'https://www.spinningwheel.app',
    ],
    credentials: true,
  })
);

// -----------------------------
// 2) SOCKET.IO SETUP
// -----------------------------
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:5173',
      'http://192.168.1.100:5173',
      'https://sw-frontend-25jq.onrender.com',
      'https://www.spinningwheel.app',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Optional Socket.IO auth middleware:
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      // No token => treat user as guest
      socket.user = { id: `guest-${socket.id}`, name: 'Guest' };
      return next();
    }
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

// Memory store for active rooms -> participants
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.on('message', async (data) => {
    await redis.set(`message:${socket.id}`, data);
    socket.broadcast.emit("message", data);
  });
  // Join room
  socket.on('join-room', async (roomId) => {
    let session = null;
    try {
      // Find session by invite key
      session = await pool.query('SELECT * FROM sessions WHERE invite_key = $1', [roomId]);

      if (session.rows.length === 0) {
        throw new Error('Session not found or expired');
      }

      // Only add to participants table if this is not a guest user
      if (socket.user && socket.user.id && !socket.user.id.toString().startsWith('guest-')) {
        // Add participant to the session
        await pool.query(
          'INSERT INTO participants (session_id, user_id, join_time) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
          [session.rows[0].session_id, socket.user.id]
        );

        // Track new user joins via invite link
        if (socket.user.is_new_user) {
          await pool.query(
            'INSERT INTO invite_tracking (session_id, referrer_user_id, invited_user_id, registered_at) VALUES ($1, $2, $3, NOW())',
            [session.rows[0].session_id, session.rows[0].host_id, socket.user.id]
          );
        }
      }

      socket.emit('joined-room', { success: true, sessionId: session.rows[0].session_id });
      // Join socket.io room
      socket.join(roomId);
      // Track in memory
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(socket.id);

      // Notify others
      socket.to(roomId).emit('user-connected', socket.id);

      // Send existing participants to the newly joined socket
      const otherParticipants = Array.from(rooms.get(roomId)).filter(
        (id) => id !== socket.id
      );
      socket.emit('existing-participants', otherParticipants);

      // Update participant count
      io.to(roomId).emit('participant-count', rooms.get(roomId).size);
    } catch (error) {
      const sessionId = session && session.rows.length ? session.rows[0].session_id : null;
      console.error('Join-room error:', error.message);
      // Only log to error_logs if session exists
      if (sessionId) {
        try {
          await pool.query(
            'INSERT INTO error_logs (session_id, user_id, error_type, error_message, error_time) VALUES ($1, $2, $3, $4, NOW())',
            [
              sessionId, 
              socket.user && !socket.user.id.toString().startsWith('guest-') ? socket.user.id : null, 
              'join_failed', 
              error.message
            ]
          );
        } catch (logError) {
          console.error('Failed to log error:', logError);
        }
      }
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Start Recording
  socket.on('start-recording', async ({ roomId }) => {
    if (!rooms.has(roomId)) return;
    
    rooms.get(roomId).recording = true;
    rooms.get(roomId).recordingStartTime = Date.now();
    
    io.to(roomId).emit('recording-started', { roomId });
  });

  // Stop Recording
  socket.on('stop-recording', async ({ roomId }) => {
    if (!rooms.has(roomId)) return;

    rooms.get(roomId).recording = false;
    io.to(roomId).emit('recording-stopped', { roomId });
  });

  // WebRTC signaling
  socket.on('offer', ({ offer, roomId, targetId }) => {
    console.log(`Relaying offer from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('offer', {
      offer,
      senderId: socket.id,
    });
  });

  socket.on('answer', ({ answer, roomId, targetId }) => {
    console.log(`Relaying answer from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('answer', {
      answer,
      senderId: socket.id,
    });
  });

  socket.on('ice-candidate', ({ candidate, roomId, targetId }) => {
    console.log(`Relaying ICE candidate from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('ice-candidate', {
      candidate,
      senderId: socket.id,
    });
  });

  socket.on('ready-to-connect', (roomId) => {
    console.log(`User ${socket.id} is ready to connect in room ${roomId}`);
    socket.to(roomId).emit('user-ready', socket.id);
  });

  // Active Speaker Detection
  socket.on('audio-level', ({ roomId, userId, level }) => {
    // Store the active speaker based on audio level
    if (!rooms.has(roomId)) return;

    const currentActiveSpeaker = rooms.get(roomId).activeSpeaker;
    
    if (!currentActiveSpeaker || currentActiveSpeaker.userId !== userId) {
      rooms.get(roomId).activeSpeaker = { userId, level };
      io.to(roomId).emit('active-speaker', { userId });
    }
  });

  // Disconnection
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);

    try {
        if (socket.user && socket.user.id !== undefined) {
            const userId = socket.user.id.toString();
            if (!userId.startsWith('guest-')) {
                // This is a registered user with a numeric ID
                const result = await pool.query(
                    'UPDATE participants SET leave_time = NOW() WHERE user_id = $1 AND leave_time IS NULL RETURNING session_id',
                    [socket.user.id]
                );

                if (result.rows.length > 0) {
                    const sessionId = result.rows[0].session_id;
                    console.log(`User ${socket.user.id} left session ${sessionId}`);
                } else {
                    console.log(`No active session found for user ${socket.user.id}`);
                }
            } else {
                console.log(`Guest user disconnected: ${socket.user.id}`);
            }
        } else {
            console.log(`Unknown user disconnected: ${socket.id}`);
        }

        // Remove user from in-memory rooms tracking
        rooms.forEach((participants, roomId) => {
            if (participants.has(socket.id)) {
                participants.delete(socket.id);
                console.log(`Removed ${socket.id} from room ${roomId}`);
              
                // Notify all clients in the room
                io.to(roomId).emit('user-disconnected', socket.id);
                io.to(roomId).emit('participant-count', participants.size);

                console.log(`Updated participant count for room ${roomId}: ${participants.size}`);

                // If no participants remain, clean up the room
                if (participants.size === 0) {
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} deleted from memory`);
                }
            }
        });

    } catch (error) {
        console.error('Error updating participant status:', error);
    }
});
});

// -----------------------------
// 3) POSTGRES SETUP
// -----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon.tech
  },
});

// Test DB connection at startup
pool
  .connect()
  .then((client) => {
    console.log('Database connected successfully');
    client.release();
  })
  .catch((err) => {
    console.error('Database connection error:', {
      error: err.message,
    });
  });

// -----------------------------
// 4) Backblaze B2 FOR FILE UPLOADS
// -----------------------------
const storage = multer.memoryStorage(); // Store file in memory (RAM)
const upload = multer({ storage });

async function uploadFile(fileBuffer, fileName) {
  await b2.authorize();
  const response = await b2.uploadFile({
    bucketId: process.env.B2_BUCKET_ID,
    fileName: fileName,
    data: fileBuffer,
  });
  return response.data;
}

// Create 'uploads' dir if needed
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// -----------------------------
// 5) AUTH MIDDLEWARE
// -----------------------------
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  console.log("Incoming Auth Header:", authHeader);
  if (!token) {
    console.warn("Access denied: No token provided");
    return res.status(401).json({ error: 'Access denied' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.warn("Invalid Token:", token);
      return res.status(403).json({ error: 'Invalid token' });
    }
    console.log("Authenticated User:", user);
    req.user = user;
    next();
  });
};

// -----------------------------
// 6) ROUTES
// -----------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      port: process.env.PORT,
      dbHost: process.env.DB_HOST,
      nodeEnv: process.env.NODE_ENV,
    },
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running' });
});

// Test DB endpoint
app.get('/api/test-db', async (req, res) => {
  try {
    const timeResult = await pool.query('SELECT NOW()');
    const usersResult = await pool.query('SELECT COUNT(*) FROM users');
    const testUser = await pool.query(
      'SELECT id, name, email FROM users WHERE email = $1',
      ['arnavjig@gmail.com']
    );

    res.json({
      success: true,
      time: timeResult.rows[0].now,
      userCount: usersResult.rows[0].count,
      testUser: testUser.rows[0] || null,
      message: 'Database connection successful',
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING user_id, username, email',
      [name, email, hashedPassword, 'guest']
    );

    const token = jwt.sign(
      { id: result.rows[0].user_id, email, role: result.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      token,
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again later.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
    }

    const token = jwt.sign(
      { id: user.user_id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.user_id,
        name: user.username,  // Keep 'name' for frontend compatibility
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// Update user name (requires auth)
app.post('/api/updateName', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await pool.query(
      'UPDATE users SET username = $1 WHERE user_id = $2 RETURNING user_id, name, email',
      [name, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Error updating name:', error);
    res.status(500).json({ error: 'Failed to update name' });
  }
});

// Update profile photo (requires auth)
app.post('/api/updateProfilePhoto', authenticateToken, upload.single('profilePhoto'), async (req, res) => {
  try {
    const { filename } = req.file;

    const result = await pool.query(
      'UPDATE users SET profile_photo = $1 WHERE id = $2 RETURNING id, name, email, profile_photo',
      [filename, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Error updating profile photo:', error);
    res.status(500).json({ error: 'Failed to update profile photo' });
  }
});

// Change password (requires auth)
app.post('/api/changePassword', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedPassword, req.user.id]);

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Create a session (requires auth)
app.post('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;
    const roomId = nanoid();
    
    console.log('Creating session with title:', title);
    console.log('User ID:', req.user.id);

    // Check if user already has an active session
    const existingSession = await pool.query(
      'SELECT * FROM sessions WHERE host_id = $1 AND end_time IS NULL',
      [req.user.id]
    );
    if (existingSession.rows.length > 0) {
      console.log("User already has an active session:", existingSession.rows[0]);

      // End the existing session without trying to set duration directly
      await pool.query(
        'UPDATE sessions SET end_time = NOW() WHERE session_id = $1',
        [existingSession.rows[0].session_id]
      );

      console.log(`Ended previous session: ${existingSession.rows[0].session_id}`);
    }
    
    // Update the user role to host if creating a session
    await pool.query(
      'UPDATE users SET role = $1 WHERE user_id = $2',
      ['host', req.user.id]
    );
    
    // Create new session
    const result = await pool.query(
      `INSERT INTO sessions (host_id, invite_key, start_time) VALUES ($1, $2, NOW()) RETURNING *`,
      [req.user.id, roomId]
    );
    console.log(`Session created successfully:`, result.rows[0]);
    res.status(201).json({
      ...result.rows[0],
      inviteKey: roomId, // Return the invite key
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// End a session (requires auth)
app.post('/api/sessions/end', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.body;
    
    // First, find the session by invite key
    const session = await pool.query(
      'SELECT session_id FROM sessions WHERE invite_key = $1', 
      [roomId]
    );

    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Just update the end_time - duration will be calculated automatically
    await pool.query(
      'UPDATE sessions SET end_time = NOW() WHERE session_id = $1', 
      [session.rows[0].session_id]
    );

    res.json({ message: 'Session ended successfully' });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Fetch an active session by roomId (requires auth)
app.get('/api/sessions/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const result = await pool.query(
      'SELECT * FROM sessions WHERE room_id = $1 AND status = $2',
      [roomId, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload video endpoint
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Authorize with BackBlaze B2
    await b2.authorize();
    // Upload file to B2
    const uploadUrl = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    const response = await b2.uploadFile({
      uploadUrl: uploadUrl.data.uploadUrl,
      uploadAuthToken: uploadUrl.data.authorizationToken,
      fileName: `recordings/${Date.now()}-${req.file.originalname}`, // Unique filename
      data: req.file.buffer, // Use buffer since multer stores in memory
      contentType: req.file.mimetype, // Preserve file type
    });
    // Get the public file URL
    const fileUrl = `https://f000.backblazeb2.com/file/${process.env.B2_BUCKET_NAME}/${response.data.fileName}`;
     // Save file URL to database
    const result = await pool.query(
      'INSERT INTO recordings (session_id, recorded_by, file_url, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionId, userId, fileUrl, 'processing']
    );

    res.status(200).json({ success: true, fileUrl: fileUrl, recording: result.rows[0] });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/process-recording', async (req, res) => {
  try {
    const { sessionId } = req.body;

    // Fetch recordings from DB
    const result = await pool.query(
      'SELECT file_url FROM recordings WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No recordings found' });
    }

    // Generate FFmpeg merge command
    const files = result.rows.map(row => `file 'uploads/${row.file_url}'`).join('\n');
    const fileListPath = `uploads/${sessionId}_filelist.txt`;
    fs.writeFileSync(fileListPath, files);

    const outputFilePath = `uploads/${sessionId}_final.mp4`;
    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i ${fileListPath} -c copy ${outputFilePath}`;

    require('child_process').exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', error);
        return res.status(500).json({ error: 'Merging failed' });
      }

      res.json({ success: true, finalRecording: outputFilePath });
    });

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: 'Failed to process recording' });
  }
});

// Add this function to find a session by invite key
async function findSessionByInviteKey(inviteKey) {
  const result = await pool.query('SELECT * FROM sessions WHERE room_id = $1', [inviteKey]);
  return result.rows[0];
}

// Update the /join-session endpoint
app.post('/api/join-session', authenticateToken, async (req, res) => {
  const { inviteKey } = req.body;
  console.log("Received Join Request for Invite Key:", inviteKey);
  try {
    const session = await pool.query(
      'SELECT * FROM sessions WHERE invite_key = $1 AND (end_time IS NULL OR end_time > NOW())',
      [inviteKey]
    );
    console.log("Database Query Result:", session.rows);
    
    if (session.rows.length === 0) {
      console.log("Session Not Found or Expired for Key:", inviteKey);
      return res.status(404).json({ success: false, message: 'Session not found or expired' });
    }
    
    // Check if the session exists before adding participant
    const sessionId = session.rows[0].session_id;
    console.log("Valid Session Found - ID:", sessionId);
    
    // Add participant to session
    await pool.query(
      'INSERT INTO participants (session_id, user_id, join_time) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
      [session.rows[0].session_id, req.user.id]
    );
    console.log(`User ${req.user.id} added as participant to session ${sessionId}`);
    
    // Return the invite key for the client to use with socket connection
    res.json({ success: true, sessionId: session.rows[0].invite_key });
  } catch (error) {
    console.error('Error joining session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// -----------------------------
// 7) ERROR HANDLING MIDDLEWARE
// -----------------------------
app.use((err, req, res, next) => {
  console.error('Error:', err);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// -----------------------------
// 8) START THE SERVER
// -----------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on ${PORT}`);
});

console.log('Starting server...');