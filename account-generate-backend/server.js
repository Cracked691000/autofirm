// local-server.js - OPTIMIZED Backend with 2-3x Speed Improvement
// Install: npm install express puppeteer puppeteer-extra puppeteer-extra-plugin-stealth axios cors ws

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const cors = require('cors');
const WebSocket = require('ws');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const os = require('os');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/build')));

const PORT = 3001;
const INSTANCE_ID = process.env.INSTANCE_ID || `worker-${os.hostname()}-${PORT}`;

// ============================================
// GLOBAL STATE & OPTIMIZATIONS
// ============================================

const captchaResolvers = new Map();
const skipCaptchaFlags = new Map();

// CAPTCHA QUEUE (replaces mutex for better performance)
const captchaQueue = [];
let activeCaptchaThreadId = null;

const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

let browserInstance = null;
let browserUseCount = 0;
const MAX_BROWSER_USES = 15;
const MAX_THREADS = 6;

// EMAIL QUEUE (pre-generate emails for faster processing)
const emailQueue = [];
const EMAIL_QUEUE_SIZE = 10;

// ============================================
// RANDOM USER AGENTS
// ============================================
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15"
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ============================================
// CAPTCHA GRID COORDINATES
// ============================================
const gridCoordinates = {
  1: { x: 60, y: 190 }, 
  2: { x: 180, y: 190 }, 
  3: { x: 300, y: 190 },
  4: { x: 60, y: 290 }, 
  5: { x: 180, y: 290 }, 
  6: { x: 300, y: 290 }
};

// ============================================
// GEMINI AI CONFIGURATION
// ============================================
let genAI = null;
let geminiModel = null;
let useAiSolver = false;
let geminiApiKey = null;

function initializeGemini(apiKey) {
  try {
    genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    geminiApiKey = apiKey;
    useAiSolver = true;
    console.log('[Gemini] AI solver initialized');
    return true;
  } catch (error) {
    console.error('[Gemini] Initialization failed:', error.message);
    return false;
  }
}

async function solveWithGemini(base64Image, threadId) {
  if (!geminiModel || !useAiSolver) return null;
  
  try {
    console.log(`[Thread ${threadId}] Attempting AI solve...`);
    
    const prompt = `You are a captcha solver. Look at this image carefully. It shows a grid of 6 images (2 rows, 3 columns, numbered 1-6 from left to right, top to bottom).

There is a reference/target image at the top, and you need to identify which position (1-6) in the grid matches or is most similar to the reference image.

Analyze the images and respond with ONLY a single number from 1 to 6 indicating which grid position matches the reference image. Do not include any explanation, just the number.`;

    const result = await geminiModel.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: "image/png",
          data: base64Image
        }
      }
    ]);
    
    const response = await result.response;
    const text = response.text().trim();
    const position = parseInt(text);
    
    if (position >= 1 && position <= 6) {
      console.log(`[Thread ${threadId}] AI selected position: ${position}`);
      return position;
    }
    
    console.log(`[Thread ${threadId}] AI returned invalid position: ${text}`);
    return null;
    
  } catch (error) {
    console.error(`[Thread ${threadId}] AI solve error:`, error.message);
    return null;
  }
}

// ============================================
// BROWSER CONTEXT POOL
// ============================================
class BrowserContextPool {
  constructor(maxSize = 6) {
    this.pool = [];
    this.maxSize = maxSize;
    this.inUse = new Set();
  }

  async getContext(browser) {
    if (this.pool.length > 0) {
      const context = this.pool.pop();
      this.inUse.add(context);
      return context;
    }
    
    try {
      const context = await browser.createBrowserContext();
      this.inUse.add(context);
      return context;
    } catch (e) {
      console.error('[Pool] Context creation failed:', e.message);
      return null;
    }
  }

  async releaseContext(context) {
    this.inUse.delete(context);
    
    if (this.pool.length < this.maxSize) {
      try {
        const pages = await context.pages();
        await Promise.all(pages.map(page => clearPageSession(page).catch(() => {})));
        this.pool.push(context);
      } catch (e) {
        context.close().catch(() => {});
      }
    } else {
      context.close().catch(() => {});
    }
  }

  async cleanup() {
    const allContexts = [...this.pool, ...Array.from(this.inUse)];
    await Promise.all(allContexts.map(ctx => ctx.close().catch(() => {})));
    this.pool = [];
    this.inUse.clear();
  }
}

const contextPool = new BrowserContextPool(6);

// ============================================
// CAPTCHA QUEUE SYSTEM
// ============================================
async function waitForCaptchaTurn(threadId) {
  return new Promise((resolve) => {
    captchaQueue.push({ threadId, resolve });
    processCaptchaQueue();
  });
}

function processCaptchaQueue() {
  if (activeCaptchaThreadId === null && captchaQueue.length > 0) {
    const next = captchaQueue.shift();
    activeCaptchaThreadId = next.threadId;
    console.log(`[Captcha Queue] Thread ${next.threadId} acquired lock (${captchaQueue.length} waiting)`);
    next.resolve();
  }
}

function releaseCaptchaLock(threadId) {
  if (activeCaptchaThreadId === threadId) {
    activeCaptchaThreadId = null;
    skipCaptchaFlags.delete(threadId);
    console.log(`[Captcha Queue] Thread ${threadId} released lock`);
    processCaptchaQueue();
  }
}

// ============================================
// EMAIL QUEUE SYSTEM
// ============================================
async function maintainEmailQueue() {
  while (emailQueue.length < EMAIL_QUEUE_SIZE) {
    const emailPromise = generateEmailInternal('queue').catch(() => null);
    emailQueue.push(emailPromise);
  }
}

async function getEmailFromQueue(threadId) {
  // Start refilling in background
  maintainEmailQueue().catch(() => {});
  
  const emailPromise = emailQueue.shift() || generateEmailInternal(threadId);
  return await emailPromise;
}

