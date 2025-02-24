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
const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 20);
const cors = require('cors');

// Load environment variables first
dotenv.config();

const app = express();
const server = http.createServer(app);

// IMPORTANT: Move ALL middleware to the top, before ANY routes or socket setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: ["http://localhost:5173", "http://192.168.1.100:5173"], // Add your local IP address
  credentials: true
}));

// Initialize Socket.IO after middleware
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust this to your frontend URL in production
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// PostgreSQL setup with better error handling
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Configure local storage instead of S3
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/') // Make sure this directory exists
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});

const upload = multer({ storage: storage });

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Store active rooms and their participants
const rooms = new Map();

// Add before io.on('connection')
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      // If no token, consider them a guest user
      socket.user = { id: `guest-${socket.id}`, name: 'Guest' };
      return next(); 
    }

    // Otherwise, check token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (error) {
    // If token is invalid, block or treat them as guest
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room
  socket.on('join-room', async (roomId) => {
    try {
      const session = await pool.query('SELECT * FROM sessions WHERE room_id = $1', [roomId]);
      
      if (session.rows.length === 0) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      await pool.query(
        'INSERT INTO participants (session_id, user_id) VALUES ($1, $2)',
        [session.rows[0].id, socket.user.id]
      );

      socket.join(roomId);
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(socket.id);
      socket.to(roomId).emit('user-connected', socket.id);
      const participants = Array.from(rooms.get(roomId)).filter(id => id !== socket.id);
      socket.emit('existing-participants', participants);
      io.to(roomId).emit('participant-count', rooms.get(roomId).size);
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle WebRTC signaling
  socket.on('offer', ({ offer, roomId, targetId }) => {
    socket.to(targetId).emit('offer', {
      offer,
      senderId: socket.id
    });
  });

  socket.on('answer', ({ answer, roomId, targetId }) => {
    socket.to(targetId).emit('answer', {
      answer,
      senderId: socket.id
    });
  });

  socket.on('ice-candidate', ({ candidate, roomId, targetId }) => {
    socket.to(targetId).emit('ice-candidate', {
      candidate,
      senderId: socket.id
    });
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    try {
      // Update participant record when user leaves
      await pool.query(
        'UPDATE participants SET left_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND left_at IS NULL',
        [socket.user.id]
      );
      
      // Remove from memory store
      rooms.forEach((participants, roomId) => {
        if (participants.has(socket.id)) {
          participants.delete(socket.id);
          io.to(roomId).emit('user-disconnected', socket.id);
          io.to(roomId).emit('participant-count', participants.size);
          if (participants.size === 0) {
            rooms.delete(roomId);
          }
        }
      });
    } catch (error) {
      console.error('Error updating participant status:', error);
    }
  });
});

// Endpoint to handle video uploads
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    const { filename } = req.file;

    const result = await pool.query(
      'INSERT INTO recordings (session_id, user_id, file_name) VALUES ($1, $2, $3) RETURNING *',
      [sessionId, userId, filename]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Test database connection
pool.connect()
  .then(client => {
    console.log('Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('Database connection error:', {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
      error: err.message
    });
  });

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// Add a health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      port: process.env.PORT,
      dbHost: process.env.DB_HOST,
      nodeEnv: process.env.NODE_ENV
    }
  });
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// User routes
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
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );

    const token = jwt.sign(
      { id: result.rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({ 
      token,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again later.' });
  }
});

// Update the login route with better error handling and logging
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Session management
app.post('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;
    const roomId = nanoid();
    
    const result = await pool.query(
      'INSERT INTO sessions (room_id, host_id, title) VALUES ($1, $2, $3) RETURNING *',
      [roomId, req.user.id, title]
    );

    res.status(201).json({
      ...result.rows[0],
      inviteKey: roomId // Return the invite key
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Add near the top after creating the app
app.get('/api/sessions/:roomId', async (req, res) => {
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

// Add near the top after creating the app
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

// Add this route for testing
app.post('/api/test-register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );

    res.status(201).json({ 
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Test registration error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Add this test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running' });
});

// Add this test endpoint
app.get('/api/test-db', async (req, res) => {
  try {
    // Test basic query
    const timeResult = await pool.query('SELECT NOW()');
    
    // Test users table
    const usersResult = await pool.query('SELECT COUNT(*) FROM users');
    
    // Test specific user
    const testUser = await pool.query(
      'SELECT id, name, email FROM users WHERE email = $1',
      ['arnavjig@gmail.com']
    );

    res.json({
      success: true,
      time: timeResult.rows[0].now,
      userCount: usersResult.rows[0].count,
      testUser: testUser.rows[0] || null,
      message: 'Database connection successful'
    });
  } catch (error) {
    console.error('Database test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Start the server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Avoid logging sensitive information
console.log('Starting server...');
console.log('Environment variables:', {
  PORT: process.env.PORT,
  DB_HOST: process.env.DB_HOST,
  NODE_ENV: process.env.NODE_ENV
});
