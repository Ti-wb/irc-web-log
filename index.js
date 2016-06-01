require('coffee-script/register')

var http = require('http');
var path = require('path');

var basicAuth = require('basic-auth-connect');
var bodyParser = require('body-parser')
var range = require('express-range');
var socketio = require('socket.io');
var express = require('express');
var Q = require('q');
var mongoose = require('mongoose');
    mongoose.Promise = Q .Promise;

var deepPopulate = require('mongoose-deep-populate')(mongoose);
var parseRange = require('range-parser');

var Grid = require('gridfs-stream')
var moment = require('moment');
var mubsub = require('mubsub');
var convert = require('./convert');
var mime = require('mime');

var config = require('./config')
//
// ## SimpleServer `SimpleServer(obj)`
//
// Creates a new instance of SimpleServer with the following options:
//  * `port` - The HTTP port to listen on. If `process.env.PORT` is set, _it overrides this value_.
//
var router = express();
var server = http.createServer(router);
var io = socketio.listen(server);

router.use(range({
  accept: 'bytes',
  limit: 10,
}));
router.use(bodyParser.urlencoded({ extended: false }));

router.locals.moment = moment;
router.locals.globalConfig = config;
router.locals.escapeHTML = require("./lib/escape_html.js");
router.locals.parseColor = require("./lib/parse_irc_color.js");
router.locals.getColor = require("./lib/get_color.js");

mongoose.connect(config.dbpath);

var db = mongoose.connection;
db.on('error', onDbConnect.bind(null));
db.once('open', onDbConnect.bind(null, null));

var Message = null;
var Media = null;
var File = null;
var gfs = null;
//console.log(config.dbpath, config.collectionName + 'Trigger');
var MessageChannel = mubsub(config.dbpath).channel(config.collectionName + 'Trigger');
MessageChannel.subscribe('update', function(message) {
    console.log('channel test', message);
    Message.findOne({
      _id: message.data._id
    }).deepPopulate('medias medias.files')
    .then(function (message) {
      console.log('channel test2', message)
      io.emit('update', { data: message });
    })
    .catch(function (err) {
      console.error(err);
    })
});

function onDbConnect(err, cb) {
  if (err) {
    throw err;
  }
  
  var FileSchema = require("./log_modules/file_schema_factory")(mongoose, 'Files')
  File =  mongoose.model('File', FileSchema)
  var MediaSchema = require("./log_modules/media_schema_factory")(mongoose, 'File', 'Medias')
  MediaSchema.plugin(deepPopulate);
  Media =  mongoose.model('Media', MediaSchema)
  var MessageSchema = require("./log_modules/message_schema_factory")(mongoose, 'Media', 'Messages')
  MessageSchema.plugin(deepPopulate);
  Message =  mongoose.model('Message', MessageSchema)
  
  gfs = Grid(mongoose.connection.db, mongoose.mongo)
  //init server after db connection finished
  server.listen(config.port || 8080, config.ip || "0.0.0.0", function(){
    var addr = server.address();
    console.log("Chat server listening at", addr.address + ":" + addr.port);
  });
}

/* [start] inject some opt to ejs */
;(function () {
  var ejs = require("ejs");
  var old__express = ejs.__express;
  ejs.__express = function (path, data, cb) {
    return old__express.call(this, path, data, {rmWhitespace: true}, cb);
  }
} ());
/* [ end ] inject some opt to ejs  */

router.set('views', path.resolve(__dirname, 'views'));
router.set('view engine', 'ejs');

if (config["minify-html"]) {
  var minifyHTML = require('express-minify-html');
  router.use(minifyHTML({
    override:      true,
    htmlMinifier: {
      removeComments:            true,
      collapseWhitespace:        true,
      collapseBooleanAttributes: true,
      removeAttributeQuotes:     true,
      removeEmptyAttributes:     true,
      minifyJS:                  false
    }
}));
}

