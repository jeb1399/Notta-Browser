const express = require('express');
const Unblocker = require('unblocker');
const url = require('url');
const http = require('http');
const https = require('https');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const UserAgent = require('user-agents');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;

const agent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120, useClones: false });
const fileCache = new NodeCache({ stdTTL: 3600, checkperiod: 600, useClones: false });
const HOST_PORT = 8000;

function decodeUrl(encodedUrl) {
  return decodeURIComponent(encodedUrl.replace(/\+/g, ' '));
}

async function downloadFile(fileUrl) {
  const cacheKey = `file:${fileUrl}`;
  const cachedFile = fileCache.get(cacheKey);
  if (cachedFile) return cachedFile;
  return new Promise((resolve, reject) => {
    try {
      const protocol = fileUrl.startsWith('https') ? https : http;
      const options = { agent, timeout: 15000 };
      const req = protocol.get(fileUrl, options, (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const data = Buffer.concat(chunks);
            fileCache.set(cacheKey, data);
            resolve(data);
          });
        } else if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          downloadFile(url.resolve(fileUrl, response.headers.location)).then(resolve).catch(reject);
        } else {
          reject(new Error(`Failed to download file: ${fileUrl} (Status ${response.statusCode})`));
        }
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function downloadAllFiles(baseUrl, html) {
  const $ = cheerio.load(html);
  const filesToDownload = new Set();
  $('script[src], link[href], img[src], source[src]').each((_, elem) => {
    const src = $(elem).attr('src') || $(elem).attr('href');
    if (src && !src.startsWith('data:') && !src.startsWith('http')) {
      const absoluteUrl = url.resolve(baseUrl, src);
      filesToDownload.add(absoluteUrl);
    }
  });
  const downloads = [];
  for (const fileUrl of filesToDownload) {
    downloads.push(downloadFile(fileUrl).catch(() => null));
  }
  await Promise.all(downloads);
}

function normalizeProxyUrl(u) {
  if (!u) return u;
  while (/^https?:\/\/[^/]+\/proxy\//i.test(u)) {
    u = u.replace(/^https?:\/\/[^/]+\/proxy\//i, '');
  }
  if (!u.startsWith('/proxy/')) {
    if (/^https?:\/\//i.test(u)) return '/proxy/' + u;
    return '/proxy/' + u.replace(/^\/+/, '');
  }
  return u;
}

function wrapUrl(u, baseUrl = '') {
  if (!u) return u;

  u = normalizeProxyUrl(u);

  if (u.startsWith('/proxy/')) return u;

  if (/^https?:\/\//i.test(u)) return '/proxy/' + u;

  try {
    const parsedBase = new URL(baseUrl);
    if (u.startsWith('//')) {
      return '/proxy:' + parsedBase.protocol + u.slice(2);
    }
    if (u.startsWith('/')) {
      return '/proxy/' + parsedBase.origin + u;
    }
    return '/proxy/' + url.resolve(baseUrl, u);
  } catch (e) {
    return '/proxy/' + u;
  }
}

function handleRedirects(res, targetUrl) {
  const location = res.headers.location;
  if (location) {
    res.headers.location = wrapUrl(location, targetUrl);
  }
}

function sanitizeQueryLinks(u) {
  try {
    const decoded = decodeURIComponent(u);
    if (decoded.includes('/proxy/')) {
      return decoded.replace(/\/proxy\//g, '');
    }
  } catch (e) {}
  return u;
}

async function modifyHtml(data) {
  if (data.url && data.url.includes('recaptcha__en.js')) {
    // Intercept and replace recaptcha__en.js with always-successful mock
    data.statusCode = 200;
    data.headers['content-type'] = 'application/javascript';
    data.body = `var grecaptcha = (function() {
      return {
        ready: function(callback) {
          if (typeof callback === 'function') {
            callback();
          }
        },
        execute: function(siteKey, options) {
          return new Promise(function(resolve) {
            resolve('mock-success-token');
          });
        },
        render: function(container, params) {
          return 1;
        },
        reset: function(widgetId) {},
        getResponse: function(widgetId) {
          return 'mock-success-token';
        },
      };
    })();`;
    data.stream = null;
    return data;
  }

  if (data.contentType && data.contentType.includes('text/html') && data.content) {
    let content = Buffer.isBuffer(data.content) ? data.content.toString() : data.content;
    const $ = cheerio.load(content);

    $('meta[http-equiv="Content-Security-Policy"]').remove();

    $('meta[http-equiv="refresh"]').each(function () {
      const meta = $(this);
      const contentAttr = meta.attr('content');
      if (contentAttr) {
        meta.attr('content', contentAttr.replace(/url=(.+)/i, (_, urlPart) => `url=/proxy/${url.resolve(data.url, urlPart)}`));
      }
    });

    $('a, link, script, img, iframe, form, source').each(function () {
      const elem = $(this);
      ['href', 'src', 'action'].forEach((attr) => {
        if (elem.attr(attr)) {
          let originalUrl = elem.attr(attr);
          originalUrl = sanitizeQueryLinks(originalUrl);
          if (
            !originalUrl.startsWith('/proxy/') &&
            !originalUrl.startsWith('javascript:') &&
            !originalUrl.startsWith('data:')
          ) {
            if (originalUrl.startsWith('http')) {
              elem.attr(attr, '/proxy/' + originalUrl);
            } else {
              elem.attr(attr, '/proxy/' + url.resolve(data.url, originalUrl));
            }
          } else if (originalUrl.includes('%2Fproxy%2F')) {
            elem.attr(attr, decodeURIComponent(originalUrl).replace('/proxy/', ''));
          }
        }
      });
    });

    if (!$('base').length) {
      let baseUrl = data.url;
      if (/tiktok\.com/.test(baseUrl) && !/^https?:\/\//.test(baseUrl)) {
        baseUrl = 'https://www.tiktok.com';
      } else {
        const parsed = new URL(data.url);
        baseUrl = parsed.origin;
      }
      $('head').prepend(`<base href="${baseUrl}/">`);
    }

    $('body').append(`<script>
    (function() {
      function wrapUrl(u) {
        if (!u) return u;
        if (u.startsWith('/proxy/')) return u;
        if (/^https?:\/\//i.test(u)) return '/proxy/' + u;
        return '/proxy/' + u.replace(/^\/+/, '');
      }

      const origFetch = window.fetch;
      window.fetch = function(resource, init) {
        if (typeof resource === 'string') resource = wrapUrl(resource);
        return origFetch(resource, init);
      };

      const origXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        url = wrapUrl(url);
        return origXhrOpen.call(this, method, url, ...args);
      };

      const origOpen = window.open;
      window.open = function(url, ...args) {
        if (url) url = wrapUrl(url);
        return origOpen.call(this, url, ...args);
      };

      history.pushState = ((orig) => (state, title, url) =>
        orig.call(history, state, title, wrapUrl(url))
      )(history.pushState);

      history.replaceState = ((orig) => (state, title, url) =>
        orig.call(history, state, title, wrapUrl(url))
      )(history.replaceState);
    })();
    </script>`);

    data.content = $.html();
    await downloadAllFiles(data.url, data.content);
  }

  if (!data.headers) data.headers = {};
  data.headers['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";
  data.headers['X-Frame-Options'] = 'ALLOWALL';
  data.headers['Access-Control-Allow-Origin'] = '*';
  return data;
}

app.use((req, res, next) => {
  req.headers['x-forwarded-for'] = '0.0.0.0';
  req.headers['via'] = '0.0.0.0';
  req.headers['forwarded'] = 'for=0.0.0.0;proto=http;by=0.0.0.0';
  req.headers['client-ip'] = '0.0.0.0';
  req.headers['remote-addr'] = '0.0.0.0';

  if (req.connection) req.connection.remoteAddress = '0.0.0.0';
  if (req.socket) req.socket.remoteAddress = '0.0.0.0';
  if (req.connection && req.connection.socket)
    req.connection.socket.remoteAddress = '0.0.0.0';

  next();
});

async function findProxyServer() {
  const proxyServerLists = [
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&limit=2000',
    'https://github.com/hw630590/free-proxy-list/raw/refs/heads/main/proxies/http/http.txt',
    'https://github.com/TheSpeedX/PROXY-List/raw/refs/heads/master/http.txt',
  ];
  const randomIndex = Math.floor(Math.random() * proxyServerLists.length);
  const proxyServerList = await fetch(proxyServerLists[randomIndex], { agent }).then(response => response.text());
  const proxyServers = proxyServerList.split('\n').map(proxy => proxy.trim()).filter(Boolean);
  const randomProxyIndex = Math.floor(Math.random() * proxyServers.length);
  return proxyServers[randomProxyIndex];
}

async function fetchWebsiteData(websiteUrl) {
  const cacheKey = websiteUrl;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;
  if (!websiteUrl.startsWith('/proxy/')) {
    throw new Error('URL must start with /proxy/');
  }
  const actualUrl = websiteUrl.substring(7);

  const proxyServer = await findProxyServer();

  const browser = await puppeteerExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--blink-settings=imagesEnabled=false',
      '--disable-blink-features=AutomationControlled',
      ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    ],
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const userAgent = new UserAgent();
  await page.setUserAgent(userAgent.toString());
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  });
  await page.setJavaScriptEnabled(true);
  await page.setViewport({ width: 1366, height: 768 });
  await page.waitForTimeout(1000 + Math.random() * 2000);

  try {
    await page.goto(actualUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const finalUrl = page.url();
    const content = await page.content();
    await browser.close();
    const data = { content, url: finalUrl };
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function removeIpHeaders(data) {
  if (data.headers) {
    delete data.headers['x-forwarded-for'];
    delete data.headers['via'];
    delete data.headers['forwarded'];
    delete data.headers['client-ip'];
    delete data.headers['remote-addr'];
    data.headers['x-forwarded-for'] = '0.0.0.0';
    data.headers['via'] = '0.0.0.0';
    data.headers['forwarded'] = 'for=0.0.0.0;proto=http;by=0.0.0.0';
    data.headers['client-ip'] = '0.0.0.0';
    data.headers['remote-addr'] = '0.0.0.0';
  }
  return data;
}

const unblocker = new Unblocker({
  prefix: '/proxy/',
  responseMiddleware: [handleRedirects, modifyHtml, removeIpHeaders],
});
app.use(unblocker);
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'resources', 'index.html'));
});

app.get('/proxy/*', async (req, res, next) => {
  const fileUrl = decodeUrl(req.url.slice(7));
  try {
    const fileContent = await downloadFile(fileUrl);
    res.setHeader('Content-Type', require('mime-types').lookup(fileUrl) || 'application/octet-stream');
    res.send(fileContent);
  } catch (error) {
    next();
  }
});

app.get('/fetch', async (req, res) => {
  try {
    let websiteUrl = req.query.url;
    if (/google\.com\/recaptcha/.test(websiteUrl)) {
      // Instead of proxying the recaptcha js, redirect to real to avoid complications
      return res.redirect(websiteUrl.replace(/^\/proxy\//, ''));
    }
    if (!websiteUrl) {
      return res.status(400).send('URL parameter is required');
    }
    websiteUrl = decodeUrl(websiteUrl);
    if (!websiteUrl.startsWith('/proxy/')) {
      websiteUrl = '/proxy/' + (websiteUrl.startsWith('http') ? websiteUrl : 'http://' + websiteUrl);
    }
    const data = await fetchWebsiteData(websiteUrl);
    res.send(data);
  } catch (error) {
    res.status(500).send('Error fetching website data: ' + error.message);
  }
});

app.all('*', async (req, res) => {
  const reqFile = req.path.slice(1);
  const filePath = path.join(__dirname, 'resources', reqFile);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      res.sendFile(filePath);
    } else {
      res.sendFile(path.join(__dirname, 'resources', '404.html'));
    }
  } catch {
    res.sendFile(path.join(__dirname, 'resources', '404.html'));
  }
});

const httpServer = http.createServer(app);
httpServer.listen(HOST_PORT, '0.0.0.0', () => {
  console.log(`HTTP Server Running On Port: ${HOST_PORT}`);
});
httpServer.on('upgrade', unblocker.onUpgrade);
