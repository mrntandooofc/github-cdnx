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

// Enhanced rate limiting for Ladybug
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15, // 15 uploads/reqs per ip per 5 mins (increased for Ladybug)
  message: 'Too many upload attempts, please try again later - Ladybug CDN'
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute for API endpoints
  message: 'API rate limit exceeded - Ladybug CDN'
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // max 100 MBs upload (increased for Ladybug)
  }
});

function parseMimeTypes(mimeString) {
  try {
    return JSON.parse(mimeString.replace(/'/g, '"'));
  } catch (e) {
    console.error('Ladybug CDN - Error parsing MIME types:', e);
    return [];
  }
}

const ALLOWED_MIME_TYPES = [
  ...parseMimeTypes(config.imageMimetypes),
  ...parseMimeTypes(config.videoMimetypes),
  ...parseMimeTypes(config.audioMimetypes),
  ...parseMimeTypes(config.docMimetypes)
];

// Enhanced Folder Mapping for Ladybug
const FOLDER_MAP = {
  images: parseMimeTypes(config.imageMimetypes),
  videos: parseMimeTypes(config.videoMimetypes),
  audio: parseMimeTypes(config.audioMimetypes),
  documents: parseMimeTypes(config.docMimetypes),
  archives: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'],
  code: ['text/plain', 'application/json', 'text/javascript', 'text/css', 'text/html']
};

function getFolderForContentType(contentType) {
  if (!contentType) return 'files';
  contentType = contentType.toLowerCase();
  for (const [folder, types] of Object.entries(FOLDER_MAP)) {
    if (types.some(t => t.toLowerCase() === contentType)) {
      return folder;
    }
  }
  return 'documents';
}

function makeId(length = null) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const idLength = length || Math.floor(Math.random() * 4) + 3; // Random length between 3 and 6
  
  for (let i = 0; i < idLength; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  
  return result;
}

// Enhanced Turnstile verification for Ladybug
const verifyTurnstile = async (req, res, next) => {
  const { turnstileResponse } = req.body;

  if (!turnstileResponse) {
    return res.status(400).json({ 
      error: 'CAPTCHA Response is Required',
      service: 'Ladybug CDN',
      code: 'CAPTCHA_REQUIRED'
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
        error: 'CAPTCHA verification failed. Please reload page and try again.',
        service: 'Ladybug CDN',
        code: 'CAPTCHA_FAILED'
      });
    }

    next(); 
  } catch (error) {
    console.error('Ladybug CDN - Error verifying Turnstile response:', error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: error.message,
      service: 'Ladybug CDN',
      code: 'INTERNAL_ERROR'
    });
  }
};

const validateFile = (req, res, next) => {
  if (!req.file) {
    console.warn('Ladybug CDN - No file uploaded');
    return res.status(400).json({ 
      error: 'No file uploaded',
      service: 'Ladybug CDN',
      code: 'NO_FILE'
    });
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    console.warn(`Ladybug CDN - File type not allowed: ${req.file.mimetype}`);
    return res.status(400).json({ 
      error: 'File type not allowed',
      service: 'Ladybug CDN',
      code: 'INVALID_FILE_TYPE',
      allowedTypes: ALLOWED_MIME_TYPES
    });
  }

  next();
};

// Enhanced upload function for Ladybug
async function uploadToGitHub(file, folder, res, includeTurnstile = true, customId = null) {
  const fileId = customId || makeId();
  const originalFileName = `${fileId}_${file.originalname}`;
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
      'User-Agent': 'Ladybug-CDN-Upload-Service'
    };

    // Check if file already exists
    try {
      const existingFileResponse = await axios.get(apiUrl, { headers });
      if (existingFileResponse.data) {
        const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${filePath}`;
        return res.json({ 
          success: true, 
          rawUrl: rawUrl,
          fileId: fileId,
          fileName: fileName,
          folder: folder,
          message: 'File already exists, returning existing URL',
          service: 'Ladybug CDN',
          uploadedBy: 'Ladybug CDN Service',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      if (error.response && error.response.status !== 404) {
        throw error;
      }
    }

    const data = {
      message: `${config.commitMessage} - Uploaded via Ladybug CDN`,
      content: fileContent,
      branch: config.repoBranch
    };

    await axios.put(apiUrl, data, { headers });

    const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${filePath}`;
    res.json({ 
      success: true, 
      rawUrl: rawUrl,
      fileId: fileId,
      fileName: fileName,
      folder: folder,
      fileSize: file.size,
      mimeType: file.mimetype,
      service: 'Ladybug CDN',
      uploadedBy: 'Ladybug CDN Service',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - Error uploading file to GitHub:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ladybug CDN',
      code: 'UPLOAD_FAILED'
    });
  }
}

// LADYBUG CDN MAIN ENDPOINTS

// Primary Ladybug upload endpoint
app.post('/ladybug/upload', uploadLimiter, upload.single('file'), verifyTurnstile, validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, true);
});

