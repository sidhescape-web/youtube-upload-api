/**
 * YouTube Upload API Server
 *
 * Handles large video uploads to YouTube by:
 * 1. Downloading from a source URL using streams (memory-efficient)
 * 2. Streaming directly to YouTube's resumable upload endpoint
 * 3. Running uploads asynchronously with job tracking
 */

const express = require('express');
const { pipeline } = require('stream');
const { promisify } = require('util');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const pipelineAsync = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const API_KEY = process.env.API_KEY;

// In-memory job store (use Redis/database in production for persistence)
const jobs = new Map();

// Stored refresh token from in-app OAuth (survives until server restart)
let storedRefreshToken = null;

// Parse JSON bodies (for metadata - actual video is streamed from URL)
app.use(express.json({ limit: '1mb' }));

// API key middleware (only enforced when API_KEY env is set)
const requireApiKey = (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.headers['api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '').trim();
  if (key && key === API_KEY) return next();
  res.status(401).json({ error: 'Invalid or missing API key', hint: 'Add X-API-Key header with your API_KEY value' });
};

// Health check endpoint (no API key required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /auth/youtube - Start OAuth flow. Redirects to Google.
 * One-time setup: add redirect URI to Google Console: {BASE_URL}/auth/youtube/callback
 */
app.get('/auth/youtube', (req, res) => {
  if (!YOUTUBE_CLIENT_ID) {
    return res.status(500).json({
      error: 'YOUTUBE_CLIENT_ID not set',
      hint: 'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in env, then add redirect URI to Google Console',
    });
  }
  const redirectUri = `${BASE_URL.replace(/\/$/, '')}/auth/youtube/callback`;
  const scopes = encodeURIComponent('https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${YOUTUBE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;
  res.redirect(url);
});

/**
 * GET /auth/youtube/callback - OAuth callback. Stores refresh token.
 */
app.get('/auth/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`<h1>OAuth Error</h1><p>${error}</p>`);
  }
  if (!code || !YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    return res.status(400).send('<h1>Missing code or credentials</h1>');
  }
  const redirectUri = `${BASE_URL.replace(/\/$/, '')}/auth/youtube/callback`;
  const body = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }).toString();

  return new Promise((resolveOuter) => {
    const req2 = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res2) => {
        let data = '';
        res2.on('data', (chunk) => { data += chunk; });
        res2.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.refresh_token) {
              storedRefreshToken = json.refresh_token;
              res.status(200).send('<h1>Success</h1><p>YouTube is now connected. You can close this page and use the API from n8n. No tokens needed in requests.</p>');
            } else {
              res.status(400).send(`<h1>No refresh token</h1><p>${json.error_description || JSON.stringify(json)}</p>`);
            }
          } catch (e) {
            res.status(500).send(`<h1>Error</h1><p>${data}</p>`);
          }
          resolveOuter();
        });
      }
    );
    req2.on('error', (err) => {
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
      resolveOuter();
    });
    req2.write(body);
    req2.end();
  });
});

/**
 * GET /auth/status - Check if OAuth has been completed
 */
app.get('/auth/status', (req, res) => {
  res.json({ connected: !!storedRefreshToken });
});

/**
 * GET /job/:id - Poll upload job status (requires API key if API_KEY env is set)
 */
app.get('/job/:id', requireApiKey, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found', jobId: req.params.id });
  }
  res.json(job);
});

/**
 * POST /upload - Initiate YouTube video upload
 *
 * Body:
 *   - videoUrl: URL to download the video from
 *   - uploadUrl: YouTube resumable upload URL (from setup node's json.headers.location)
 *   - oauthToken: YouTube OAuth 2.0 access token (use this OR clientId+clientSecret+refreshToken)
 *   - clientId, clientSecret, refreshToken: Alternative - we exchange for access token (no Code node needed)
 *   - videoMetadata: Optional snippet/status metadata (for logging)
 *   - contentLength: Optional - if known, avoids HEAD request
 *   - contentType: Optional - defaults to 'video/webm'
 *   - sync: Optional - if true, wait for upload to complete before responding
 */
