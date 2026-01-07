const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- RENDER.COM FIX ---
// Serve static files from the 'public' directory first
app.use('/public', express.static(path.join(__dirname, 'public')));
// Serve the root static files like index.html
app.use(express.static(path.join(__dirname)));

// Explicitly define the root route. THIS IS THE MOST IMPORTANT PART.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// --- END FIX ---


const CONFIG_FILE = 'db_config.json';

// --- CONFIGURATION HELPER ---
function getDbConfig() {
    if (process.env.DB_HOST) {
        return {
            host: process.env.DB_HOST, user: process.env.DB_USER,
            password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
            port: process.env.DB_PORT || 3306
        };
    }
    if (fs.existsSync(CONFIG_FILE)) { return JSON.parse(fs.readFileSync(CONFIG_FILE)); }
    return null;
}

// --- EXECUTE QUERY HELPER ---
function executeQuery(sql, params, callback) {
    const config = getDbConfig();
    if (!config) return callback(new Error("DB Config Not Found"), null);
    
    const connection = mysql.createConnection({ ...config, connectTimeout: 20000 });
    connection.connect(err => {
        if (err) return callback(err, null);
        connection.query(sql, params, (err, results) => {
            connection.end();
            callback(err, results);
        });
    });
}

// --- API ROUTES ---
app.get('/api/check-install', (req, res) => {
    res.json({ installed: !!getDbConfig() });
});

app.post('/api/install', (req, res) => {
    const { dbHost, dbUser, dbPass, dbName, adminEmail, adminPass } = req.body;
    let host = dbHost; let port = 3306;
    if (dbHost && dbHost.includes(':')) { [host, port] = dbHost.split(':'); port = parseInt(port); }
    const connection = mysql.createConnection({ host, user: dbUser, password: dbPass, database: dbName, port });

    connection.connect(err => {
        if (err) return res.status(500).json({ error: "Connection Failed: " + err.message });
        
        const queries = [
            `CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), login VARCHAR(255), email VARCHAR(255), password VARCHAR(255), role VARCHAR(50), dept VARCHAR(50), status BOOLEAN, perms TEXT, last_login VARCHAR(50))`,
            `CREATE TABLE IF NOT EXISTS events (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255), start VARCHAR(50), color VARCHAR(20), synced BOOLEAN)`,
            `CREATE TABLE IF NOT EXISTS qc_incubation (id INT AUTO_INCREMENT PRIMARY KEY, date VARCHAR(50), batch VARCHAR(50), ph7 VARCHAR(50), fat7 VARCHAR(50), status VARCHAR(50))`,
            `CREATE TABLE IF NOT EXISTS qc_rm (id INT AUTO_INCREMENT PRIMARY KEY, date VARCHAR(50), material VARCHAR(100), inspector VARCHAR(100), status VARCHAR(50))`,
            `CREATE TABLE IF NOT EXISTS qc_pm (id INT AUTO_INCREMENT PRIMARY KEY, date VARCHAR(50), material VARCHAR(100), batch VARCHAR(100), status VARCHAR(50))`,
            `CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, s_key VARCHAR(50), s_value TEXT)`
        ];
        
        function runQ(index) {
            if (index >= queries.length) {
                const adminSql = `INSERT INTO users (name, login, email, password, role, dept, status, perms, last_login) VALUES (?, ?, ?, ?, 'Admin', 'Management', 1, ?, 'Never')`;
                const perms = JSON.stringify(["QC Management", "Document Mgmt", "Change Mgmt", "Audit Mgmt"]);
                connection.query('DELETE FROM users WHERE login = ?', [adminEmail], () => {
                    connection.query(adminSql, ['System Admin', adminEmail, adminEmail, adminPass, perms], () => {
                        connection.end();
                        if (!process.env.RENDER) {
                            fs.writeFileSync(CONFIG_FILE, JSON.stringify({ host, user: dbUser, password: dbPass, database: dbName, port }));
                        }
                        res.json({ success: true });
                    });
                });
                return;
            }
            connection.query(queries[index], () => runQ(index + 1));
        }
        runQ(0);
    });
});

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    executeQuery('SELECT * FROM users WHERE (login = ? OR email = ?) AND password = ?', [user, user, pass], (err, results) => {
        if (err || !results) return res.json({ success: false, message: "DB Error" });
        if (results.length > 0) {
            executeQuery('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toLocaleString(), results[0].id], () => {});
            res.json({ success: true, user: results[0] });
        } else {
            res.json({ success: false, message: "Invalid Credentials" });
        }
    });
});

// All other API routes...
app.get('/api/:table', (req, res) => {
    const allowedTables = ['users', 'events'];
    if (!allowedTables.includes(req.params.table)) return res.status(400).json({ error: "Invalid table" });
    executeQuery(`SELECT * FROM ${req.params.table}`, [], (err, rows) => res.json(rows || []));
});
app.get('/api/qc/:type', (req, res) => {
    const allowedTypes = ['incubation', 'rm', 'pm'];
    if (!allowedTypes.includes(req.params.type)) return res.status(400).json({ error: "Invalid QC type" });
    executeQuery(`SELECT * FROM qc_${req.params.type}`, [], (err, rows) => res.json(rows || []));
});
app.post('/api/users', (req, res) => {
    const { name, login, email, password, role, dept, status, perms } = req.body;
    executeQuery('INSERT INTO users (name, login, email, password, role, dept, status, perms, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
    [name, login, email, password || '12345', role, dept, status, JSON.stringify(perms), 'Never'], (err) => res.json({ success: !err, error: err ? err.message : null }));
});
app.delete('/api/users/:id', (req, res) => {
    executeQuery('DELETE FROM users WHERE id=?', [req.params.id], (err) => res.json({ success: !err }));
});
app.post('/api/events', (req, res) => {
    const { title, start, color, synced } = req.body;
    executeQuery('INSERT INTO events (title, start, color, synced) VALUES (?, ?, ?, ?)', [title, start, color, synced], (err) => res.json({ success: !err }));
});
app.post('/api/qc/incubation', (req, res) => {
    const { date, batch, ph7, fat7, status } = req.body;
    executeQuery('INSERT INTO qc_incubation (date, batch, ph7, fat7, status) VALUES (?, ?, ?, ?, ?)', [date, batch, ph7, fat7, status], (err) => res.json({ success: !err }));
});
app.post('/api/qc/rm', (req, res) => {
    const { date, material, inspector, status } = req.body;
    executeQuery('INSERT INTO qc_rm (date, material, inspector, status) VALUES (?, ?, ?, ?)', [date, material, inspector, status], (err) => res.json({ success: !err }));
});
app.post('/api/qc/pm', (req, res) => {
    const { date, material, batch, status } = req.body;
    executeQuery('INSERT INTO qc_pm (date, material, batch, status) VALUES (?, ?, ?, ?)', [date, material, batch, status], (err) => res.json({ success: !err }));
});
app.get('/api/settings', (req, res) => {
    executeQuery('SELECT * FROM settings', [], (err, rows) => {
        let config = {};
        if (rows) rows.forEach(r => config[r.s_key] = r.s_value);
        res.json(config);
    });
});
app.post('/api/settings', (req, res) => {
    const { host, port, user, pass, secure } = req.body;
    const values = [['smtp_host', host], ['smtp_port', port], ['smtp_user', user], ['smtp_pass', pass], ['smtp_secure', secure]];
    executeQuery('DELETE FROM settings', [], () => {
        executeQuery('INSERT INTO settings (s_key, s_value) VALUES ?', [values], () => res.json({ success: true }));
    });
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
