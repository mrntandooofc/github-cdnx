const express = require('express');
const multer = require('multer');
const fs = require('fs');
const config = require('../config');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.set('json spaces', 2);
app.use(express.static(path.join(__dirname, '../public')));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced rate limiting for Ladybug
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15, // 15 uploads/reqs per ip per 5 mins
  message: { error: 'Too many upload attempts, please try again later', service: 'Ladybug CDN' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute for API endpoints
  message: { error: 'API rate limit exceeded', service: 'Ladybug CDN' }
});

const ytLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 YouTube downloads per 5 minutes
  message: { error: 'YouTube API rate limit exceeded', service: 'Ladybug CDN' }
});

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 AI requests per minute
  message: { error: 'AI API rate limit exceeded', service: 'Ladybug CDN' }
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // max 100 MBs upload
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
  ...parseMimeTypes(config.imageMimetypes || '[]'),
  ...parseMimeTypes(config.videoMimetypes || '[]'),
  ...parseMimeTypes(config.audioMimetypes || '[]'),
  ...parseMimeTypes(config.docMimetypes || '[]')
];

// Enhanced Folder Mapping for Ladybug
const FOLDER_MAP = {
  images: parseMimeTypes(config.imageMimetypes || '[]'),
  videos: parseMimeTypes(config.videoMimetypes || '[]'),
  audio: parseMimeTypes(config.audioMimetypes || '[]'),
  documents: parseMimeTypes(config.docMimetypes || '[]'),
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
  const idLength = length || Math.floor(Math.random() * 4) + 3;
  
  for (let i = 0; i < idLength; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters.charAt(randomIndex);
  }
  
  return result;
}

// Turnstile verification
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
        error: 'CAPTCHA verification failed',
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
    return res.status(400).json({ 
      error: 'No file uploaded',
      service: 'Ladybug CDN',
      code: 'NO_FILE'
    });
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ 
      error: 'File type not allowed',
      service: 'Ladybug CDN',
      code: 'INVALID_FILE_TYPE'
    });
  }

  next();
};