router.get('/message/:id/', function(req, res, next) {

  var id = mongoose.Types.ObjectId(req.params.id);
  var query = {
    _id : id
  };
  Message
  .findOne(query)
  .deepPopulate('medias medias.files')
  .exec()
  .then(function (message) {
    if (!message) {
      res.end('not found');
      return;
    }
    
    var maxAge = 86400 * 1000;
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=' + (maxAge / 1000));
    res.render('message', {message : message});
  })
  .catch(function (err) {
    res.status(500).end(err.stack ? err.stack : err.toString());
  })
})
router.get('/channel/:channel/:date/', function (req, res, next) {
  if (!req.params.date.match(/^\d\d\d\d-\d\d-\d\d$/) && req.params.date !== 'today') {
    res.end('unknown date: ' + req.params.date);
    return;
  }
  var isToday = false;
  var start = req.params.date
  if (start === 'today') {
    start = moment().utcOffset(config.timezone).startOf('day').toDate();
    isToday = true;
  } else {
    start = moment(start + ' ' + config.timezone, 'YYYY-MM-DD Z').toDate();
    if (isNaN( start.getTime()) ){
      res.end('unknown date: ' + req.params.date);
      return;
    }
    if (moment(start).add(1, 'days').isAfter(new Date())) {
      res.redirect('/channel/' + req.params.channel + '/today');
      return;
    }
  }
  var query = {};
  var channel = '#' + req.params.channel
  query.to = channel;
  query.time = {
    $gte : start,
    $lt : moment(start).utcOffset(config.timezone).endOf('day').toDate()
  }
  
  Message.find(query)
  .sort({ 'time' : 1})
  .deepPopulate('medias medias.files')
  .exec(function (err, messages) {
    if (err) {
      res.end(err.toString());
      return;
    }
    if (isToday) {
      // don't cache live channel
      res.header('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // cache it, it is actully perminent link
      var maxAge = 86400 * 1000;
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=' + (maxAge / 1000));
    }
    var time = Date.now();
    res.render('channel', {
      messages : messages, 
      channel : channel, 
      isToday : isToday,
      selectedDay : req.params.date,
      query : req.query
    });
    console.log('done render ' + channel + '/' + req.params.date + ' using ' + (Date.now() - time) + ' ms')
  })

})
router.get('/files/:id', function (req, res, next) {
  
  var promise = File.findOne({
    _id: req.params.id
  }).exec()
  promise.then(function (doc) {
    if (doc) {
      res.set('Content-Type', doc.MIME);
      res.set('Content-Length', doc.length);
      var range = req.headers.range ? parseRange(doc.length, req.headers.range) : null;
      if (range === null){
        var readstream = gfs.createReadStream({
          filename: doc.contentSrc,
          root: 'FileContent'
        });
      } else if (range !== -1 && range.type === 'bytes' && range.length === 1) {
        res.set('Content-Length', range[0].end - range[0].start + 1);
        var temp = {};
        if (range[0].start !== 0) {
          temp.startPos = range[0].start;
        }
        if (range[0].end !== doc.length + 1) {
          temp.endPos = range[0].end + 1;
        }
    		res.range({
    			first: range[0].start,
    			last: range[0].end,
    			length: doc.length
    		});
        var readstream = gfs.createReadStream({
          filename: doc.contentSrc,
          root: 'FileContent',
          range: temp
        });
        res.status(206);
      } else {
        res.set('Content-Type', 'text/html');
        res.set('Content-Length', '');
        return res.status(416).end('range not satisfied');
      }
      readstream.on('error', function (err) {
        res.set('Content-Type', 'text/plain');
        res.set('Content-Length', '');
        res.status(500).end(err.stack? err.stack: err.toString());
      })
      if (req.query.convert) {
        convert(readstream, req.params.id, req.query.convert)
        .then(function (path) {
          res.set('Content-Length', '');
          res.set('Content-Type', mime.lookup(path))
          res.sendFile(path)
        })
        .catch(function (err) {
          res.set('Content-Type', 'text/plain');
          res.set('Content-Length', '');
          console.error(err.stack? err.stack: err.toString());
          res.status(500).end(err.stack? err.stack: err.toString());
        })
      } else {
        readstream.pipe(res);
      }
    } else {
      res.status(404).end('file not found');
    }
  }).catch(function (err) {
    res.set('Content-Type', 'text/plain');
    res.set('Content-Length', '');
    console.error(err.stack? err.stack: err.toString());
    res.status(500).end(err.stack? err.stack: err.toString());
  })
})

router.get('/medias/:id', function (req, res, next) {
  Media.findOne({
    _id: req.params.id
  })
  .deepPopulate('files')
  .exec()
  .then(function (doc) {
      if (!doc) return res.status(404).json({error: 'file not found'});
      res.json(doc);
  })
  .catch(function (err) {
    res.status(500).end(err.stack? err.stack: err.toString());
  })
})

router.get('/api/dump/', function (req, res, next) {
  var isStart = true;
  var ended = false;
  var stream = Message.find({})
  .sort({ 'time' : 1})
  .stream()
  .on('data', function (doc) {
    if (ended) return;
    if (isStart) {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.write('[');
      res.write(JSON.stringify(doc));
      isStart = false;
    } else {
      res.write(',');
      res.write(JSON.stringify(doc));
    }
    // do something with the mongoose document
  })
  .on('error', function (err) {
    if (ended) return;
    ended = true;
    res.status(500).end(err.stack ? err.stack : err.toString());
    // handle the error
  }).on('close', function () {
    if (ended) return;
    ended = true;
    res.end(']');
    // the stream is closed
  });
  
  req.on("close", function() {
    console.log('connection aborted')
    try {
      stream.destroy()
    } catch (err) {
      console.error(err)
    }
  });
  
  req.on("end", function() {
    try {
      stream.destroy()
    } catch (err) {
      console.error(err)
    }
  });


  /*
  .exec(function (err, messages) {
    if (err) {
      res.json({ _error : err.toString() });
      return;
    }
    res.json(messages);
  });*/
});

router.get('/', function (req, res, next) {
  res.render('index', {});
});

router.post('/api/admin/delete', basicAuth(config['db-manager-account'], config['db-manager-password']), function (req, res, next) {
  Message.findById(req.body.id)
  .exec()
  .then(function (doc) {
    if (!doc) {
      return res.status(404).json({error: 'file not found'})
    }
    return doc.remove()
  })
  .then(function () {
    res.json({done: true})
  })
  .catch(function (err) {
    return res.status(500).json({error: err.stack || err.toString()})
  })
})
router.post('/api/admin/delete-with-media', basicAuth(config['db-manager-account'], config['db-manager-password']), function (req, res, next) {
  var docToRemoves = [];
  Message.findById(req.body.id)
  .exec()
  .then(function (doc) {
    if (!doc) {
      return res.status(404).json({error: 'file not found'})
    }
    docToRemoves.push(doc)
    return doc;
  })
  .then(function (doc) {
    return Q.all(doc.medias.map(function (id) {
      return Media.findById(id).exec();
    }))
  })
  .then(function (medias) {
    docToRemoves = docToRemoves.concat(medias);
    
    var fileQuerys = medias.map(function (media) {
      return media.files.map(function (id) {
        return File.findById(id).exec();
      })
    })
    fileQuerys = [].concat.apply([], fileQuerys)
    return Q.all(fileQuerys);
  })
  .then(function (files) {
    docToRemoves = docToRemoves.concat(files);
    
    var docToRemovePromise = docToRemoves.map(function (doc) {
      return doc.remove();
    })
    console.log('total model remove: ' + docToRemovePromise.length);
    
    var fileToRemovePromise = files
    .filter(function (file) {
      return file.contentSource === 'db';
    })
    .map(function (file) {
      return gfs.remove({filename: file.contentSrc})
    })
    console.log('total file remove: ' + fileToRemovePromise.length);
    return Q.all(docToRemovePromise.concat(fileToRemovePromise));
  })
  .then(function () {
    res.json({done: true})
  })
  .catch(function (err) {
    return res.status(500).json({error: err.stack || err.toString()})
  });
})


var mongo_express = require('mongo-express/lib/middleware');
var mongo_express_config = require('./mongo_express_config');
(function (mongo_express_config) {
  var URL = require('url');
  var temp = URL.parse(config.dbpath);
  mongo_express_config.mongodb.server = temp.hostname;
  mongo_express_config.mongodb.port = parseInt(temp.port) || 27017;
  if (temp.auth) {
    mongo_express_config.mongodb.auth[0].database = temp.pathname.replace(/^\//, '');
    mongo_express_config.mongodb.auth[0].username = temp.auth.split(':')[0]
    mongo_express_config.mongodb.auth[0].password = decodeURIComponent(temp.auth.split(':').slice(1).join(':'))
  }
   mongo_express_config.basicAuth.username = config["db-manager-account"]
   mongo_express_config.basicAuth.password = config["db-manager-password"]
   
} (mongo_express_config));
if (config["enable-db-manager"]) {
  router.use(config["db-manager-path"], mongo_express(mongo_express_config))
}

router.use(express.static(path.resolve(__dirname, 'public')));