app.post('/upload', requireApiKey, async (req, res) => {
  const {
    videoUrl,
    uploadUrl,
    oauthToken,
    clientId,
    clientSecret,
    refreshToken,
    videoMetadata,
    contentLength,
    contentType = 'video/webm',
    sync = false,
  } = req.body;

  if (!videoUrl) {
    return res.status(400).json({
      error: 'Missing required field: videoUrl',
      authOptions: 'If using stored OAuth (visit /auth/youtube first), also send videoMetadata. Otherwise provide uploadUrl.',
    });
  }

  // Resolve access token: 1) Authorization header, 2) body oauthToken, 3) refresh token in body, 4) stored token from /auth/youtube
  let accessToken = oauthToken;
  const authHeader = req.headers.authorization;
  if (!accessToken && authHeader && /^Bearer\s+/i.test(authHeader)) {
    accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  if (!accessToken && clientId && clientSecret && refreshToken) {
    try {
      accessToken = await getAccessTokenFromRefresh({ clientId, clientSecret, refreshToken });
    } catch (err) {
      return res.status(400).json({
        error: 'Failed to get access token from refresh token',
        message: err.message,
      });
    }
  }
  if (!accessToken && storedRefreshToken && YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET) {
    try {
      accessToken = await getAccessTokenFromRefresh({
        clientId: YOUTUBE_CLIENT_ID,
        clientSecret: YOUTUBE_CLIENT_SECRET,
        refreshToken: storedRefreshToken,
      });
    } catch (err) {
      return res.status(401).json({
        error: 'Stored token expired or invalid. Visit /auth/youtube again to reconnect.',
        message: err.message,
      });
    }
  }

  if (!accessToken) {
    return res.status(400).json({
      error: 'Missing auth',
      authOptions: 'Use Authorization: Bearer <token>, or body oauthToken, or (clientId + clientSecret + refreshToken)',
    });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const job = {
    id: jobId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    videoUrl,
    videoMetadata: videoMetadata || null,
    result: null,
    error: null,
  };

  jobs.set(jobId, job);

  // Resolve uploadUrl: provided or create via YouTube API (requires videoMetadata when creating)
  let resolvedUploadUrl = uploadUrl;
  if (!resolvedUploadUrl) {
    if (!videoMetadata || !videoMetadata.snippet) {
      return res.status(400).json({
        error: 'Missing uploadUrl and videoMetadata.snippet',
        hint: 'Either provide uploadUrl from your setup node, OR use stored OAuth (/auth/youtube) and provide videoMetadata with snippet (title, description, etc.)',
      });
    }
    let sizeForSession = contentLength;
    if (sizeForSession == null) {
      try {
        sizeForSession = await getContentLength(videoUrl);
      } catch (e) {
        return res.status(400).json({
          error: 'Could not get video size. Pass contentLength in body or ensure videoUrl returns Content-Length.',
          message: e.message,
        });
      }
    }
    try {
      resolvedUploadUrl = await createResumableSession(accessToken, videoMetadata, contentType, sizeForSession);
    } catch (err) {
      return res.status(400).json({
        error: 'Failed to create YouTube upload session',
        message: err.message,
      });
    }
  }

  const runUpload = async () => {
    job.status = 'downloading';

    try {
      // Resolve content length: use provided value, or fetch via HEAD
      let resolvedContentLength = contentLength;
      if (resolvedContentLength == null) {
        resolvedContentLength = await getContentLength(videoUrl);
      }

      job.status = 'uploading';

      const result = await streamVideoToYouTube({
        videoUrl,
        uploadUrl: resolvedUploadUrl,
        oauthToken: accessToken,
        contentType,
        contentLength: resolvedContentLength,
      });

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = result;
    } catch (err) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.error = {
        message: err.message,
        code: err.code,
      };
      console.error(`[${jobId}] Upload failed:`, err);
    }
  };

  if (sync) {
    // Synchronous mode: wait for upload, then respond
    runUpload()
      .then(() => {
        if (job.status === 'completed') {
          res.status(201).json(job);
        } else {
          res.status(500).json(job);
        }
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = { message: err.message };
        res.status(500).json(job);
      });
  } else {
    // Asynchronous mode: respond immediately with job ID
    res.status(202).json({
      jobId,
      status: 'accepted',
      message: 'Upload started. Poll GET /job/:id for status.',
      pollUrl: `/job/${jobId}`,
    });

    runUpload().catch((err) => {
      console.error(`[${jobId}] Background upload error:`, err);
    });
  }
});

/**
 * Create a YouTube resumable upload session. Returns the upload URL from Location header.
 */
async function createResumableSession(accessToken, videoMetadata, contentType, contentLength) {
  const body = JSON.stringify(videoMetadata);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Upload-Content-Type': contentType,
  };
  if (contentLength != null) {
    headers['X-Upload-Content-Length'] = String(contentLength);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const location = res.headers.location;
          if (location) {
            resolve(location);
          } else {
            reject(new Error(data || `HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Exchange a refresh token for an access token via Google OAuth2.
 * Use this when you can't get the access token from n8n (e.g. getCredentials fails).
 */
async function getAccessTokenFromRefresh({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              resolve(json.access_token);
            } else {
              reject(new Error(json.error_description || json.error || 'No access_token in response'));
            }
          } catch (e) {
            reject(new Error(`Token response parse error: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fetch Content-Length from source URL via HEAD request.
 * YouTube's resumable upload expects Content-Length for the PUT.
 */
async function getContentLength(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(url, { method: 'HEAD' }, (res) => {
      const len = res.headers['content-length'];
      if (len != null) {
        resolve(parseInt(len, 10));
      } else {
        reject(new Error('Source URL does not provide Content-Length. Pass contentLength in the request body.'));
      }
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('HEAD request timeout'));
    });
    req.end();
  });
}

/**
 * Stream video from source URL to YouTube resumable upload URL.
 * Uses Node.js streams to avoid loading the entire file into memory.
 */
async function streamVideoToYouTube({ videoUrl, uploadUrl, oauthToken, contentType, contentLength }) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await attemptStreamUpload({ videoUrl, uploadUrl, oauthToken, contentType, contentLength });
      return result;
    } catch (err) {
      lastError = err;
      const isRetryable = err.statusCode >= 500 || err.statusCode === 308 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.warn(`Upload attempt ${attempt} failed, retrying in ${delay}ms:`, err.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

/**
 * Single attempt: download from videoUrl and PUT to uploadUrl.
 */
async function attemptStreamUpload({ videoUrl, uploadUrl, oauthToken, contentType, contentLength }) {
  return new Promise((resolve, reject) => {
    const parsedSource = new URL(videoUrl);
    const httpModule = parsedSource.protocol === 'https:' ? https : http;

    // Initiate download stream
    const getReq = httpModule.get(videoUrl, (getRes) => {
      if (getRes.statusCode >= 400) {
        reject(new Error(`Failed to download video: HTTP ${getRes.statusCode}`));
        return;
      }

      const uploadOptions = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          'Content-Type': contentType,
          'Content-Length': contentLength,
        },
      };

      const uploadParsed = new URL(uploadUrl);
      const uploadModule = uploadParsed.protocol === 'https:' ? https : http;

      const putReq = uploadModule.request(uploadUrl, uploadOptions, (putRes) => {
        let body = '';
        putRes.on('data', (chunk) => { body += chunk; });
        putRes.on('end', () => {
          if (putRes.statusCode === 201 || putRes.statusCode === 200) {
            let videoId = null;
            try {
              const json = JSON.parse(body);
              videoId = json.id || null;
            } catch (_) {}

            resolve({
              statusCode: putRes.statusCode,
              videoId,
              rawResponse: body.length > 0 ? body : undefined,
            });
          } else if (putRes.statusCode === 308) {
            // Resume incomplete - for full-file upload we don't resume chunks, retry whole upload
            const err = new Error('Upload incomplete (308), will retry');
            err.statusCode = 308;
            reject(err);
          } else {
            const err = new Error(`YouTube upload failed: HTTP ${putRes.statusCode} - ${body}`);
            err.statusCode = putRes.statusCode;
            err.body = body;
            reject(err);
          }
        });
      });

      putReq.on('error', (err) => {
        reject(err);
      });

      // Pipe download stream directly to upload (no buffering)
      pipelineAsync(getRes, putReq).catch(reject);
    });

    getReq.on('error', (err) => {
      reject(err);
    });

    getReq.setTimeout(60000, () => {
      getReq.destroy(new Error('Download timeout'));
    });
  });
}

// Clean up old jobs periodically (keep last 100)
setInterval(() => {
  if (jobs.size > 100) {
    const entries = [...jobs.entries()].sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
    const toDelete = entries.slice(0, entries.length - 100);
    toDelete.forEach(([id]) => jobs.delete(id));
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`YouTube Upload API listening on port ${PORT}`);
  console.log(`Health: GET /health`);
  console.log(`Upload: POST /upload`);
  console.log(`Status: GET /job/:id`);
  if (YOUTUBE_CLIENT_ID) {
    console.log(`OAuth setup: GET ${BASE_URL}/auth/youtube (visit in browser once to connect)`);
  }
});