// Upload function
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

    const data = {
      message: `Uploaded via Ladybug CDN - ${fileName}`,
      content: fileContent,
      branch: config.repoBranch || 'main'
    };

    await axios.put(apiUrl, data, { headers });

    const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch || 'main'}/${filePath}`;
    res.json({ 
      success: true, 
      rawUrl: rawUrl,
      fileId: fileId,
      fileName: fileName,
      folder: folder,
      fileSize: file.size,
      mimeType: file.mimetype,
      service: 'Ladybug CDN',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - Error uploading file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      service: 'Ladybug CDN',
      code: 'UPLOAD_FAILED'
    });
  }
}

// ==================== YOUTUBE DOWNLOAD APIs ====================

// YouTube MP3 Download
app.post('/api/ladybug/ytmp3', ytLimiter, async (req, res) => {
  const { url, quality = 'highestaudio' } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'YouTube URL is required',
      service: 'Ladybug CDN',
      code: 'NO_URL'
    });
  }

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL',
        service: 'Ladybug CDN',
        code: 'INVALID_URL'
      });
    }

    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    // Get audio formats
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    
    if (audioFormats.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No audio formats available',
        service: 'Ladybug CDN',
        code: 'NO_AUDIO_FORMAT'
      });
    }

    const bestAudio = audioFormats[0];

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        title: videoDetails.title,
        author: videoDetails.author.name,
        duration: videoDetails.lengthSeconds,
        thumbnail: videoDetails.thumbnails[0]?.url,
        downloadUrl: bestAudio.url,
        quality: bestAudio.audioBitrate,
        format: 'mp3',
        fileSize: bestAudio.contentLength
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - YouTube MP3 Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process YouTube URL',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'YTMP3_ERROR'
    });
  }
});

// YouTube MP4 Download
app.post('/api/ladybug/ytmp4', ytLimiter, async (req, res) => {
  const { url, quality = 'highest' } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'YouTube URL is required',
      service: 'Ladybug CDN',
      code: 'NO_URL'
    });
  }

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL',
        service: 'Ladybug CDN',
        code: 'INVALID_URL'
      });
    }

    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    // Get video formats
    const videoFormats = ytdl.filterFormats(info.formats, 'videoandaudio');
    
    if (videoFormats.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No video formats available',
        service: 'Ladybug CDN',
        code: 'NO_VIDEO_FORMAT'
      });
    }

    const bestVideo = videoFormats[0];

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        title: videoDetails.title,
        author: videoDetails.author.name,
        duration: videoDetails.lengthSeconds,
        thumbnail: videoDetails.thumbnails[0]?.url,
        downloadUrl: bestVideo.url,
        quality: bestVideo.qualityLabel,
        format: 'mp4',
        fileSize: bestVideo.contentLength,
        resolution: `${bestVideo.width}x${bestVideo.height}`
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - YouTube MP4 Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process YouTube URL',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'YTMP4_ERROR'
    });
  }
});

// YouTube Video Info
app.get('/api/ladybug/ytinfo', ytLimiter, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'YouTube URL is required',
      service: 'Ladybug CDN',
      code: 'NO_URL'
    });
  }

  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL',
        service: 'Ladybug CDN',
        code: 'INVALID_URL'
      });
    }

    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        title: videoDetails.title,
        description: videoDetails.description,
        author: {
          name: videoDetails.author.name,
          channelUrl: videoDetails.author.channel_url,
          subscriberCount: videoDetails.author.subscriber_count
        },
        duration: videoDetails.lengthSeconds,
        viewCount: videoDetails.viewCount,
        publishDate: videoDetails.publishDate,
        thumbnails: videoDetails.thumbnails,
        keywords: videoDetails.keywords,
        category: videoDetails.category,
        isLiveContent: videoDetails.isLiveContent,
        formats: {
          videoFormats: ytdl.filterFormats(info.formats, 'videoandaudio').length,
          audioFormats: ytdl.filterFormats(info.formats, 'audioonly').length
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - YouTube Info Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get YouTube video info',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'YTINFO_ERROR'
    });
  }
});

// ==================== AI APIs ====================

// Text Generation AI
app.post('/api/ladybug/ai/text', aiLimiter, async (req, res) => {
  const { prompt, maxTokens = 150, temperature = 0.7 } = req.body;

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Prompt is required',
      service: 'Ladybug CDN',
      code: 'NO_PROMPT'
    });
  }

  try {
    // Mock AI response (replace with actual AI service)
    const responses = [
      "This is a sample AI-generated response based on your prompt.",
      "Here's an AI-generated text that responds to your input creatively.",
      "The AI has processed your request and generated this thoughtful response.",
      "Based on your prompt, here's what the AI model suggests.",
      "This is an intelligent response generated by Ladybug CDN's AI service."
    ];

    const randomResponse = responses[Math.floor(Math.random() * responses.length)];

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        prompt: prompt,
        response: `${randomResponse} Your prompt was: "${prompt}"`,
        tokens: maxTokens,
        temperature: temperature,
        model: 'ladybug-ai-v1'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - AI Text Error:', error);
    res.status(500).json({
      success: false,
      error: 'AI text generation failed',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'AI_TEXT_ERROR'
    });
  }
});

// Image Analysis AI
app.post('/api/ladybug/ai/image-analysis', aiLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Image file is required',
      service: 'Ladybug CDN',
      code: 'NO_IMAGE'
    });
  }

  try {
    // Mock image analysis (replace with actual AI service)
    const analysisResults = [
      "This image contains a beautiful landscape with mountains and trees.",
      "The image shows a person smiling in what appears to be an outdoor setting.",
      "This appears to be a close-up photo of an object with interesting textures.",
      "The image contains multiple elements including buildings and sky.",
      "This is a colorful image with various shapes and patterns."
    ];

    const randomAnalysis = analysisResults[Math.floor(Math.random() * analysisResults.length)];

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        analysis: randomAnalysis,
        confidence: Math.random() * 0.3 + 0.7, // Random confidence between 0.7-1.0
        tags: ['object', 'scene', 'color', 'composition'],
        model: 'ladybug-vision-v1'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - AI Image Analysis Error:', error);
    res.status(500).json({
      success: false,
      error: 'Image analysis failed',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'AI_IMAGE_ERROR'
    });
  }
});

// ==================== UTILITY APIs ====================

// QR Code Generator
app.post('/api/ladybug/qr-generate', apiLimiter, async (req, res) => {
  const { text, size = 200, format = 'png' } = req.body;

  if (!text) {
    return res.status(400).json({
      success: false,
      error: 'Text is required for QR code generation',
      service: 'Ladybug CDN',
      code: 'NO_TEXT'
    });
  }

  try {
    // Using QR Server API
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&format=${format}`;

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        text: text,
        qrCodeUrl: qrUrl,
        size: `${size}x${size}`,
        format: format
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - QR Generation Error:', error);
    res.status(500).json({
      success: false,
      error: 'QR code generation failed',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'QR_ERROR'
    });
  }
});

// URL Shortener
app.post('/api/ladybug/shorten-url', apiLimiter, async (req, res) => {
  const { url, customAlias } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'URL is required',
      service: 'Ladybug CDN',
      code: 'NO_URL'
    });
  }

  try {
    const shortId = customAlias || makeId(6);
    const shortUrl = `${req.protocol}://${req.get('host')}/s/${shortId}`;

    // In a real implementation, you'd store this in a database
    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        originalUrl: url,
        shortUrl: shortUrl,
        shortId: shortId,
        clicks: 0
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - URL Shortener Error:', error);
    res.status(500).json({
      success: false,
      error: 'URL shortening failed',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'SHORTEN_ERROR'
    });
  }
});