// ============================================
// WEBSOCKET SETUP
// ============================================

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Client connected');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'skip_captcha') {
        const threadId = data.threadId;
        console.log(`[Skip] Thread ${threadId}`);
        skipCaptchaFlags.set(threadId, true);
        
        if (captchaResolvers.has(threadId)) {
          const resolver = captchaResolvers.get(threadId);
          resolver.resolve({ skipped: true });
          captchaResolvers.delete(threadId);
        }
        return;
      }
      
      if (data.type === 'click' || data.type === 'captcha_click') {
        let threadId = data.threadId;
        
        if (!threadId && captchaResolvers.size > 0) {
           threadId = captchaResolvers.keys().next().value;
        }

        if (threadId && captchaResolvers.has(threadId)) {
          const resolver = captchaResolvers.get(threadId);
          resolver.resolve(data);
          captchaResolvers.delete(threadId);
        }
      }
    } catch (e) {
      console.error('WS Error:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

// ============================================
// PROGRESS TRACKING
// ============================================

function sendProgressUpdate(data) {
  const message = JSON.stringify({
    type: 'progress',
    instanceId: INSTANCE_ID,  // ← Add this line!
    ...data
  });
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function sendCaptchaToClients(base64Image, threadId) {
  const captchaData = JSON.stringify({
    type: 'captcha',
    image: `data:image/png;base64,${base64Image}`,
    threadId: threadId,
    timestamp: Date.now()
  });
  
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(captchaData);
    }
  });
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// EMAIL GENERATION (OPTIMIZED)
// ============================================

async function generateEmailMailTM(threadId) {
  try {
    const domainsResponse = await axios.get('https://api.mail.tm/domains', {
      timeout: 6000
    });
    
    const domains = domainsResponse.data['hydra:member'];
    if (!domains || domains.length === 0) {
      throw new Error('No domains available');
    }
    
    const domain = domains[0].domain;
    const username = `user${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const email = `${username}@${domain}`;
    const password = `Pass${Date.now()}${Math.random().toString(36).substring(7)}!`;
    
    const accountResponse = await axios.post('https://api.mail.tm/accounts', {
      address: email,
      password: password
    }, {
      timeout: 6000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    const tokenResponse = await axios.post('https://api.mail.tm/token', {
      address: email,
      password: password
    }, {
      timeout: 6000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    const token = tokenResponse.data.token;
    console.log(`[Thread ${threadId}] Email (mail.tm): ${email}`);
    return { email, sidToken: token, provider: 'mailtm' };
    
  } catch (error) {
    return null;
  }
}

async function generateEmailTempMailLol(threadId) {
  try {
    const response = await axios.get('https://api.tempmail.lol/generate', {
      timeout: 6000
    });
    
    const { address, token } = response.data;
    console.log(`[Thread ${threadId}] Email (tempmail.lol): ${address}`);
    return { email: address, sidToken: token, provider: 'tempmail' };
  } catch (error) {
    return null;
  }
}

async function generateEmailInternal(threadId) {
  let emailData = await generateEmailMailTM(threadId);
  
  if (!emailData) {
    emailData = await generateEmailTempMailLol(threadId);
  }
  
  return emailData;
}

async function checkInbox(sidToken, threadId, provider, maxAttempts = 80) {
  let delay = 800;
  const maxDelay = 4000;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      let emails = [];
      
      if (provider === 'mailtm') {
        const response = await axios.get('https://api.mail.tm/messages', {
          timeout: 6000,
          headers: {
            'Authorization': `Bearer ${sidToken}`
          }
        });
        
        const messages = response.data['hydra:member'] || [];
        
        for (const message of messages) {
          const msgResponse = await axios.get(`https://api.mail.tm/messages/${message.id}`, {
            timeout: 6000,
            headers: {
              'Authorization': `Bearer ${sidToken}`
            }
          });
          
          const fullMsg = msgResponse.data;
          const fullText = `${fullMsg.subject || ''} ${fullMsg.text || ''} ${fullMsg.html || ''}`;
          
          if (fullText.toLowerCase().includes('verification') || 
              fullText.toLowerCase().includes('code') ||
              fullText.toLowerCase().includes('playcfl')) {
            
            const codeMatch = fullText.match(/\b\d{4,8}\b/);
            if (codeMatch) {
              const code = codeMatch[0];
              console.log(`[Thread ${threadId}] Code found: ${code}`);
              return code;
            }
          }
        }
      } else if (provider === 'tempmail') {
        const response = await axios.get(
          `https://api.tempmail.lol/auth/${sidToken}`,
          { timeout: 6000 }
        );
        
        emails = response.data.email || [];
        
        for (const message of emails) {
          const fullText = `${message.subject || ''} ${message.body || ''} ${message.html || ''}`;
          
          if (fullText.toLowerCase().includes('verification') || 
              fullText.toLowerCase().includes('code') ||
              fullText.toLowerCase().includes('playcfl')) {
            
            const codeMatch = fullText.match(/\b\d{4,8}\b/);
            if (codeMatch) {
              const code = codeMatch[0];
              console.log(`[Thread ${threadId}] Code found: ${code}`);
              return code;
            }
          }
        }
      }
      
      await wait(delay);
      delay = Math.min(delay * 1.15, maxDelay);
      
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 401) {
        await wait(delay);
        delay = Math.min(delay * 1.15, maxDelay);
      } else {
        await wait(600);
      }
    }
  }
  return null;
}

// ============================================
// BROWSER MANAGEMENT
// ============================================

