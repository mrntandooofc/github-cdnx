require('dotenv').config();

module.exports = {
  port: process.env.PORT || '5000',
  repoBranch: process.env.REPO_BRANCH || 'main', // Replace or not
  githubRepo: process.env.GITHUB_REPO || 'ghb-cdn', // Your storage repo name
  commitMessage: process.env.COMMIT_MESSAGE || 'Gifted', // Your commit Message
  githubUser: process.env.GITHUB_USERNAME || 'mauricegift', // Yout github username
  githubApiUrl: process.env.GITHUB_API_URL || 'https://api.github.com', // Maintain this
  cdnApiUrl: process.env.CDN_API_URL || 'https://cdn.jsdelivr.net/gh', // Maintain this
  cfTurnstileApiUrl: process.env.CF_TURNSTILE_API_URL || "https://challenges.cloudflare.com", // Mintain this
  cfSecretKey: process.env.CF_TURNSTILE_SECRET_KEY || '', // Use yours
  githubToken: process.env.GITHUB_TOKEN || '', // Your Github Token Here
};
