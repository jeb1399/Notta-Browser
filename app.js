var express = require('express');
var Unblocker = require('unblocker');
var url = require('url');
var http = require('http');
var app = express();
function handleRedirects(data) {
  if (data.headers && data.headers.location) {
    var location = data.headers.location;
    var parsed = url.parse(location);
    if (parsed.protocol && !location.startsWith(data.url.substr(0, data.url.indexOf('/', 8)))) {
      data.headers.location = '/proxy/' + location;
    }
  }
  return data;
}
function fetchWebsiteData(websiteUrl) {
  return new Promise((resolve, reject) => {
    const protocol = websiteUrl.startsWith('https') ? require('https') : http;
    protocol.get(websiteUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
var unblocker = new Unblocker({
  prefix: '/proxy/',
  responseMiddleware: [
    handleRedirects
  ]
});
app.use(unblocker);
app.use(express.static('public'));
app.use((req, res, next) => {
  if (req.protocol === 'https') {
    return res.redirect('http://' + req.headers.host + req.url);
  }
  next();
});
app.get('/', function(req, res) {res.sendFile(__dirname + '/index.html');});
app.get('/robots.txt', function(req, res) {res.sendFile(__dirname + '/robots.txt');});
app.get('/fetch', async function(req, res) {
  try {
    const websiteUrl = req.query.url;
    if (!websiteUrl) {
      return res.status(400).send('URL parameter is required');
    }
    const data = await fetchWebsiteData(websiteUrl);
    res.send(data);
  } catch (error) {
    res.status(500).send('Error fetching website data');
  }
});
var httpServer = http.createServer(app);
httpServer.listen(process.env.PORT || 8080, () => {console.log("HTTP Server Running On Port:", process.env.PORT || 8080);});
httpServer.on('upgrade', unblocker.onUpgrade);
