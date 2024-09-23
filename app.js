var express = require('express');
var Unblocker = require('unblocker');
var app = express();
var unblocker = new Unblocker({ prefix: '/proxy/' });
app.use(unblocker);
app.use(express.static('public'));
app.get('/', function(req, res) {res.sendFile(__dirname + '/index.html');});
app.listen(process.env.PORT || 8080).on('upgrade', unblocker.onUpgrade);
console.log("Node Unblocker Server Running On Port:", process.env.PORT || 8080);
