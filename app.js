const express = require('express');
const Unblocker = require('unblocker');
const url = require('url');
const http = require('http');
const https = require('https');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');
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
  if (data.contentType && data.contentType.includes('text/html')) {
    const $ = cheerio.load(data.content.toString());
    $('a, link, script, img, iframe').each(function() {
      const elem = $(this);
      ['href', 'src'].forEach(attr => {
        if (elem.attr(attr)) {
          elem.attr(attr, '/proxy/' + url.resolve(data.url, elem.attr(attr)));
        }
      });
    });
    data.content = $.html();
  }
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
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(websiteUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        cache.set(cacheKey, data);
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
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
app.use(async (req, res, next) => {
  if (req.protocol === 'https') {
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
    const data = await fetchWebsiteData(websiteUrl);
    res.send(data);
  } catch (error) {
    res.status(500).send('Error fetching website data: ' + error.message);
  }
});

const httpServer = http.createServer(app);

httpServer.listen(process.env.PORT || 8080, () => {
  console.log("HTTP Server Running On Port:", process.env.PORT || 8080);
});

httpServer.on('upgrade', unblocker.onUpgrade);