async function getOrCreateBrowser(proxyConfig = null) {
  if (browserInstance && browserUseCount < MAX_BROWSER_USES) {
    browserUseCount++;
    return browserInstance;
  }
  
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {}
    browserInstance = null;
  }
  
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    '--lang=en-US,en;q=0.9',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--mute-audio',
    '--no-default-browser-check',
    '--autoplay-policy=user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-notifications',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run'
  ];
  
  if (proxyConfig) {
    args.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
  }
  
  browserInstance = await puppeteer.launch({
    headless: "new",
    args,
    defaultViewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  });
  
  browserUseCount = 1;
  console.log('[Browser] New instance created');
  return browserInstance;
}

async function clearPageSession(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
    });
    
    return true;
  } catch (e) {
    return false;
  }
}

async function setupOptimizedPage(context) {
  const page = await context.newPage();
  
  await page.setRequestInterception(true);
  
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    const url = req.url();
    
    const isCaptchaResource = 
      url.includes('captcha') ||
      url.includes('t.captcha') ||
      url.includes('ssl.captcha') ||
      url.includes('tcaptcha') ||
      url.includes('qq.com');
    
    if (isCaptchaResource) {
      req.continue();
      return;
    }
    
    if (
      resourceType === 'image' ||
      resourceType === 'stylesheet' ||
      resourceType === 'font' ||
      resourceType === 'media' ||
      url.includes('google-analytics') ||
      url.includes('facebook') ||
      url.includes('doubleclick') ||
      url.includes('tracking') ||
      url.includes('.woff') ||
      url.includes('.ttf')
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  const ua = getRandomUserAgent();
  await page.setUserAgent(ua);
  
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.playcfl.com/'
  });
  
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  
  page.on('dialog', async dialog => {
    try {
      await dialog.accept();
    } catch (e) {}
  });
  
  return page;
}

// ============================================
// CAPTCHA HANDLING (OPTIMIZED)
// ============================================

async function waitForCaptchaImagesToLoad(frame, maxWaitMs = 2500) {
  try {
    await frame.waitForSelector('#slideBg, #canvas, .tc-bg, img', { timeout: maxWaitMs }).catch(() => {});

    await frame.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const loadedImages = imgs.filter(img => img.complete && img.naturalWidth > 50);
      return loadedImages.length >= 1; 
    }, { timeout: maxWaitMs });

    await new Promise(r => setTimeout(r, 600));
    return true;
  } catch (e) {
    return false;
  }
}

async function takeCaptchaScreenshot(frame, threadId, attemptNum = 1, sendToClients = true) {
  try {
    await frame.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    
    await waitForCaptchaImagesToLoad(frame);

    const selectors = [
      '#tcaptcha_transform_dy',
      '#tc-190-main',
      '.tc-wrapper',
      '#tcaptcha_drag_wrapper',
      '#cap_interact_doge',
      'body'
    ];

    let element = null;

    for (const sel of selectors) {
      const el = await frame.$(sel);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          element = el;
          if (sel !== 'body') break; 
        }
      }
    }
    
    if (!element) {
      throw new Error("Could not find captcha element");
    }

    await element.evaluate(el => {
      el.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
    });

    await new Promise(resolve => setTimeout(resolve, 150));

    const screenshot = await element.screenshot({ 
      encoding: 'base64',
      type: 'png',
      omitBackground: true
    });
    
    if (sendToClients) {
      sendCaptchaToClients(screenshot, threadId);
    }
    return screenshot;
    
  } catch (e) {
    console.error(`[Thread ${threadId}] Screenshot error:`, e.message);
    return null;
  }
}

