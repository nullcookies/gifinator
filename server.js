var Moniker = require('moniker');
var wget = require('wget-improved');
var util = require('util');
var formidable = require('formidable');
var fs = require('fs');
var http = require('http');
var gm = require('gm');
var magick = gm.subClass({imageMagick: true});
var api = require('./api.js');
var chokidar = require('chokidar'); // filesystem events

var seconds = 0;

function normalize_fetch_url(gifurl) {
    var service;
    if (gifurl.indexOf('imgur.com') != -1) {
        service = 'imgur';
    }
    switch (service) {
        case 'imgur':
            var re = /[^\/]*$/g;
            var normalized_url = 'http://i.imgur.com/' + re.exec(gifurl) + '.gif';
            break;
        default:
            normalized_url = gifurl;
    }
    console.log('normalized url is ' + normalized_url);
    return normalized_url;
}

function get_font_size(text) {
    var length = text.length;
    if (length < 18) {
        return 42;
    }
    else if (length < 30) {
        return 26;
    }
    else return 24;
}

// To do:
//   diff file size /tmp/in.gif vs p/out.gif
//   Try to return percent completed
//   We need to be very quick and efficient here
//   since we'll call this once every few seconds
//   while we write to output gif
function get_progress(requrl) {
    var outstats;
    var instats;
    var result = -1;
    var re = /[^\/]*$/g;
    var file = re.exec(requrl) + '.gif';

    // Do we use chokidar or roll our own?
    // A risky question to ask at 38,000 ft
    // after off-by-one red wine refills
    
    // chokidar.watch('p/' + file).on('all', (event, path) => {
    //    console.log('[FS EVENT] ' + event, path);
    // });

    try {
        outstats = fs.statSync('p/' + file);
        var outbytes = outstats.size;
        instats = fs.statSync('/tmp/' + file);
        var inbytes = instats.size;
        var diff = inbytes - outbytes;
        result = diff;
    }
    catch (e) {
        console.error(e);
    }
    return String(result); // -1 is error, anything else is percent completed
}

function get_random_name() {
    var name = Moniker.generator([Moniker.adjective, Moniker.noun]);
    return name.choose();
}

function respond_with_expectation_failed(response) {
    console.log('Responding with HTTP 417 Expectation Failed');
    response.writeHead(417, {
        'Content-Type': 'text/plain'
    });
    response.write('HTTP 417 Expectation Failed.\n' +
                   'We could not fetch the gif from the URL you specified.');
    response.end();
}

function fetch_gif(gifurl, infile, response, callback_magick) {
    var url = normalize_fetch_url(gifurl);
    var options = {};
    try {
        var download = wget.download(url, infile, options);
        download.on('error', function(err) {
            console.log('wget download.on(error) -- ' + err);
            respond_with_expectation_failed(response);
        });
        download.on('start', function(filesize) {
            console.log('Fetching gif to: ' + infile);
            console.log('Download started: ' + filesize);
        });
        download.on('end', function(output) {
            console.log(output);
            callback_magick();
        });
        download.on('progress', function(progress) {
            if (progress == 1) {
                console.log('wget finished: ' + progress);
            }
        });
    }
    catch (e) {
        console.error('wget failed -- catch(e): ' + e);
        respond_with_expectation_failed(response);
    }
}


function do_magick(request, response) {
    var name = get_random_name();
    var infile = '/tmp/' + name + '.gif';
    console.log('infile set to: ' + infile);
    var outfile = 'p/' + name + '.gif';
    console.log('outfile set to: ' + outfile);
    // Make sure output directory exists
    var outdir = 'p';
    if (!fs.existsSync(outdir)) {
        try {
            fs.mkdirSync(outdir);
        }
        catch (e) {
            console.error('Unable to create output directory: ' + e);
        }

    }
    var form = new formidable.IncomingForm();
    form.parse(request, function (err, fields, files) {
        var gifurl = fields.gifurl || 'http://null'; // wget panics if passed undefined as URL
        var pictext = fields.text;
        console.log('Got text from form: ' + pictext);
        fetch_gif(gifurl, infile, response, function () {
            console.log('Calling imagemagick for ' + pictext);
            console.time('magick_took');
            var seconds = (new Date()).getTime()/1000;
            var fontsize = get_font_size(pictext);
            magick(infile)
              .stroke("#000000")
              .fill('#ffffff')
              .font("./impact.ttf", fontsize)
              .dither(false)
              .drawText(0, 0, pictext, 'South')
              .write(outfile, function (err) {
                  if (!err) {
                      console.log('Image processing done.');
                      console.log('outfile: ' + outfile);
                      //redirect_to_outfile(response, name);
                  }
                  else console.log(err);
              });
            ack_request(response, name);
        });
    });
}


function displayForm(response) {
    fs.readFile('form.htm', function (err, data) {
        response.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Length': data.length
        });
        response.write(data);
        response.end();
    });
}

function ack_request(response, name) {
        // Respond with 202 Accepted
        response.writeHead(202, {
            'Location': '/p/' + name + '.gif'
        });
        response.end();
}


function onRequest(request, response) {
    // Serve static file from p/
    if (request.method == 'GET' && request.url.match(/^\/p\/.+/)) {
        console.log('request.url = ' + request.url);
        try {
            var img = fs.readFileSync(request.url.replace('/p/', 'p/'));
            console.timeEnd('magick_took');
            response.writeHead(200, {
                'Content-Type': 'image/gif',
                'X-IMAGEMAGICK-TOOK': ((new Date()).getTime()/1000 - seconds).toFixed(2) + ' seconds'
            });
            response.end(img, 'binary');
        }
        catch (e) {
            displayForm(response);
        }
    }
    // /progress
    else if (request.method == 'GET' && request.url.match(/^\/progress\//)) {
        response.writeHead(200);
        // console.log('Progress.. ' + get_progress(request.url));
        response.write(get_progress(request.url));
        response.end();
    }
    // /api/deployment
    else if (request.method == 'GET' && request.url.match(/^\/api\/deployment/)) {
        response.writeHead(200);
        // Get deployment id (commit at HEAD) and return 200 OK
        api.get_deployment(response);
    }
    else if (request.method == 'GET') {
        displayForm(response);
    }
    else if (request.method == 'HEAD') {
            response.writeHead(200);
            response.end();
    }
    else if (request.method == 'POST') {
        console.log('Got POST');
        do_magick(request, response);
    }
    // Not Implemented
    else if (request.method == 'OPTIONS' ||
             request.method == 'PUT' ||
             request.method == 'DELETE' ||
             request.method == 'TRACE' ||
             request.method == 'CONNECT') {
        console.log('We do not know how to handle ' + request.method);
        response.writeHead(501); // Not Implemented
        response.end();
    }
}

http.createServer(onRequest).listen(process.env.PORT || 3000);
console.log('Listening for requests on port ' + (process.env.PORT || 3000));
