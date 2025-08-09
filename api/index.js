const express = require('express');
const multer = require('multer');
const fs = require('fs');
const config = require('../config');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.set('json spaces', 2);
app.use(express.static(path.join(__dirname, '../public')));

const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 uploads/reqs per ip per 5 mins
  message: 'Too many upload attempts, please try again later - Ntandocdn'
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // max 50 MBs upload
  }
});

function parseMimeTypes(mimeString) {
  try {
    return JSON.parse(mimeString.replace(/'/g, '"'));
  } catch (e) {
    console.error('Ntandocdn - Error parsing MIME types:', e);
    return [];
  }
}

const ALLOWED_MIME_TYPES = [
  ...parseMimeTypes(config.imageMimetypes),
  ...parseMimeTypes(config.videoMimetypes),
  ...parseMimeTypes(config.audioMimetypes),
  ...parseMimeTypes(config.docMimetypes)
];

// Folder Mapping
const FOLDER_MAP = {
  image: parseMimeTypes(config.imageMimetypes),
  video: parseMimeTypes(config.videoMimetypes),
  audio: parseMimeTypes(config.audioMimetypes),
  docs: parseMimeTypes(config.docMimetypes)
};

function getFolderForContentType(contentType) {
  if (!contentType) return 'files';
  contentType = contentType.toLowerCase();
  for (const [folder, types] of Object.entries(FOLDER_MAP)) {
    if (types.some(t => t.toLowerCase() === contentType)) {
      return folder;
    }
  }
  return 'docs';
}

function makeId() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const length = Math.floor(Math.random() * 4) + 2; // Random length between 2 and 4
  
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  
  return result;
}

const verifyTurnstile = async (req, res, next) => {
  const { turnstileResponse } = req.body;

  if (!turnstileResponse) {
    return res.status(400).json({ 
      error: 'CAPTCHA Response is Required',
      service: 'Ntandocdn'
    });
  }

  try {
    const response = await axios.post(
      `${config.cfTurnstileApiUrl}/turnstile/v0/siteverify`,
      new URLSearchParams({
        secret: config.cfSecretKey,
        response: turnstileResponse,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (!response.data.success) {
      return res.status(400).json({ 
        error: 'CAPTCHA Already Used! Please Reload Page to Continue.',
        service: 'Ntandocdn'
      });
    }

    next(); 
  } catch (error) {
    console.error('Ntandocdn - Error verifying Turnstile response:', error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: error.message,
      service: 'Ntandocdn'
    });
  }
};

const validateFile = (req, res, next) => {
  if (!req.file) {
    console.warn('Ntandocdn - No file uploaded');
    return res.status(400).json({ 
      error: 'No file uploaded',
      service: 'Ntandocdn'
    });
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    console.warn(`Ntandocdn - File type not allowed: ${req.file.mimetype}`);
    return res.status(400).json({ 
      error: 'File type not allowed',
      service: 'Ntandocdn'
    });
  }

  next();
};

async function uploadToGitHub(file, folder, res, includeTurnstile = true) {
  const originalFileName = `${makeId()}_${file.originalname}`;
  const fileName = originalFileName
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-._]/g, '');
  const filePath = `${folder}/${fileName}`;
  const fileContent = file.buffer.toString('base64');

  try {
    const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${filePath}`;
    const headers = {
      'Authorization': `token ${config.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ntandocdn-Upload-Service'
    };

    try {
      const existingFileResponse = await axios.get(apiUrl, { headers });
      if (existingFileResponse.data) {
        const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${filePath}`;
        return res.json({ 
          success: true, 
          rawUrl: rawUrl,
          message: 'File already exists, returning existing URL',
          service: 'Ntandocdn',
          uploadedBy: 'Ntandocdn CDN Service'
        });
      }
    } catch (error) {
      if (error.response && error.response.status !== 404) {
        throw error;
      }
    }

    const data = {
      message: `${config.commitMessage} - Uploaded via Ntandocdn`,
      content: fileContent,
      branch: config.repoBranch
    };

    await axios.put(apiUrl, data, { headers });

    const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${filePath}`;
    res.json({ 
      success: true, 
      rawUrl: rawUrl,
      service: 'Ntandocdn',
      uploadedBy: 'Ntandocdn CDN Service',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ntandocdn - Error uploading file to GitHub:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ntandocdn'
    });
  }
}

// Main upload endpoint with Turnstile verification
app.post('/ntandoUpload.php', uploadLimiter, upload.single('file'), verifyTurnstile, validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, true);
});

// Legacy endpoint for backward compatibility
app.post('/giftedUpload.php', uploadLimiter, upload.single('file'), verifyTurnstile, validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, true);
});

// API ENDPOINT FOR EXTERNAL INTEGRATION
app.post('/api/upload.php', uploadLimiter, upload.single('file'), validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, false);
});

// Ntandocdn API endpoint
app.post('/api/ntando/upload', uploadLimiter, upload.single('file'), validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, false);
});

// Delete endpoint with Ntandocdn branding
app.delete('/ntandoDelete.php', verifyTurnstile, async (req, res) => {
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).json({ 
      success: false, 
      error: 'Filename is required',
      service: 'Ntandocdn'
    });
  }

  try {
    const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${filename}`;
    const headers = {
      'Authorization': `token ${config.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ntandocdn-Delete-Service'
    };

    const existingFile = await axios.get(apiUrl, { headers });
    const sha = existingFile.data.sha;

    const data = {
      message: `Deleted via Ntandocdn: ${filename}`,
      sha: sha,
      branch: config.repoBranch
    };

    await axios.delete(apiUrl, { 
      headers: headers,
      data: data
    });

    res.json({ 
      success: true,
      message: `File ${filename} deleted successfully`,
      service: 'Ntandocdn',
      deletedBy: 'Ntandocdn CDN Service',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ntandocdn - Error deleting file:', error);
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found',
        service: 'Ntandocdn'
      });
    }
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ntandocdn'
    });
  }
});

// Legacy delete endpoint for backward compatibility
app.delete('/giftedDelete.php', verifyTurnstile, async (req, res) => {
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).json({ 
      success: false, 
      error: 'Filename is required',
      service: 'Ntandocdn'
    });
  }

  try {
    const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${filename}`;
    const headers = {
      'Authorization': `token ${config.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ntandocdn-Delete-Service'
    };

    const existingFile = await axios.get(apiUrl, { headers });
    const sha = existingFile.data.sha;

    const data = {
      message: `Deleted via Ntandocdn: ${filename}`,
      sha: sha,
      branch: config.repoBranch
    };

    await axios.delete(apiUrl, { 
      headers: headers,
      data: data
    });

    res.json({ 
      success: true,
      message: `File ${filename} deleted successfully`,
      service: 'Ntandocdn'
    });

  } catch (error) {
    console.error('Ntandocdn - Error deleting file:', error);
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found',
        service: 'Ntandocdn'
      });
    }
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ntandocdn'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Ntandocdn',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Service info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    service: 'Ntandocdn',
    description: 'Fast and reliable CDN service powered by GitHub',
    version: '1.0.0',
    endpoints: {
      upload: '/ntandoUpload.php',
      delete: '/ntandoDelete.php',
      api_upload: '/api/ntando/upload',
      health: '/health'
    },
    maxFileSize: '50MB',
    supportedTypes: ['images', 'videos', 'audio', 'documents']
  });
});

app.listen(config.port, () => {
  console.log(`Ntandocdn Server is running on port ${config.port}`);
  console.log(`Service: Ntandocdn CDN`);
  console.log(`Version: 1.0.0`);
});
