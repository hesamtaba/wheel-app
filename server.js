const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

/*
 * Simple wheel‑of‑fortune web application server.
 *
 * This server provides two responsibilities:
 *  1. Serve static files out of the ./public directory (HTML, CSS, JS, images).
 *  2. Offer a small JSON API for creating wheels, spinning them and retrieving
 *     results. All data is kept in memory for the lifetime of the process.
 *
 * Each wheel consists of a list of options with an associated numeric weight.
 * When a participant spins a wheel, a weighted random choice is made and
 * appended to the wheel's results. Wheels are identified by a short random
 * identifier returned from the create endpoint.
 */

// In‑memory store of created wheels. Keys are wheel IDs. Values contain
// the wheel definition and spin results.
const wheels = {};

// Generate a reasonably unique identifier. This uses base36 to keep the
// identifier short. Collisions are highly unlikely for small numbers of
// concurrent wheels but can be handled by retrying.
function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

// Determine the appropriate content type based on file extension. Only a
// handful of common types are defined. Unknown extensions fallback to
// 'application/octet‑stream'.
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default:      return 'application/octet-stream';
  }
}

// Serve a static file from the public directory. If the file does not
// exist, respond with a 404. This function returns true if it handled the
// request and false otherwise.
function tryServeStatic(req, res, baseDir) {
  const pathname = decodeURI(new URL(req.url, `http://${req.headers.host}`).pathname);
  // Only handle GET/HEAD for static files
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  // Prevent directory traversal by normalising the path
  let filePath = path.join(baseDir, pathname);
  if (filePath.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  }
  // Ensure filePath is still inside baseDir
  if (!filePath.startsWith(path.resolve(baseDir))) {
    return false;
  }
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) {
      return false;
    }
  }
  const contentType = getContentType(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'GET') {
      res.end(content);
    } else {
      res.end();
    }
    return true;
  } catch (err) {
    console.error('Error reading static file', filePath, err);
    // Fall through to default handling
    return false;
  }
}

// Helper to send a JSON response with proper headers
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Handle API requests. Returns true if a response was sent, false otherwise.
async function handleApi(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsedUrl;
  // POST /api/wheels => create a new wheel
  if (req.method === 'POST' && pathname === '/api/wheels') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        // Too much data
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
      if (!payload || !Array.isArray(payload.options) || payload.options.length === 0) {
        return sendJson(res, 400, { error: 'options array is required' });
      }
      // Validate and sanitise options. Each option must have label and weight (numeric)
      const options = [];
      for (const opt of payload.options) {
        const label = typeof opt.label === 'string' ? opt.label.trim() : '';
        const weight = Number(opt.weight);
        if (!label || !Number.isFinite(weight) || weight <= 0) {
          return sendJson(res, 400, { error: 'Each option must contain a non-empty label and a positive numeric weight' });
        }
        options.push({ label, weight });
      }
      // Generate unique id. In the unlikely event of collision, retry a few times.
      let id;
      for (let i = 0; i < 5; i++) {
        id = generateId();
        if (!wheels[id]) break;
      }
      if (wheels[id]) {
        // Could not generate a free id
        return sendJson(res, 500, { error: 'Could not allocate id' });
      }
      wheels[id] = { id, options, results: [] };
      const link = `/wheel.html?id=${id}`;
      const resultsLink = `/results.html?id=${id}`;
      return sendJson(res, 201, { id, link, resultsLink });
    });
    return true;
  }
  // GET /api/wheel/:id => fetch wheel definition (options)
  const wheelDefMatch = pathname.match(/^\/api\/wheel\/([a-zA-Z0-9_-]+)/);
  if (req.method === 'GET' && wheelDefMatch) {
    const id = wheelDefMatch[1];
    const wheel = wheels[id];
    if (!wheel) {
      return sendJson(res, 404, { error: 'Wheel not found' });
    }
    return sendJson(res, 200, { id: wheel.id, options: wheel.options });
  }
  // GET /api/wheel/:id/results => list results
  const resultsMatch = pathname.match(/^\/api\/wheel\/([a-zA-Z0-9_-]+)\/results/);
  if (req.method === 'GET' && resultsMatch) {
    const id = resultsMatch[1];
    const wheel = wheels[id];
    if (!wheel) {
      return sendJson(res, 404, { error: 'Wheel not found' });
    }
    // Return shallow copy so that modifications by the receiver do not affect our store
    const results = wheel.results.map(item => ({ ...item }));
    return sendJson(res, 200, { id: wheel.id, results });
  }
  // POST /api/wheel/:id/spin => record a spin for a participant
  const spinMatch = pathname.match(/^\/api\/wheel\/([a-zA-Z0-9_-]+)\/spin/);
  if (req.method === 'POST' && spinMatch) {
    const id = spinMatch[1];
    const wheel = wheels[id];
    if (!wheel) {
      return sendJson(res, 404, { error: 'Wheel not found' });
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
      if (!name || !phone) {
        return sendJson(res, 400, { error: 'Name and phone are required' });
      }
      // Choose an option based on weights
      const totalWeight = wheel.options.reduce((sum, opt) => sum + opt.weight, 0);
      const r = Math.random() * totalWeight;
      let cumulative = 0;
      let chosen = wheel.options[0];
      for (const opt of wheel.options) {
        cumulative += opt.weight;
        if (r < cumulative) {
          chosen = opt;
          break;
        }
      }
      const result = {
        name,
        phone,
        result: chosen.label,
        timestamp: Date.now()
      };
      wheel.results.push(result);
      return sendJson(res, 200, { result: chosen.label });
    });
    return true;
  }
  // Not an API route we recognise
  return false;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // Try API first. If it handled the request return early.
  const apiHandled = await handleApi(req, res);
  if (apiHandled) {
    return;
  }
  // Try to serve static files from ./public
  const served = tryServeStatic(req, res, path.join(__dirname, 'public'));
  if (!served) {
    // Not found
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// Start listening on the port specified by environment variable PORT or default 3000
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Wheel server listening on http://localhost:${port}`);
});