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

const uploadDir = path.join(__dirname, 'uploads');
const dbFile = path.join(__dirname, 'users.json');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify([]));

// Helper to read/write users
const getUsers = () => JSON.parse(fs.readFileSync(dbFile));
const saveUsers = (users) => fs.writeFileSync(dbFile, JSON.stringify(users, null, 2));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
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
    secret: 'gurmeet-secret-high-end-0711',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function broadcastLog(io, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    io.emit('terminal-log', { timestamp, message, type });
}

// --- AUTH ROUTES ---

// User Signup
app.post('/api/auth/signup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'All fields required' });
    
    let users = getUsers();
    if (users.find(u => u.username === username) || username === 'gurmeet') {
        return res.status(400).json({ success: false, error: 'Username already exists' });
    }

    users.push({ username, password, createdAt: new Date(), files: [], activeTime: 0 });
    saveUsers(users);
    broadcastLog(io, `New user registered: ${username}`, 'success');
    res.json({ success: true });
});

// Login (Admin or User)
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (username === 'gurmeet' && password === 'gurmeet0711') {
        req.session.user = { username, role: 'admin', loginTime: new Date() };
        broadcastLog(io, `Admin 'gurmeet' logged in.`, 'success');
        return res.json({ success: true, role: 'admin' });
    }

    let users = getUsers();
    let user = users.find(u => u.username === username && u.password === password);
    if (user) {
        req.session.user = { username, role: 'user', loginTime: new Date() };
        broadcastLog(io, `User '${username}' logged in.`, 'info');
        return res.json({ success: true, role: 'user' });
    }

    broadcastLog(io, `Failed login attempt for: '${username}'`, 'error');
    res.status(401).json({ success: false, error: 'Invalid username or password' });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// --- PAGE ROUTING ---
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (req.session.user.role === 'admin') {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'user.html'));
    }
});

// --- FILE MANAGEMENT ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file || !req.session.user) return res.status(400).json({ success: false, error: 'Unauthorized or no file' });

    const fileInfo = {
        originalname: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        uploadTime: new Date()
    };

    if (req.session.user.role === 'user') {
        let users = getUsers();
        let user = users.find(u => u.username === req.session.user.username);
        if (user) {
            if (!user.files) user.files = [];
            user.files.push(fileInfo);
            saveUsers(users);
        }
    }

    broadcastLog(io, `File uploaded by ${req.session.user.username}: ${req.file.originalname}`, 'success');
    res.json({ success: true, file: fileInfo });
});

// Get Files (Admin sees all users' files, User sees only their files)
app.get('/api/files', (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false });

    if (req.session.user.role === 'admin') {
        let users = getUsers();
        let allFiles = [];
        users.forEach(u => {
            if (u.files) {
                u.files.forEach(f => allFiles.push({ ...f, uploader: u.username }));
            }
        });
        // Also get root uploads
        res.json({ success: true, users: users, files: allFiles });
    } else {
        let users = getUsers();
        let user = users.find(u => u.username === req.session.user.username);
        res.json({ success: true, files: user ? user.files || [] : [] });
    }
});

app.get('/api/download/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) res.download(filePath);
    else res.status(404).json({ error: 'File not found' });
});

app.delete('/api/delete/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        // Remove from user db if exists
        let users = getUsers();
        users.forEach(u => {
            if (u.files) u.files = u.files.filter(f => f.filename !== req.params.filename);
        });
        saveUsers(users);
        broadcastLog(io, `File deleted: ${req.params.filename}`, 'warning');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

io.on('connection', (socket) => {
    socket.emit('terminal-log', { timestamp: new Date().toLocaleTimeString(), message: 'Connected to High-End Execution Terminal.', type: 'info' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