// Password Generator
app.get('/api/ladybug/generate-password', apiLimiter, (req, res) => {
  const { length = 12, includeSymbols = true, includeNumbers = true, includeUppercase = true, includeLowercase = true } = req.query;

  try {
    let charset = '';
    if (includeLowercase === 'true') charset += 'abcdefghijklmnopqrstuvwxyz';
    if (includeUppercase === 'true') charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (includeNumbers === 'true') charset += '0123456789';
    if (includeSymbols === 'true') charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    if (!charset) {
      return res.status(400).json({
        success: false,
        error: 'At least one character type must be included',
        service: 'Ladybug CDN',
        code: 'NO_CHARSET'
      });
    }

    let password = '';
    for (let i = 0; i < parseInt(length); i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    res.json({
      success: true,
      service: 'Ladybug CDN',
      data: {
        password: password,
        length: parseInt(length),
        strength: password.length >= 12 ? 'Strong' : password.length >= 8 ? 'Medium' : 'Weak',
        options: {
          includeSymbols: includeSymbols === 'true',
          includeNumbers: includeNumbers === 'true',
          includeUppercase: includeUppercase === 'true',
          includeLowercase: includeLowercase === 'true'
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Ladybug CDN - Password Generator Error:', error);
    res.status(500).json({
      success: false,
      error: 'Password generation failed',
      details: error.message,
      service: 'Ladybug CDN',
      code: 'PASSWORD_ERROR'
    });
  }
});

// ==================== ORIGINAL CDN ENDPOINTS ====================

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

// ==================== INFORMATION ENDPOINTS ====================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Ladybug CDN',
    version: '3.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Enhanced service info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    service: 'Ladybug CDN',
    description: 'Comprehensive API service with CDN, YouTube downloads, AI, and utility tools',
    version: '3.0.0',
    categories: {
      cdn: {
        description: 'File upload and management',
        endpoints: ['/ladybug/upload', '/api/ladybug/upload']
      },
      youtube: {
        description: 'YouTube video and audio downloads',
        endpoints: ['/api/ladybug/ytmp3', '/api/ladybug/ytmp4', '/api/ladybug/ytinfo']
      },
      ai: {
        description: 'Artificial Intelligence services',
        endpoints: ['/api/ladybug/ai/text', '/api/ladybug/ai/image-analysis']
      },
      utilities: {
        description: 'Useful utility tools',
        endpoints: ['/api/ladybug/qr-generate', '/api/ladybug/shorten-url', '/api/ladybug/generate-password']
      }
    },
    features: [
      'File upload and CDN',
      'YouTube MP3/MP4 downloads',
      'AI text generation',
      'AI image analysis',
      'QR code generation',
      'URL shortening',
      'Password generation',
      'Rate limiting',
      'CAPTCHA protection'
    ],
    maxFileSize: '100MB',
    supportedTypes: ['images', 'videos', 'audio', 'documents', 'archives', 'code']
  });
});

// API documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    service: 'Ladybug CDN API Documentation',
    version: '3.0.0',
    baseUrl: req.protocol + '://' + req.get('host'),
    categories: {
      'CDN Services': {
        'POST /ladybug/upload': {
          description: 'Upload a file with CAPTCHA verification',
          parameters: { file: 'File to upload', turnstileResponse: 'CAPTCHA token' }
        },
        'POST /api/ladybug/upload': {
          description: 'API upload without CAPTCHA',
          parameters: { file: 'File to upload', customId: 'Optional custom ID' }
        }
      },
      'YouTube Services': {
        'POST /api/ladybug/ytmp3': {
          description: 'Download YouTube video as MP3',
          parameters: { url: 'YouTube URL', quality: 'Audio quality (optional)' }
        },
        'POST /api/ladybug/ytmp4': {
          description: 'Download YouTube video as MP4',
          parameters: { url: 'YouTube URL', quality: 'Video quality (optional)' }
        },
        'GET /api/ladybug/ytinfo': {
          description: 'Get YouTube video information',
          parameters: { url: 'YouTube URL' }
        }
      },
      'AI Services': {
        'POST /api/ladybug/ai/text': {
          description: 'Generate text using AI',
          parameters: { prompt: 'Text prompt', maxTokens: 'Max tokens', temperature: 'Creativity level' }
        },
        'POST /api/ladybug/ai/image-analysis': {
          description: 'Analyze image content using AI',
          parameters: { image: 'Image file to analyze' }
        }
      },
      'Utility Services': {
        'POST /api/ladybug/qr-generate': {
          description: 'Generate QR code',
          parameters: { text: 'Text to encode', size: 'QR code size', format: 'Image format' }
        },
        'POST /api/ladybug/shorten-url': {
          description: 'Shorten a URL',
          parameters: { url: 'URL to shorten', customAlias: 'Custom alias (optional)' }
        },
        'GET /api/ladybug/generate-password': {
          description: 'Generate secure password',
          parameters: { length: 'Password length', includeSymbols: 'Include symbols', includeNumbers: 'Include numbers' }
        }
      }
    },
    rateLimits: {
      upload: '15 requests per 5 minutes',
      api: '30 requests per minute',
      youtube: '10 requests per 5 minutes',
      ai: '20 requests per minute'
    }
  });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(config.port || 3000, () => {
  console.log(`🐞 Ladybug CDN Server is running on port ${config.port || 3000}`);
  console.log(`Service: Ladybug CDN`);
  console.log(`Version: 3.0.0`);
  console.log(`Features: CDN, YouTube Downloads, AI Services, Utilities`);
  console.log(`API Documentation: http://localhost:${config.port || 3000}/api/docs`);
});
