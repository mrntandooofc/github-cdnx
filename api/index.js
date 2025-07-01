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
  message: 'Too many upload attempts, please try again later'
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // max 50 MBs upload
  }
});

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
        return res.status(400).json({ error: 'CAPTCHA Response is Required' });
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
            return res.status(400).json({ error: 'CAPTCHA Already Used! Please Reload Page to Continue.' });
        }

        next(); 
    } catch (error) {
        console.error('Error verifying Turnstile response:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
};

app.post('/giftedUpload.php', uploadLimiter, upload.single('file'), verifyTurnstile, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const fileName = `${makeId()}${req.file.originalname}`;
    const fileContent = req.file.buffer.toString('base64');

    try {
        const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${fileName}`; 
        const headers = {
            'Authorization': `token ${config.githubToken}`,
            'Content-Type': 'application/json'
        };

        try {
            const existingFileResponse = await axios.get(apiUrl, { headers });
            if (existingFileResponse.data) {
                const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${fileName}`;
                return res.json({ 
                    success: true, 
                    rawUrl: rawUrl,
                    message: 'File already exists, returning existing URL'
                });
            }
        } catch (error) {
            if (error.response && error.response.status !== 404) {
                throw error;
            }
        }

        const data = {
            message: config.commitMessage,
            content: fileContent,
            branch: config.repoBranch
        };

        await axios.put(apiUrl, data, { headers });

        const rawUrl = `${config.cdnApiUrl}/${config.githubUser}/${config.githubRepo}@${config.repoBranch}/${fileName}`;
        res.json({ 
            success: true, 
            rawUrl: rawUrl 
        });

    } catch (error) {
        console.error('Error uploading file to GitHub:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/giftedDelete.php', verifyTurnstile, async (req, res) => {
    const { filename } = req.body;

    if (!filename) {
        return res.status(400).json({ success: false, error: 'Filename is required' });
    }

    try {
        const apiUrl = `${config.githubApiUrl}/repos/${config.githubUser}/${config.githubRepo}/contents/${filename}`;
        const headers = {
            'Authorization': `token ${config.githubToken}`,
            'Content-Type': 'application/json'
        };

        const existingFile = await axios.get(apiUrl, { headers });
        const sha = existingFile.data.sha;

        const data = {
            message: `Deleted: ${filename}`,
            sha: sha,
            branch: config.repoBranch
        };

        await axios.delete(apiUrl, { 
            headers: headers,
            data: data
        });

        res.json({ 
            success: true,
            message: `File ${filename} deleted successfully`
        });

    } catch (error) {
        console.error('Error deleting file:', error);
        if (error.response && error.response.status === 404) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
});