async function waitForCaptchaSolution(threadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      captchaResolvers.delete(threadId);
      resolve(null);
    }, timeoutMs);
    
    captchaResolvers.set(threadId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

async function solveCaptchaManually(page, threadId) {
  try {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    
    await page.waitForSelector('#tcaptcha_iframe_dy', { visible: true, timeout: 8000 });
    await wait(800);
    
    // Handle multiple consecutive captchas
    const maxCaptchaRounds = 2; // Reduced from 3 to 2
    
    for (let round = 1; round <= maxCaptchaRounds; round++) {
      console.log(`[Thread ${threadId}] Captcha round ${round}/${maxCaptchaRounds}`);
      
      // Only check for early success on round 2+ (after we've already tried solving once)
      if (round > 1) {
        const earlySuccess = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          
          // Check for success messages
          if (bodyText.includes('Verification code obtained') || 
              bodyText.includes('验证码已发送') ||
              bodyText.includes('Code sent') ||
              bodyText.includes('successfully')) {
            return true;
          }
          
          // Check for countdown timer (indicates code was sent)
          const spans = document.querySelectorAll('button span, span');
          for (const span of spans) {
            const text = span.innerText || '';
            if (/^\d+s$/.test(text.trim())) {
              return true;
            }
          }
          
          return false;
        });
        
        if (earlySuccess) {
          console.log(`[Thread ${threadId}] Success detected at start of round ${round}, captcha solved!`);
          return true;
        }
      }
      
      // Check if captcha still exists
      const iframeHandle = await page.$('#tcaptcha_iframe_dy');
      if (!iframeHandle) {
        console.log(`[Thread ${threadId}] No captcha iframe found, proceeding`);
        return true;
      }
      
      const isVisible = await page.evaluate(() => {
        const iframe = document.querySelector('#tcaptcha_iframe_dy');
        if (!iframe) return false;
        const style = window.getComputedStyle(iframe);
        return style.display !== 'none' && style.visibility !== 'hidden' && iframe.offsetParent !== null;
      });
      
      if (!isVisible) {
        console.log(`[Thread ${threadId}] Captcha iframe hidden, success`);
        return true;
      }
      
      await page.evaluate((iframe) => {
        window.scrollTo(0, 0);
        iframe.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'nearest' });
      }, iframeHandle);
      await wait(400);

      const frame = await iframeHandle.contentFrame();
      if (!frame) {
        console.log(`[Thread ${threadId}] Cannot access frame, assuming solved`);
        return true;
      }

      let screenshot = await takeCaptchaScreenshot(frame, threadId, round, !useAiSolver);
      
      let roundSolved = false;
      let clickAttempts = 0;
      const maxClickAttempts = useAiSolver ? 3 : 2;

      while (!roundSolved && clickAttempts < maxClickAttempts) {
        if (skipCaptchaFlags.get(threadId)) {
          skipCaptchaFlags.delete(threadId);
          console.log(`[Thread ${threadId}] Captcha skipped`);
          return 'skipped';
        }
        
        let clickData = null;
        
        if (useAiSolver && screenshot) {
          const aiPosition = await solveWithGemini(screenshot, threadId);
          if (aiPosition) {
            const coords = gridCoordinates[aiPosition];
            clickData = { x: coords.x, y: coords.y, position: aiPosition, source: 'ai' };
            console.log(`[Thread ${threadId}] Using AI solution: position ${aiPosition}`);
          } else {
            // AI failed to solve - in AI mode, don't wait for manual input
            console.log(`[Thread ${threadId}] AI failed to solve, trying next attempt...`);
            clickAttempts++;
            
            if (clickAttempts < maxClickAttempts) {
              await wait(800);
              const currentIframe = await page.$('#tcaptcha_iframe_dy');
              if (currentIframe) {
                const currentFrame = await currentIframe.contentFrame();
                if (currentFrame) {
                  const newScreenshot = await takeCaptchaScreenshot(currentFrame, threadId, clickAttempts + 1, false);
                  if (newScreenshot) {
                    screenshot = newScreenshot;
                  }
                }
              }
            }
            continue; // Try again with new screenshot
          }
        } else if (!useAiSolver) {
          // Manual mode - wait for user input
          console.log(`[Thread ${threadId}] Waiting for manual captcha solution...`);
          const manualSolution = await waitForCaptchaSolution(threadId, 120000);
          
          if (!manualSolution) {
            console.log(`[Thread ${threadId}] Manual solution timeout`);
            break;
          }
          
          if (manualSolution.skipped) {
            return 'skipped';
          }
          
          clickData = { ...manualSolution, source: 'manual' };
          console.log(`[Thread ${threadId}] Received manual solution: position ${clickData.position}`);
        } else {
          // AI mode but no screenshot available
          console.log(`[Thread ${threadId}] No screenshot available for AI solve`);
          break;
        }

        if (!clickData) {
          break;
        }

        if (clickData.skipped) {
          return 'skipped';
        }

        const { x, y, source } = clickData;
        clickAttempts++;
        
        console.log(`[Thread ${threadId}] Round ${round}, Click ${clickAttempts} (${source}): ${x}, ${y}`);
        
        try {
          await frame.evaluate((clickX, clickY) => {
            const el = document.elementFromPoint(clickX, clickY);
            if (el) {
              el.click();
              const ev = new MouseEvent('click', {
                view: window, bubbles: true, cancelable: true,
                clientX: clickX, clientY: clickY
              });
              el.dispatchEvent(ev);
            }
          }, x, y);
          
          await wait(500);

          await frame.evaluate(() => {
            const okBtn = document.getElementById('ok_btn');
            if (okBtn) { okBtn.click(); return; }
            
            const okByClass = document.querySelector('.tc-action-btn');
            if (okByClass) { okByClass.click(); return; }
            
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a'));
            const okButton = buttons.find(b => 
              b.textContent && (b.textContent.includes('OK') || b.textContent.includes('确定'))
            );
            if (okButton) { okButton.click(); return; }
            
            const el = document.elementFromPoint(320, 340);
            if (el) el.click();
          });
          
          await wait(1500); // Increased wait to allow captcha to update
          
          // CRITICAL: Check if we already have success indicators before checking captcha status
          const quickSuccessCheck = await page.evaluate(() => {
            // Priority 1: Look for countdown timer (most reliable indicator)
            const spans = document.querySelectorAll('button span, span');
            for (const span of spans) {
              const text = span.innerText || '';
              if (/^\d+s$/.test(text.trim())) {
                return true;
              }
            }
            
            // Priority 2: Check if iframe is gone
            const iframe = document.querySelector('#tcaptcha_iframe_dy');
            if (!iframe) return true;
            
            const style = window.getComputedStyle(iframe);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return true;
            }
            
            return false;
          });
          
          if (quickSuccessCheck) {
            console.log(`[Thread ${threadId}] Quick success check passed (countdown/iframe gone), captcha solved!`);
            return true;
          }

          const captchaStatus = await page.evaluate(() => {
            const iframe = document.querySelector('#tcaptcha_iframe_dy');
            
            if (!iframe) return { solved: true, method: 'iframe_removed', newCaptcha: false };
            
            const style = window.getComputedStyle(iframe);
            if (style.display === 'none' || style.visibility === 'hidden' || iframe.offsetParent === null) {
              return { solved: true, method: 'iframe_hidden', newCaptcha: false };
            }
            
            const bodyText = document.body.innerText || '';
            if (bodyText.includes('Verification code obtained successfully') || 
                bodyText.includes('验证码已发送') ||
                bodyText.includes('Code sent') ||
                bodyText.includes('successfully')) {
              return { solved: true, method: 'success_message', newCaptcha: false };
            }
            
            const spans = document.querySelectorAll('button span, span');
            for (const span of spans) {
              const text = span.innerText || '';
              if (/^\d+s$/.test(text.trim())) {
                return { solved: true, method: 'countdown_detected', newCaptcha: false };
              }
            }
            
            const rect = iframe.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return { solved: true, method: 'zero_dimensions', newCaptcha: false };
            }
            
            // Check if a new captcha appeared (images changed)
            return { solved: false, newCaptcha: true };
          });
          
          if (captchaStatus.solved) {
            console.log(`[Thread ${threadId}] Captcha round ${round} solved via ${captchaStatus.method}`);
            roundSolved = true;
            
            // IMPORTANT: If solved by success_message or countdown, we're done entirely
            if (captchaStatus.method === 'success_message' || captchaStatus.method === 'countdown_detected') {
              console.log(`[Thread ${threadId}] Definitive success detected, exiting captcha handler`);
              return true;
            }
            break;
          }
          
          // If captcha still present, take new screenshot for next attempt
          if (clickAttempts < maxClickAttempts) {
            await wait(800);
            
            // Before taking new screenshot, verify captcha is still there
            const captchaStillPresent = await page.evaluate(() => {
              const iframe = document.querySelector('#tcaptcha_iframe_dy');
              if (!iframe) return false;
              const style = window.getComputedStyle(iframe);
              return style.display !== 'none' && style.visibility !== 'hidden' && iframe.offsetParent !== null;
            });
            
            if (!captchaStillPresent) {
              console.log(`[Thread ${threadId}] Captcha disappeared, assuming solved`);
              return true;
            }
            
            const currentIframe = await page.$('#tcaptcha_iframe_dy');
            if (!currentIframe) {
              console.log(`[Thread ${threadId}] Iframe disappeared during retry`);
              return true;
            }
            
            const currentFrame = await currentIframe.contentFrame();
            if (currentFrame) {
              const shouldSendToClients = !useAiSolver || source === 'manual';
              const newScreenshot = await takeCaptchaScreenshot(currentFrame, threadId, clickAttempts + 1, shouldSendToClients);
              if (newScreenshot) {
                screenshot = newScreenshot;
              } else {
                console.log(`[Thread ${threadId}] Failed to get new screenshot, captcha may be solved`);
                return true;
              }
            }
          }
          
        } catch (clickErr) {
          console.error(`[Thread ${threadId}] Click error:`, clickErr.message);
        }
      }
      
      if (!roundSolved && round < maxCaptchaRounds) {
        console.log(`[Thread ${threadId}] Round ${round} incomplete, checking for next captcha...`);
        await wait(800);
        
        // Before continuing, check one more time for success
        const successCheck = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          return bodyText.includes('Verification code') || 
                 bodyText.includes('Code sent') || 
                 bodyText.includes('successfully');
        });
        
        if (successCheck) {
          console.log(`[Thread ${threadId}] Success detected between rounds, stopping`);
          return true;
        }
        
        continue; // Try next round
      }
      
      if (!roundSolved) {
        // Final check before declaring failure
        console.log(`[Thread ${threadId}] Performing final success check...`);
        await wait(1000);
        
        const finalCheck = await page.evaluate(() => {
          const iframe = document.querySelector('#tcaptcha_iframe_dy');
          if (!iframe) return true;
          const style = window.getComputedStyle(iframe);
          if (style.display === 'none' || style.visibility === 'hidden') return true;
          
          const bodyText = document.body.innerText || '';
          if (bodyText.includes('Verification code') || 
              bodyText.includes('Code sent') ||
              bodyText.includes('successfully')) {
            return true;
          }
          
          // Check for countdown
          const spans = document.querySelectorAll('button span, span');
          for (const span of spans) {
            const text = span.innerText || '';
            if (/^\d+s$/.test(text.trim())) {
              return true;
            }
          }
          
          return false;
        });
        
        if (finalCheck) {
          console.log(`[Thread ${threadId}] Final check passed, captcha solved`);
          return true;
        }
        
        console.log(`[Thread ${threadId}] All captcha rounds failed, no success indicators found`);
        return false;
      }
      
      // After solving a round, check if we're truly done
      await wait(1200);
      
      const completionCheck = await page.evaluate(() => {
        // Check for definitive success first
        const bodyText = document.body.innerText || '';
        if (bodyText.includes('Verification code') || 
            bodyText.includes('Code sent') ||
            bodyText.includes('successfully')) {
          return { done: true, reason: 'success_message' };
        }
        
        // Check for countdown
        const spans = document.querySelectorAll('button span, span');
        for (const span of spans) {
          const text = span.innerText || '';
          if (/^\d+s$/.test(text.trim())) {
            return { done: true, reason: 'countdown' };
          }
        }
        
        // Check if captcha still visible
        const iframe = document.querySelector('#tcaptcha_iframe_dy');
        if (!iframe) return { done: true, reason: 'no_iframe' };
        
        const style = window.getComputedStyle(iframe);
        if (style.display === 'none' || style.visibility === 'hidden' || iframe.offsetParent === null) {
          return { done: true, reason: 'iframe_hidden' };
        }
        
        return { done: false };
      });
      
      if (completionCheck.done) {
        console.log(`[Thread ${threadId}] Captcha fully complete (${completionCheck.reason})`);
        return true;
      }
      
      console.log(`[Thread ${threadId}] Another captcha may be present, continuing to round ${round + 1}...`);
    }
    
    // If we've completed all rounds without definitive success, do thorough final check
    console.log(`[Thread ${threadId}] Completed ${maxCaptchaRounds} rounds, comprehensive final check...`);
    await wait(800);
    
    const finalSuccess = await page.evaluate(() => {
      // Priority 1: Countdown timer (most reliable)
      const spans = document.querySelectorAll('button span, span');
      for (const span of spans) {
        const text = span.innerText || '';
        if (/^\d+s$/.test(text.trim())) {
          return true;
        }
      }
      
      // Priority 2: Captcha iframe gone/hidden
      const iframe = document.querySelector('#tcaptcha_iframe_dy');
      if (!iframe) return true;
      
      const style = window.getComputedStyle(iframe);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      
      // Priority 3: Verification code input field visible
      const codeInput = document.querySelector('input[placeholder="Verification code"]');
      if (codeInput && codeInput.offsetParent !== null) {
        return true;
      }
      
      return false;
    });
    
    if (finalSuccess) {
      console.log(`[Thread ${threadId}] Final check confirmed success`);
    } else {
      console.log(`[Thread ${threadId}] Final check: no success indicators found`);
    }
    
    return finalSuccess;

  } catch (error) {
    console.error(`[Thread ${threadId}] Captcha error:`, error.message);
    return false;
  }
}

