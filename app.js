var express = require('express');
var Unblocker = require('unblocker');
var path = require('path');
var fs = require('fs');
var dns = require('dns');
var app = express();
dns.setServers(['45.90.28.82', '45.90.30.82']);
var unblocker = new Unblocker({
    prefix: '/proxy/',
    requestMiddleware: [
        function(data, next) {
            var filePath = path.join(__dirname, 'public', data.url.replace('/proxy/', ''));
            fs.access(filePath, fs.constants.F_OK, (err) => {
                if (!err) {
                    data.clientResponse.sendFile(filePath);
                } else {
                    if (!data.url.startsWith('http')) {
                        data.url = data.clientRequest.headers.referer + data.url;
                    }
                    next();
                }
            });
        }
    ],
    responseMiddleware: [
        function(data, next) {
            if (data.contentType === 'text/html') {
                data.stream = data.stream.replace(
                    /(href|src|action)=("|')(?!http:\/\/|https:\/\/|\/\/|data:|#)(.*?)("|')/g,
                    '$1=$2/proxy/$3$4'
                );
            }
            next();
        }
    ]
});
app.use(unblocker);
app.use(express.static('public'));
app.get('/', function(req, res) {res.sendFile(__dirname + '/index.html');});
app.get('/robots.txt', function(req, res) {res.sendFile(__dirname + '/robots.txt');});
app.listen(process.env.PORT || 8080).on('upgrade', unblocker.onUpgrade);
console.log("Node Unblocker Server Running On Port:", process.env.PORT || 8080);
