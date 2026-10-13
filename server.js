const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server);

const uploadDir = path.join(__dirname, 'uploads');
const dbFile = path.join(__dirname, 'users.json');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify([]));

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
app.use('/uploads', express.static(uploadDir));

app.use(session({
    secret: 'gurmeet-matrix-secret-0711',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { 
        maxAge: 8 * 60 * 60 * 1000,
        secure: false,
        sameSite: 'lax'
    }
}));

function broadcastLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    io.emit('terminal-log', { timestamp, message, type });
}

app.post('/api/auth/signup', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'All fields required' });
    let users = getUsers();
    if (users.find(u => u.username === username) || username === 'gurmeet') {
        return res.status(400).json({ success: false, error: 'Username taken' });
    }
    users.push({ username, password, files: [] });
    saveUsers(users);
    broadcastLog(`New user registered: ${username}`, 'success');
    res.json({ success: true });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'gurmeet' && password === 'gurmeet0711') {
        req.session.user = { username, role: 'admin' };
        broadcastLog(`Admin 'gurmeet' logged in.`, 'success');
        return res.json({ success: true, role: 'admin' });
    }
    let users = getUsers();
    let user = users.find(u => u.username === username && u.password === password);
    if (user) {
        req.session.user = { username, role: 'user' };
        broadcastLog(`User '${username}' logged in.`, 'info');
        return res.json({ success: true, role: 'user' });
    }
    res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (req.session.user.role === 'admin') res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    else res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: 'Session expired. Please login again.' });
    }

    const fileInfo = {
        originalname: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        uploadTime: new Date()
    };

    let users = getUsers();
    if (req.session.user.role === 'admin') {
        let adminUser = users.find(u => u.username === 'gurmeet');
        if (!adminUser) {
            users.push({ username: 'gurmeet', password: 'gurmeet0711', files: [fileInfo] });
        } else {
            if (!adminUser.files) adminUser.files = [];
            adminUser.files.push(fileInfo);
        }
    } else {
        let user = users.find(u => u.username === req.session.user.username);
        if (user) {
            if (!user.files) user.files = [];
            user.files.push(fileInfo);
        }
    }
    saveUsers(users);

    broadcastLog(`File uploaded [${req.session.user.username}]: ${req.file.originalname}`, 'success');
    res.json({ success: true, file: fileInfo });
});

app.get('/api/files', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    let users = getUsers();
    if (req.session.user.role === 'admin') {
        let allFiles = [];
        users.forEach(u => {
            if (u.files) u.files.forEach(f => allFiles.push({ ...f, uploader: u.username }));
        });
        res.json({ success: true, files: allFiles });
    } else {
        let user = users.find(u => u.username === req.session.user.username);
        res.json({ success: true, files: user ? user.files || [] : [] });
    }
});

// INTERACTIVE TERMINAL EXECUTOR WITH AUTO PEP-668 BYPASS FOR PIP
app.post('/api/terminal/exec', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    let { command } = req.body;
    if (!command) return res.status(400).json({ success: false, error: 'No command' });

    // Auto-fix for python pip restriction
    let cleanCmd = command.trim();
    if (cleanCmd.startsWith('pip install') && !cleanCmd.includes('--break-system-packages')) {
        cleanCmd = cleanCmd.replace('pip install', 'pip install --break-system-packages');
    }

    broadcastLog(`$ ${cleanCmd}`, 'warning');
    const child = spawn(cleanCmd, { shell: true, cwd: uploadDir });

    child.stdout.on('data', (data) => broadcastLog(data.toString().trim(), 'info'));
    child.stderr.on('data', (data) => broadcastLog(data.toString().trim(), 'error'));
    child.on('close', (code) => broadcastLog(`Command exited with code ${code}`, code === 0 ? 'success' : 'error'));

    res.json({ success: true });
});

app.post('/api/run/:filename', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });

    const ext = path.extname(filename).toLowerCase();
    broadcastLog(`Starting execution for: ${filename} by ${req.session.user.username}`, 'warning');

    let child;
    if (ext === '.py') {
        child = spawn('python3', [filePath], { cwd: uploadDir });
    } else if (ext === '.js') {
        child = spawn('node', [filePath], { cwd: uploadDir });
    } else {
        return res.json({ success: false, error: 'Unsupported format' });
    }

    child.stdout.on('data', (data) => broadcastLog(`[OUTPUT] ${data.toString().trim()}`, 'info'));
    child.stderr.on('data', (data) => broadcastLog(`[ERROR] ${data.toString().trim()}`, 'error'));
    child.on('close', (code) => broadcastLog(`Process exited with code ${code}`, code === 0 ? 'success' : 'error'));

    res.json({ success: true });
});

app.get('/api/download/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) res.download(filePath);
    else res.status(404).json({ error: 'Not found' });
});

app.delete('/api/delete/:filename', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        let users = getUsers();
        users.forEach(u => {
            if (u.files) u.files = u.files.filter(f => f.filename !== req.params.filename);
        });
        saveUsers(users);
        broadcastLog(`File deleted: ${req.params.filename}`, 'error');
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

io.on('connection', (socket) => {
    socket.emit('terminal-log', { timestamp: new Date().toLocaleTimeString(), message: 'Connected to Execution & Terminal Engine.', type: 'info' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
