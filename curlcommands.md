# cURL Commands for YouTube Upload API

Base URL: `https://youtube-upload-api-production.up.railway.app`

**API Key:** If you set `API_KEY` in Railway env, add this header to all upload and job requests.

**Presigned URLs:** S3-style presigned URLs (e.g. storageapi.dev, DigitalOcean Spaces) are supported. The API follows redirects and handles sources that don't return Content-Length on HEAD.
```
X-API-Key: your-api-key
```

---

## Health Check (no API key needed)

```bash
curl https://youtube-upload-api-production.up.railway.app/health
```

---

## Auth Status (check if YouTube is connected)

```bash
curl https://youtube-upload-api-production.up.railway.app/auth/status
```

---

## Upload Video (with stored OAuth – no tokens needed)

### Option A: You already have `uploadUrl` from a previous node (Location header)

Use this when your workflow already creates the resumable session and returns the upload URL. You only need to pass `uploadUrl` and `videoUrl`.

```bash
curl -X POST https://youtube-upload-api-production.up.railway.app/upload \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "videoUrl": "https://example.com/your-video.webm",
    "uploadUrl": "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xxx",
    "contentType": "video/webm",
    "sync": false
  }'
```

### Option B: Let the API create the session (pass metadata)

Use this when you want the API to create the resumable session. Pass `videoUrl` and `videoMetadata`.

```bash
curl -X POST https://youtube-upload-api-production.up.railway.app/upload \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "videoUrl": "https://example.com/your-video.webm",
    "videoMetadata": {
      "snippet": {
        "title": "My Video Title",
        "description": "Video description here",
        "tags": ["tag1", "tag2"],
        "categoryId": "10",
        "defaultLanguage": "en",
        "defaultAudioLanguage": "en"
      },
      "status": {
        "privacyStatus": "public",
        "license": "youtube",
        "embeddable": true,
        "publicStatsViewable": true,
        "madeForKids": false
      }
    },
    "contentType": "video/webm",
    "sync": false
  }'
```

---

## Poll Job Status (after async upload)

Replace `JOB_ID` with the `jobId` from the upload response:

```bash
curl -H "X-API-Key: YOUR_API_KEY" https://youtube-upload-api-production.up.railway.app/job/JOB_ID
```

Example:

```bash
curl -H "X-API-Key: YOUR_API_KEY" https://youtube-upload-api-production.up.railway.app/job/job_1709123456789_abc123
```

---

## n8n HTTP Request Node Setup

| Field | Value |
|-------|-------|
| **Method** | POST |
| **URL** | `https://youtube-upload-api-production.up.railway.app/upload` |
| **Headers** | `X-API-Key: your-api-key` (if `API_KEY` is set in Railway) |
| **Body Content Type** | JSON |
| **Body** | See below |

---

### Adding the API key in n8n

In the HTTP Request node, add a header:
- **Name:** `X-API-Key`
- **Value:** your API key (or `{{ $env.API_KEY }}` if stored in n8n variables)

---

### When your previous node already returns `uploadUrl` (Location header)

You created the resumable session in a prior node. Pass the Location header as `uploadUrl` and your video URL:

```json
{
  "videoUrl": "{{ $json.videoUrl }}",
  "uploadUrl": "{{ $json.headers.location }}",
  "contentType": "video/webm",
  "sync": false
}
```

If the Location is in a different node’s output:

```json
{
  "videoUrl": "{{ $json.videoUrl }}",
  "uploadUrl": "{{ $('Your Setup Node').item.json.headers.location }}",
  "contentType": "video/webm",
  "sync": false
}
```

---

### When the API creates the session (pass metadata)

Use this if you are not creating the resumable session elsewhere. Includes your full snippet/status shape:

```json
{
  "videoUrl": "{{ $json.videoUrl }}",
  "videoMetadata": {
    "snippet": {
      "title": "{{ $('Lyrics Generation Agent').item.json.output.title }}",
      "description": "{{ $json.description }}",
      "tags": "{{ $('Lyrics Generation Agent').item.json.output.tags }}",
      "categoryId": "10",
      "defaultLanguage": "en",
      "defaultAudioLanguage": "en"
    },
    "status": {
      "privacyStatus": "public",
      "license": "youtube",
      "embeddable": true,
      "publicStatsViewable": true,
      "madeForKids": false
    }
  },
  "contentType": "video/webm",
  "sync": false
}
```

Use `sync: true` only for small files.