// Ladybug API upload (no CAPTCHA required)
app.post('/api/ladybug/upload', apiLimiter, upload.single('file'), validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  const customId = req.body.customId || null;
  await uploadToGitHub(req.file, folder, res, false, customId);
});

// Ladybug batch upload
app.post('/api/ladybug/batch-upload', apiLimiter, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No files uploaded',
      service: 'Ladybug CDN',
      code: 'NO_FILES'
    });
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      errors.push({
        fileName: file.originalname,
        error: 'File type not allowed',
        mimeType: file.mimetype
      });
      continue;
    }

    try {
      const folder = getFolderForContentType(file.mimetype);
      const fileId = makeId();
      const fileName = `${fileId}_${file.originalname}`.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-._]/g, '');
      const filePath = `${folder}/${fileName}`;
      const fileContent = file.buffer.toString('base64');

      const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${filePath}`;
      const headers = {
        'Authorization': `token ${config.githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Ladybug-CDN-Batch-Upload'
      };

      const data = {
        message: `Batch upload via Ladybug CDN - ${fileName}`,
        content: fileContent,
        branch: config.repoBranch
      };

      await axios.put(apiUrl, data, { headers });

      const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${filePath}`;
      
      results.push({
        success: true,
        originalName: file.originalname,
        fileName: fileName,
        fileId: fileId,
        rawUrl: rawUrl,
        folder: folder,
        fileSize: file.size,
        mimeType: file.mimetype
      });

    } catch (error) {
      errors.push({
        fileName: file.originalname,
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    service: 'Ladybug CDN',
    totalFiles: req.files.length,
    successfulUploads: results.length,
    failedUploads: errors.length,
    results: results,
    errors: errors,
    timestamp: new Date().toISOString()
  });
});

// Ladybug file info endpoint
app.get('/api/ladybug/file/:fileId', apiLimiter, async (req, res) => {
  const { fileId } = req.params;
  
  try {
    // Search for file across all folders
    const folders = Object.keys(FOLDER_MAP);
    let fileFound = null;
    
    for (const folder of folders) {
      try {
        const searchUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${folder}`;
        const headers = {
          'Authorization': `token ${config.githubToken}`,
          'User-Agent': 'Ladybug-CDN-Search'
        };
        
        const response = await axios.get(searchUrl, { headers });
        const files = response.data;
        
        const matchingFile = files.find(file => file.name.startsWith(fileId));
        if (matchingFile) {
          fileFound = {
            fileId: fileId,
            fileName: matchingFile.name,
            folder: folder,
            size: matchingFile.size,
            downloadUrl: matchingFile.download_url,
            rawUrl: `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${folder}/${matchingFile.name}`,
            lastModified: matchingFile.sha
          };
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!fileFound) {
      return res.status(404).json({
        success: false,
        error: 'File not found',
        service: 'Ladybug CDN',
        code: 'FILE_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      service: 'Ladybug CDN',
      file: fileFound,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Ladybug CDN - Error searching for file:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      service: 'Ladybug CDN',
      code: 'SEARCH_ERROR'
    });
  }
});

// Ladybug delete endpoint
app.delete('/api/ladybug/delete', apiLimiter, async (req, res) => {
  const { filename, fileId } = req.body;
  
  if (!filename && !fileId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Filename or fileId is required',
      service: 'Ladybug CDN',
      code: 'MISSING_IDENTIFIER'
    });
  }

  try {
    let targetFile = filename;
    
    // If fileId is provided, search for the file
    if (fileId && !filename) {
      const folders = Object.keys(FOLDER_MAP);
      let found = false;
      
      for (const folder of folders) {
        try {
          const searchUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${folder}`;
          const headers = {
            'Authorization': `token ${config.githubToken}`,
            'User-Agent': 'Ladybug-CDN-Delete'
          };
          
          const response = await axios.get(searchUrl, { headers });
          const files = response.data;
          
          const matchingFile = files.find(file => file.name.startsWith(fileId));
          if (matchingFile) {
            targetFile = `${folder}/${matchingFile.name}`;
            found = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!found) {
        return res.status(404).json({
          success: false,
          error: 'File not found',
          service: 'Ladybug CDN',
          code: 'FILE_NOT_FOUND'
        });
      }
    }

    const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${targetFile}`;
    const headers = {
      'Authorization': `token ${config.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Ladybug-CDN-Delete-Service'
    };

    const existingFile = await axios.get(apiUrl, { headers });
    const sha = existingFile.data.sha;

    const data = {
      message: `Deleted via Ladybug CDN: ${targetFile}`,
      sha: sha,
      branch: config.repoBranch
    };

    await axios.delete(apiUrl, { 
      headers: headers,
      data: data
    });

    res.json({ 
      success: true,
      message: `File ${targetFile} deleted successfully`,
      service: 'Ladybug CDN',
      deletedBy: 'Ladybug CDN Service',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - Error deleting file:', error);
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found',
        service: 'Ladybug CDN',
        code: 'FILE_NOT_FOUND'
      });
    }
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ladybug CDN',
      code: 'DELETE_FAILED'
    });
  }
});

// Ladybug list files endpoint
app.get('/api/ladybug/files', apiLimiter, async (req, res) => {
  const { folder, limit = 50, page = 1 } = req.query;
  
  try {
    const folders = folder ? [folder] : Object.keys(FOLDER_MAP);
    const allFiles = [];
    
    for (const folderName of folders) {
      try {
        const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${folderName}`;
        const headers = {
          'Authorization': `token ${config.githubToken}`,
          'User-Agent': 'Ladybug-CDN-List'
        };
        
        const response = await axios.get(apiUrl, { headers });
        const files = response.data.map(file => ({
          fileId: file.name.split('_')[0],
          fileName: file.name,
          folder: folderName,
          size: file.size,
          rawUrl: `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${folderName}/${file.name}`,
          downloadUrl: file.download_url
        }));
        
        allFiles.push(...files);
      } catch (error) {
        continue;
      }
    }
    
    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedFiles = allFiles.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      service: 'Ladybug CDN',
      totalFiles: allFiles.length,
      currentPage: parseInt(page),
      totalPages: Math.ceil(allFiles.length / limit),
      files: paginatedFiles,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Ladybug CDN - Error listing files:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list files',
      service: 'Ladybug CDN',
      code: 'LIST_ERROR'
    });
  }
});