async function waitForAndClickGetCodeButton(page, threadId, maxWaitTime = 12000) {
  const startTime = Date.now();
  
  await page.waitForSelector('.slick-slide.slick-active', { timeout: 3000 }).catch(() => {});
  await wait(400);
  
  await page.evaluate(() => {
    const activeSlide = document.querySelector('.slick-slide.slick-active');
    if (activeSlide) {
      window.scrollTo(0, 0);
      activeSlide.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  
  await wait(400);
  
  const buttonAppeared = await page.waitForFunction(
    () => {
      const activeSlide = document.querySelector('.slick-slide.slick-active');
      if (!activeSlide) return false;
      
      const allElements = activeSlide.querySelectorAll('button, span, a, div');
      const keywords = ['Get code', 'get code', 'GET CODE', 'Resend', 'resend', 
                       '获取', 'GetCode', 'Get Code'];
      
      for (const el of allElements) {
        const text = (el.innerText || el.textContent || '').trim();
        if (keywords.some(kw => text.includes(kw))) {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && 
                          rect.top >= 0 && rect.top <= window.innerHeight;
          if (isVisible) return true;
        }
      }
      return false;
    },
    { timeout: maxWaitTime - (Date.now() - startTime) }
  ).catch(() => false);
  
  if (!buttonAppeared) {
    return false;
  }
  
  const clickStrategies = [
    {
      name: 'Text Match Click',
      execute: async () => {
        return await page.evaluate(() => {
          const activeSlide = document.querySelector('.slick-slide.slick-active');
          if (!activeSlide) return false;
          
          const allElements = Array.from(activeSlide.querySelectorAll('button, span, a, div'));
          const keywords = ['Get code', 'get code', 'Resend', '获取', 'GetCode'];
          
          for (const el of allElements) {
            const text = (el.innerText || el.textContent || '').trim();
            if (keywords.some(kw => text.includes(kw))) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                if (el.tagName === 'SPAN' && el.parentElement) {
                  el.parentElement.click();
                }
                return true;
              }
            }
          }
          return false;
        });
      }
    },
    {
      name: 'Focus + Enter',
      execute: async () => {
        const success = await page.evaluate(() => {
          const activeSlide = document.querySelector('.slick-slide.slick-active');
          if (!activeSlide) return false;
          
          const buttons = Array.from(activeSlide.querySelectorAll('button, span, a'));
          const keywords = ['Get code', 'Resend', '获取'];
          
          for (const btn of buttons) {
            const text = (btn.innerText || '').trim();
            if (keywords.some(kw => text.includes(kw))) {
              if (btn.focus) btn.focus();
              return true;
            }
          }
          return false;
        });
        
        if (success) {
          await wait(150);
          await page.keyboard.press('Enter');
          return true;
        }
        return false;
      }
    }
  ];
  
  for (let i = 0; i < clickStrategies.length; i++) {
    const strategy = clickStrategies[i];
    
    try {
      const success = await strategy.execute();
      
      if (success) {
        await wait(400);
        
        const captchaAppeared = await page.waitForSelector('#tcaptcha_iframe_dy', { 
          visible: true, 
          timeout: 2500 
        }).then(() => true).catch(() => false);
        
        if (captchaAppeared) {
          return true;
        } else {
          await wait(600);
        }
      }
    } catch (e) {
      // Continue to next strategy
    }
  }
  
  return false;
}

// ============================================
// MAIN ACCOUNT PROCESSING (OPTIMIZED)
// ============================================

async function processAccount(targetUrl, threadId, proxyConfig = null, browser) {
  let context = null;
  let page = null;
  let targetPage = null;
  let inboxPromise = null;
  let emailData = null;
  
  try {
    console.log(`[Thread ${threadId}] Starting...`);
    
    // Get email from queue (pre-generated)
    emailData = await getEmailFromQueue(threadId);
    
    if (!emailData) {
      throw new Error('Failed to generate email');
    }
    
    const { email, sidToken, provider } = emailData;
    
    // Get context from pool
    context = await contextPool.getContext(browser);
    if (!context) {
      throw new Error('Failed to get browser context');
    }
    
    page = await setupOptimizedPage(context);
    
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 25000 
    });
    
    await wait(250);
    
    await page.waitForSelector('#pop2LoginBtn', { timeout: 12000 }).catch(() => {});

    try {
      await page.click('#pop2LoginBtn');
    } catch {
      await page.evaluate(() => {
        const btn = document.querySelector('#pop2LoginBtn') || document.querySelector('a.pop_btn3');
        if (btn) btn.click();
      });
    }
    
    await wait(1000);
    
    const pages = await context.pages();
    targetPage = pages[pages.length - 1];
    
    if (targetPage !== page) {
      targetPage.on('dialog', async dialog => {
        try {
          await dialog.accept();
        } catch (e) {}
      });
    }

    await targetPage.waitForSelector('.login-goRegister__button', { timeout: 6000 });
    await targetPage.click('.login-goRegister__button');
    
    await targetPage.waitForSelector('#registerForm_account', { timeout: 6000 });
    
    await targetPage.type('#registerForm_account', email, { delay: 6 });
    
    await targetPage.evaluate(() => {
      const input = document.querySelector('#registerForm_account');
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    });

    // Start inbox check early
    inboxPromise = checkInbox(sidToken, threadId, provider);
    
    await wait(250);
    
    // Wait for captcha turn (queue system)
    await waitForCaptchaTurn(threadId);
    
    let captchaSuccessfullyTriggered = false;
    
    console.log(`[Thread ${threadId}] Captcha turn acquired`);
    
    try {
      const maxTriggerAttempts = 1;

      await targetPage.evaluate(() => {
        const activeSlide = document.querySelector('.slick-slide.slick-active');
        if (activeSlide) {
          activeSlide.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });

      await wait(500);

      for (let attempt = 1; attempt <= maxTriggerAttempts; attempt++) {
        console.log(`[Thread ${threadId}] Trigger attempt ${attempt}/${maxTriggerAttempts}`);
        
        try {
          const clicked = await waitForAndClickGetCodeButton(targetPage, threadId);
          
          if (!clicked) {
            if (attempt < maxTriggerAttempts) {
              await wait(800);
              await targetPage.evaluate(() => window.scrollTo(0, 0));
              continue;
            } else {
              throw new Error('Failed to click Get Code button');
            }
          }
          
          await wait(500);

          const success = await solveCaptchaManually(targetPage, threadId);
          
          if (success === 'skipped') {
            return { success: false, skipped: true, threadId };
          }
          
          if (success) {
            captchaSuccessfullyTriggered = true;
            break;
          } else {
            await wait(300);
          }
        } catch (e) {
          console.error(`[Thread ${threadId}] Trigger error:`, e.message);
          if (attempt < maxTriggerAttempts) {
            await wait(300);
          }
        }
      }

    } finally {
      releaseCaptchaLock(threadId);
    }

    if (!captchaSuccessfullyTriggered) {
      throw new Error('Failed to trigger/solve captcha');
    }
    
    console.log(`[Thread ${threadId}] Waiting for verification code...`);
    const verificationCode = await inboxPromise;
    
    if (!verificationCode) {
      throw new Error('Failed to receive verification code');
    }
    
    await targetPage.waitForSelector('input[placeholder="Verification code"]', { timeout: 6000 });
    await targetPage.type('input[placeholder="Verification code"]', verificationCode, { delay: 12 });
    
    await wait(250);
    
    console.log(`[Thread ${threadId}] Completing form...`);
    
    await targetPage.evaluate(() => {
      const activeSlide = document.querySelector('.slick-slide.slick-active');
      if (!activeSlide) return;
      
      const ageDropdown = document.querySelector('div.infinite-select-selector');
      if (ageDropdown) ageDropdown.click();
      
      const ageLabel = Array.from(activeSlide.querySelectorAll('label')).find(l =>
        l.innerText && l.innerText.includes('18 years')
      );
      if (ageLabel) ageLabel.click();
      
      const checkboxes = activeSlide.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
    });
    
    try {
      await targetPage.keyboard.type('20');
      await wait(150);
      await targetPage.keyboard.press('Enter');
    } catch {}
    
    await wait(500);
    
    console.log(`[Thread ${threadId}] Submitting...`);
    await targetPage.evaluate(() => {
      const activeSlide = document.querySelector('.slick-slide.slick-active');
      if (!activeSlide) return;
      const btns = Array.from(activeSlide.querySelectorAll('button'));
      const continueBtn = btns.find(b => b.innerText.includes('Continue'));
      if (continueBtn) continueBtn.click();
    });
    
    await wait(600);
    
    console.log(`[Thread ${threadId}] Post-registration...`);
    
    targetPage.removeAllListeners('dialog');
    
    let flameAlertSeen = false;
    let invitationAlertSeen = false;
    let invitationStatus = null;
    
    targetPage.on('dialog', async (dialog) => {
      const message = dialog.message();
      console.log(`[Thread ${threadId}] Alert: "${message}"`);
      
      if (message.toLowerCase().includes('flame') || 
          message.includes('🔥') ||
          message.toLowerCase().includes('fire')) {
        flameAlertSeen = true;
      }
      
      if (message.includes("Sorry, you've already been invited") || 
          message.includes("already been invited")) {
        invitationAlertSeen = true;
        invitationStatus = 'already_invited';
      } else if (message.includes('Invitation accepted') || 
                 message.includes('successfully invited')) {
        invitationAlertSeen = true;
        invitationStatus = 'success';
      }
      
      try {
        await dialog.accept();
      } catch (e) {}
    });
    
    await targetPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const skipBtn = buttons.find(btn => {
        const text = (btn.innerText || btn.textContent || '').toLowerCase();
        return text.includes('skip');
      });
      if (skipBtn) skipBtn.click();
    });
    
    const flameAlertTimeout = Date.now() + 3500;
    while (!flameAlertSeen && Date.now() < flameAlertTimeout) {
      await wait(350);
    }
    
    const invitationAlertTimeout = Date.now() + 3500;
    while (!invitationAlertSeen && Date.now() < invitationAlertTimeout) {
      await wait(350);
    }
    
    if (!invitationAlertSeen || !invitationStatus) {
      invitationStatus = await targetPage.evaluate(() => {
        const bodyText = document.body.innerText || '';
        
        if (bodyText.includes("Sorry, you've already been invited") || 
            bodyText.includes("already been invited")) {
          return 'already_invited';
        }
        
        if (bodyText.includes('Invitation is successful') || 
            bodyText.includes('successfully invited')) {
          return 'success';
        }
        
        return 'unknown';
      });
    }
    
    if (invitationStatus === 'already_invited') {
      console.log(`[Thread ${threadId}] Already invited - counting as success`);
      return { success: true, email, threadId };
    }
    
    if (invitationStatus === 'success') {
      console.log(`[Thread ${threadId}] ✅ SUCCESS!`);
      return { success: true, email, threadId };
    }
    
    console.log(`[Thread ${threadId}] Status unknown, assuming success`);
    return { success: true, email, threadId };
    
  } catch (error) {
    console.error(`[Thread ${threadId}] ERROR:`, error.message);
    return { success: false, error: error.message, threadId };
  } finally {
    if (context) {
      await contextPool.releaseContext(context);
    }
  }
}

