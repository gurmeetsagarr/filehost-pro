const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Uploads directory auto-create
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage config for any file type
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'gurmeet-secret-key-0711',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours session
}));

// Terminal logs helper function
function broadcastLog(io, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    io.emit('terminal-log', { timestamp, message, type });
}

// Login Route
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'gurmeet' && password === 'gurmeet0711') {
        req.session.user = {
            username: username,
            loginTime: new Date(),
            ip: req.ip
        };
        broadcastLog(io, `Admin '${username}' logged in successfully from IP: ${req.ip}`, 'success');
        res.json({ success: true });
    } else {
        broadcastLog(io, `Failed login attempt with username: '${username}'`, 'error');
        res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
});

// Logout Route
app.post('/api/auth/logout', (req, res) => {
    const user = req.session.user?.username || 'Unknown';
    req.session.destroy(() => {
        broadcastLog(io, `Admin '${user}' logged out.`, 'info');
        res.json({ success: true });
    });
});

// Dashboard Route Protection
app.get('/dashboard', (req, res) => {
    if (req.session && req.session.user) {
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    } else {
        res.redirect('/');
    }
});

// File Upload Route
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }
    const fileInfo = {
        originalname: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        uploadTime: new Date()
    };
    broadcastLog(io, `File uploaded: ${req.file.originalname} (${(req.file.size / 1024).toFixed(2)} KB)`, 'success');
    res.json({ success: true, file: fileInfo });
});

// Get Files List Route
app.get('/api/files', (req, res) => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Unable to scan files.' });
        }
        const fileList = files.map(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            return {
                filename: file,
                originalName: file.substring(file.indexOf('-') + 1),
                size: stats.size,
                createdAt: stats.birthtime
            };
        });
        res.json({ success: true, files: fileList });
    });
});

// Download File Route
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);
    if (fs.existsSync(filePath)) {
        broadcastLog(io, `File downloaded by admin: ${filename}`, 'info');
        res.download(filePath);
    } else {
        res.status(404).json({ success: false, error: 'File not found.' });
    }
});

// Delete File Route
app.delete('/api/delete/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        broadcastLog(io, `File deleted by admin: ${filename}`, 'warning');
        res.json({ success: true, message: 'File deleted successfully.' });
    } else {
        res.status(404).json({ success: false, error: 'File not found.' });
    }
});

// Socket.io Connection
io.on('connection', (socket) => {
    socket.emit('terminal-log', { timestamp: new Date().toLocaleTimeString(), message: 'Connected to Live Terminal Server.', type: 'info' });
    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