// LEGACY ENDPOINTS (for backward compatibility)
app.post('/ntandoUpload.php', uploadLimiter, upload.single('file'), verifyTurnstile, validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, true);
});

app.post('/giftedUpload.php', uploadLimiter, upload.single('file'), verifyTurnstile, validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, true);
});

app.post('/api/upload.php', uploadLimiter, upload.single('file'), validateFile, async (req, res) => {
  const folder = getFolderForContentType(req.file.mimetype);
  await uploadToGitHub(req.file, folder, res, false);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Ladybug CDN',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Enhanced service info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    service: 'Ladybug CDN',
    description: 'Fast, reliable, and feature-rich CDN service powered by GitHub',
    version: '2.0.0',
    endpoints: {
      upload: '/ladybug/upload',
      apiUpload: '/api/ladybug/upload',
      batchUpload: '/api/ladybug/batch-upload',
      delete: '/api/ladybug/delete',
      fileInfo: '/api/ladybug/file/:fileId',
      listFiles: '/api/ladybug/files',
      health: '/health'
    },
    features: [
      'Single file upload',
      'Batch file upload',
      'File search by ID',
      'File listing with pagination',
      'Enhanced error handling',
      'Rate limiting',
      'CAPTCHA protection'
    ],
    maxFileSize: '100MB',
    maxBatchFiles: 10,
    supportedTypes: ['images', 'videos', 'audio', 'documents', 'archives', 'code'],
    folders: Object.keys(FOLDER_MAP)
  });
});

// API documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    service: 'Ladybug CDN API Documentation',
    version: '2.0.0',
    baseUrl: req.protocol + '://' + req.get('host'),
    endpoints: {
      'POST /ladybug/upload': {
        description: 'Upload a single file with CAPTCHA verification',
        parameters: {
          file: 'File to upload (multipart/form-data)',
          turnstileResponse: 'CAPTCHA response token'
        },
        response: 'Upload result with file URL and metadata'
      },
      'POST /api/ladybug/upload': {
        description: 'API upload without CAPTCHA (for integrations)',
        parameters: {
          file: 'File to upload (multipart/form-data)',
          customId: 'Optional custom file ID'
        },
        response: 'Upload result with file URL and metadata'
      },
      'POST /api/ladybug/batch-upload': {
        description: 'Upload multiple files at once',
        parameters: {
          files: 'Array of files (max 10 files)'
        },
        response: 'Batch upload results'
      },
      'GET /api/ladybug/file/:fileId': {
        description: 'Get file information by ID',
        parameters: {
          fileId: 'File identifier'
        },
        response: 'File metadata and URLs'
      },
      'GET /api/ladybug/files': {
        description: 'List files with pagination',
        parameters: {
          folder: 'Optional folder filter',
          limit: 'Files per page (default: 50)',
          page: 'Page number (default: 1)'
        },
        response: 'Paginated file list'
      },
      'DELETE /api/ladybug/delete': {
        description: 'Delete a file',
        parameters: {
          filename: 'Full file path OR',
          fileId: 'File identifier'
        },
        response: 'Deletion confirmation'
      }
    },
    rateLimits: {
      upload: '15 requests per 5 minutes',
      api: '30 requests per minute'
    }
  });
});

app.listen(config.port, () => {
  console.log(`🐞 Ladybug CDN Server is running on port ${config.port}`);
  console.log(`Service: Ladybug CDN`);
  console.log(`Version: 2.0.0`);
  console.log(`Features: Enhanced upload, batch processing, file management`);
});