// ============================================
// ADAPTIVE BATCH SIZING
// ============================================
function calculateOptimalBatchSize(successRate, currentThreads, maxThreads) {
  if (successRate > 0.75) {
    return Math.min(currentThreads + 1, maxThreads);
  }
  
  if (successRate < 0.35) {
    return Math.max(currentThreads - 1, 2);
  }
  
  return currentThreads;
}

// ============================================
// API ENDPOINTS
// ============================================

app.post('/api/generate', async (req, res) => {
  const { targetUrl, accountCount, proxies, maxThreads = MAX_THREADS, geminiApiKey: apiKey, useAi } = req.body;
  
  // Initialize Gemini if API key provided
  if (useAi && apiKey) {
    initializeGemini(apiKey);
  } else {
    useAiSolver = false;
  }
  
  const maxAllowedThreads = Math.min(maxThreads, MAX_THREADS);
  let currentThreads = Math.min(3, maxAllowedThreads); // Start conservative
  
  console.log('==========================================');
  console.log(`TARGET: ${accountCount} successful account(s)`);
  console.log(`THREADS: Starting with ${currentThreads}, max ${maxAllowedThreads}`);
  if (useAiSolver) console.log(`🤖 AI Solver: ENABLED`);
  console.log('==========================================');
  
  const results = [];
  let browser = null;
  let successfulCount = 0;
  let totalAttempts = 0;
  const maxTotalAttempts = accountCount * 8;
  
  // Pre-fill email queue
  maintainEmailQueue().catch(() => {});
  
  sendProgressUpdate({
    successful: 0,
    target: accountCount,
    attempts: 0
  });
  
  try {
    browser = await getOrCreateBrowser(proxies?.[0] || null);
    
    while (successfulCount < accountCount && totalAttempts < maxTotalAttempts) {
      const remainingSuccessNeeded = accountCount - successfulCount;
      const batchSize = Math.min(currentThreads, remainingSuccessNeeded);
      
      console.log(`[Batch] Starting ${batchSize} threads (${successfulCount}/${accountCount} successful)`);
      
      const batchPromises = [];
      
      for (let i = 0; i < batchSize; i++) {
        totalAttempts++;
        const threadId = totalAttempts;
        
        let proxyConfig = null;
        if (proxies && proxies.length > 0) {
          proxyConfig = proxies[(totalAttempts - 1) % proxies.length];
        }
        
        batchPromises.push(
          processAccount(targetUrl, threadId, proxyConfig, browser)
            .then(result => {
              if (result.success) {
                successfulCount++;
                console.log(`✅ Progress: ${successfulCount}/${accountCount}`);
                
                sendProgressUpdate({
                  successful: successfulCount,   // Send THIS instance's count
                  attempts: totalAttempts,
                  instanceId: INSTANCE_ID
                });
              } else if (result.skipped) {
                console.log(`⏭️ Skipped (${successfulCount}/${accountCount})`);
              } else {
                console.log(`❌ Failed (${successfulCount}/${accountCount})`);
              }
              return result;
            })
        );
      }
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Adaptive batch sizing
      const batchSuccessRate = batchResults.filter(r => r.success).length / batchResults.length;
      const newThreadCount = calculateOptimalBatchSize(batchSuccessRate, currentThreads, maxAllowedThreads);
      
      if (newThreadCount !== currentThreads) {
        console.log(`[Adaptive] Adjusting threads: ${currentThreads} → ${newThreadCount} (success rate: ${(batchSuccessRate * 100).toFixed(0)}%)`);
        currentThreads = newThreadCount;
      }
      
      if (successfulCount < accountCount && totalAttempts < maxTotalAttempts) {
        await wait(500);
      }
    }
    
    if (totalAttempts >= maxTotalAttempts && successfulCount < accountCount) {
      console.log(`⚠️ Reached max attempts (${maxTotalAttempts})`);
    }
    
  } finally {
    await contextPool.cleanup();
    
    if (browser) {
      try {
        await browser.close();
        browserInstance = null;
        console.log('[Browser] Closed');
      } catch {}
    }
  }
  
  const skippedCount = results.filter(r => r.skipped).length;
  const failedCount = results.filter(r => !r.success && !r.skipped).length;
  
  console.log('==========================================');
  console.log(`🎯 COMPLETE: ${successfulCount}/${accountCount} successful`);
  console.log(`📊 Total attempts: ${totalAttempts}`);
  if (skippedCount > 0) console.log(`⏭️ Skipped: ${skippedCount}`);
  if (failedCount > 0) console.log(`❌ Failed: ${failedCount}`);
  console.log('==========================================');
  
  res.json({
    success: true,
    results,
    summary: {
      targetSuccessful: accountCount,
      actualSuccessful: successfulCount,
      totalAttempts: totalAttempts,
      skipped: skippedCount,
      failed: failedCount
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend running', threads: MAX_THREADS });
});

app.post('/api/cleanup', async (req, res) => {
  if (browserInstance) {
    try {
      await browserInstance.close();
      browserInstance = null;
      browserUseCount = 0;
      console.log('[Cleanup] Browser closed');
    } catch (e) {}
  }
  
  await contextPool.cleanup();
  
  res.json({ success: true });
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../account-generator-frontend/build', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`📡 Multi-threaded mode: ${MAX_THREADS} max threads`);
  console.log(`⚡ Optimized with: Email Queue, Captcha Queue, Context Pool`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

process.on('SIGINT', async () => {
  await contextPool.cleanup();
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => console.error('🔥 Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Rejection:', reason));