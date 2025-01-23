const express = require('express');
const Unblocker = require('unblocker');
const url = require('url');
const http = require('http');
const https = require('https');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const fileCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 }); 

const HOST_PORT = 80;

function decodeUrl(encodedUrl) {
  return decodeURIComponent(encodedUrl.replace(/\+/g, ' '));
}

async function downloadFile(fileUrl, basePath) {
  const cacheKey = `file:${fileUrl}`;
  const cachedFile = fileCache.get(cacheKey);
  if (cachedFile) return cachedFile;

  return new Promise((resolve, reject) => {
    const protocol = fileUrl.startsWith('https') ? https : http;
    protocol.get(fileUrl, (response) => {
      if (response.statusCode === 200) {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          fileCache.set(cacheKey, data);
          resolve(data);
        });
      } else {
        reject(new Error(`Failed to download file: ${fileUrl}`));
      }
    }).on('error', reject);
  });
}

async function downloadAllFiles(baseUrl, html) {
  const $ = cheerio.load(html);
  const filesToDownload = new Set();

  $('script[src], link[href], img[src], source[src]').each((_, elem) => {
    const src = $(elem).attr('src') || $(elem).attr('href');
    if (src && !src.startsWith('data:') && !src.startsWith('http')) {
      filesToDownload.add(url.resolve(baseUrl, src));
    }
  });

  for (const fileUrl of filesToDownload) {
    try {
      await downloadFile(fileUrl, baseUrl);
    } catch (error) {
      console.error(`Error downloading ${fileUrl}:`, error.message);
    }
  }
}

async function handleRedirects(data) {
  if (data.headers && data.headers.location) {
    const location = decodeUrl(data.headers.location);
    const parsed = url.parse(location);
    if (parsed.protocol) {
      data.headers.location = '/proxy/' + location;
    } else if (!location.startsWith('/proxy/')) {
      data.headers.location = '/proxy/' + url.resolve(data.url, location);
    }
  }
  return data;
}

async function modifyHtml(data) {
  if (data.contentType && data.contentType.includes('text/html') && data.content) {
    let content = data.content;
    if (Buffer.isBuffer(content)) {
      content = content.toString();
    } else if (typeof content !== 'string') {
      return data;
    }

    const $ = cheerio.load(content);

    $('meta[http-equiv="Content-Security-Policy"]').remove();

    $('a, link, script, img, iframe, form, source').each(function() {
      const elem = $(this);
      ['href', 'src', 'action'].forEach(attr => {
        if (elem.attr(attr)) {
          let originalUrl = elem.attr(attr);
          if (!originalUrl.startsWith('/proxy/') && !originalUrl.startsWith('javascript:') && !originalUrl.startsWith('data:')) {
            elem.attr(attr, '/proxy/' + url.resolve(data.url, originalUrl));
          }
        }
      });
    });

    if (!$('base').length) {
      $('head').prepend(`<base href="${data.url}">`);
    }

    $('body').append(`<script>
      window.open = function(url) {
        if (url && !url.startsWith('/proxy/')) {
          url = '/proxy/' + url;
        }
        window.location.href = url;
      };
    </script>`);

    data.content = $.html();

    await downloadAllFiles(data.url, data.content);
  }

  if (!data.headers) {
    data.headers = {};
  }
  data.headers['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";
  data.headers['X-Frame-Options'] = 'ALLOWALL';
  data.headers['Access-Control-Allow-Origin'] = '*';

  return data;
}

async function fetchWebsiteData(websiteUrl) {
  const cacheKey = websiteUrl;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  if (!websiteUrl.startsWith('/proxy/')) {
    throw new Error('URL must start with /proxy/');
  }
  websiteUrl = websiteUrl.substring(7);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  const page = await browser.newPage();

  const userAgent = new UserAgent();
  await page.setUserAgent(userAgent.toString());

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br'
  });

  await page.setJavaScriptEnabled(true);
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const finalUrl = page.url();
    const content = await page.content();
    await browser.close();

    cache.set(cacheKey, { content, finalUrl });
    return { content, finalUrl };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

const unblocker = new Unblocker({
  prefix: '/proxy/',
  responseMiddleware: [
    handleRedirects,
    modifyHtml
  ]
});

app.use(unblocker);
app.use(express.static('public'));

app.use((req, res, next) => {
  next();
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/resources/index.html');
});
app.get('/home', (req, res) => res.sendFile(__dirname + '/resources/homepage.html'));
app.get('/robots.txt', (req, res) => res.sendFile(__dirname + '/resources/robots.txt'));

// settings.html is unusable
// app.get('/settings', (req, res) => res.sendFile(__dirname + '/resources/settings.html'));

app.get('/proxy/*', async (req, res, next) => {
  const fileUrl = req.url.slice(7); 
  try {
    const fileContent = await downloadFile(fileUrl);
    res.send(fileContent);
  } catch (error) {
    next(); 
  }
});

app.get('/fetch', async (req, res) => {
  try {
    let websiteUrl = req.query.url;
    if (!websiteUrl) {
      return res.status(400).send('URL parameter is required');
    }
    websiteUrl = decodeUrl(websiteUrl);
    if (!websiteUrl.startsWith('/proxy/')) {
      websiteUrl = '/proxy/' + (websiteUrl.startsWith('http') ? websiteUrl : 'http://' + websiteUrl);
    }

    const { content, finalUrl } = await fetchWebsiteData(websiteUrl);
    res.send({ content, finalUrl });
  } catch (error) {
    res.status(500).send('Error fetching website data: ' + error.message);
  }
});

const httpServer = http.createServer(app);
httpServer.listen(HOST_PORT, '0.0.0.0', () => {
  console.log(`HTTP Server Running On Port: ${HOST_PORT}`);
});

httpServer.on('upgrade', unblocker.onUpgrade);
