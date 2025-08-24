const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple file-based storage (persists between restarts)
const DATA_FILE = path.join(__dirname, 'quota_data.json');

const WINDOW_MS = 302460601000; // 30 days
const BANNED_USERS = [
  'u1k7diqj', 'u7yv2va', 'u1elu7v6', 'u1gz618', 'u22ttj6',
  'un5banw', 'u1w7q9al', 'ufmneff', 'u1va3pb8', 'u2x2q06',
  'uy32xo3', 'u16fw92s', 'u4q0n0', 'uavwnu1', 'uin2d05',
  'u14dcqpo', 'u1xv0p5t', 'uqrc25s', 'u3w1n2j', 'u1qp3mzh',
  'u1afzcwi', 'udzwaar', 'ud3e8ef', 'u1a4a432', 'u16p0ltw',
  'u69knuc', 'uhrclt9', 'u1ixg65v', 'ufahxah', 'uvpszko',
  'u1dq5bz0', 'udtexci', 'uhodc46', 'u1u0pi62', 'uvz37v5',
  'u1m6xims', 'uztsfwz', 'u1e1k32m'
];

// Storage functions
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('Error loading data:', e);
  }
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('Error saving data:', e);
  }
}

function key(id) {
  return 'quota:' + String(id);
}

function read(id) {
  const data = loadData();
  const raw = data[key(id)];
  if (!raw) return { start: Date.now(), count: 0 };
  try {
    const o = JSON.parse(raw);
    if (typeof o.start !== 'number' || typeof o.count !== 'number') throw 0;
    return o;
  } catch (_) {
    return { start: Date.now(), count: 0 };
  }
}

function write(id, rec) {
  const data = loadData();
  data[key(id)] = JSON.stringify(rec);
  saveData(data);
}

function hashId(email) {
  email = String(email).trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < email.length; i++) {
    h = ((h << 5) + h) ^ email.charCodeAt(i);
  }
  const hashValue = h >>> 0;
  if (hashValue === 0) return 'u0';
  return 'u' + hashValue.toString(36);
}

// Main route - works exactly like your Google Apps Script
app.all('/', (req, res) => {
  const p = req.method === 'GET' ? req.query : req.body;
  const id = String(p.id || '');
  const now = Date.now();
  
  // Handle GET requests (quota checking)
  if (req.method === 'GET') {
    // Banned users always get maxed quota
    if (BANNED_USERS.includes(id)) {
      const bannedPayload = {
        ok: true,
        id: id,
        start: now,
        count: 30
      };
      
      const cb = p.callback;
      if (cb) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.send(`${cb}(${JSON.stringify(bannedPayload)})`);
      }
      
      return res.json(bannedPayload);
    }
    
    let rec = read(id);
    
    if (String(p.bump || '') === '1') {
      if (rec.extendedQuota && rec.extendedQuota > 0) {
        rec.count += 1;
        
        if (rec.count >= (30 + rec.extendedQuota)) {
          const timeSinceOriginalStart = now - rec.originalMonthStart;
          const monthsPassed = Math.floor(timeSinceOriginalStart / WINDOW_MS);
          
          if (monthsPassed >= 1) {
            rec.start = now;
            rec.count = 0;
            console.log('Multiple months passed, resetting immediately');
          } else {
            rec.start = rec.originalMonthStart;
            rec.count = 0;
            console.log('Same month, resuming from original start date');
          }
          
          rec.extendedQuota = 0;
          rec.originalMonthStart = null;
        }
      } else {
        if (now - rec.start >= WINDOW_MS && rec.count >= 30) {
          rec.start = now;
          rec.count = 0;
        }
        rec.count += 1;
      }
      
      write(id, rec);
    }
    
    const payload = {
      ok: true,
      id: id,
      start: rec.start,
      count: rec.count,
      extendedQuota: rec.extendedQuota || 0
    };
    
    const cb = p.callback;
    if (cb) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.send(`${cb}(${JSON.stringify(payload)})`);
    }
    
    return res.json(payload);
  }
  
  // Handle POST requests (webhooks)
  if (req.method === 'POST') {
    try {
      // Handle Stripe webhooks
      if (req.body.type === 'checkout.session.completed') {
        const customerEmail = req.body.data?.object?.customer_details?.email;
        
        if (!customerEmail) {
          return res.status(400).json({ error: 'No customer email' });
        }
        
        const userId = hashId(customerEmail);
        console.log('Processing payment for email:', customerEmail, '-> User ID:', userId);
        
        let quota = read(userId);
        quota.extendedQuota = (quota.extendedQuota || 0) + 100;
        quota.extendedAt = new Date().toISOString();
        quota.originalMonthStart = quota.originalMonthStart || quota.start;
        
        write(userId, quota);
        
        console.log('Successfully processed payment for', userId);
        return res.json({ message: 'Payment processed successfully' });
      }
      
      // Handle direct quota extensions
      if (req.body.action === 'extend_quota') {
        const userId = req.body.userId;
        const additionalRequests = req.body.additionalRequests || 100;
        
        if (!userId) {
          return res.status(400).json({ error: 'Missing userId' });
        }
        
        let quota = read(userId);
        quota.extendedQuota = (quota.extendedQuota || 0) + additionalRequests;
        quota.extendedAt = new Date().toISOString();
        quota.originalMonthStart = quota.originalMonthStart || quota.start;
        
        write(userId, quota);
        
        return res.json({
          success: true,
          message: `Extended quota for user ${userId}: +${additionalRequests} requests`
        });
      }
      
    } catch (error) {
      console.error('POST error:', error);
      return res.status(500).json({ error: 'Failed to process request' });
    }
  }
  
  res.status(405).json({ error: 'Method not allowed' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
