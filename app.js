const express = require('express');
const Unblocker = require('unblocker');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const UserAgent = require('user-agents');
const app = express();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

function decodeUrl(encodedUrl) {
  return decodeURIComponent(encodedUrl.replace(/\+/g, ' '));
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

    $('a, link, script, img, iframe').each(function() {
      const elem = $(this);
      ['href', 'src'].forEach(attr => {
        if (elem.attr(attr)) {
          elem.attr(attr, '/proxy/' + url.resolve(data.url, elem.attr(attr)));
        }
      });
    });

    if (!$('base').length) {
      $('head').prepend(`<base href="${data.url}">`);
    }

    data.content = $.html();
  }

  if (!data.headers) {
    data.headers = {};
  }
  data.headers['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";

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
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const userAgent = new UserAgent();
  await page.setUserAgent(userAgent.toString());

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/\*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br'
  });

  await page.setJavaScriptEnabled(true);
  await page.setViewport({ width: 1366, height: 768 });

  try {
    await page.goto(websiteUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2000)));
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
  if (req.secure) {
    return res.redirect('http://' + req.headers.host + req.url);
  }
  next();
});

app.get('/', async (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/home', async (req, res) => res.sendFile(__dirname + '/homepage.html'));
app.get('/robots.txt', async (req, res) => res.sendFile(__dirname + '/robots.txt'));
app.get('/settings', async (req, res) => res.sendFile(__dirname + '/settings.html'));

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
httpServer.listen(80, () => {
  console.log("HTTP Server Running On Port: 80");
});

httpServer.on('upgrade', unblocker.onUpgrade);
