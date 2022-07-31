if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

var express = require('express'); // route handlers
var path = require('path'); // populating the path property of the request
var logger = require('morgan'); // HTTP request logging
var responseTime = require('response-time'); // performance logging
var helmet = require('helmet'); // security measures
var rareLimit = require('express-rate-limit'); // IP based rate limiter
var compression = require('compression'); // traffic compression
var users = require('./routes/users');
var session = require('./routes/session');
var sharedNews = require('./routes/sharedNews');
var homeNews = require('./routes/homeNews');

var app = express();
app.enable('trust proxy');
app.use(compression());

const limiter = rareLimit({
  // DDoS attack protection
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 2000, // limit each IP address per window
  delayMs: 0, // disable delaying - full speed until max limit is reached
  message: { message: 'You have exceeded the request limit' },
  standardHeaders: false, // Disable info in the `RateLimit-* headers
  legacyHeaders: false, // Disable the `X-RateLimit-* headers
});

app.use(limiter);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': [
          "'self'",
          "'unsafe-inline'",
          'ajax.googleapis.com',
          'maxcdn.bootstrapcdn.com',
        ],
        'style-src': ["'self'", "'unsafe-inline'", 'maxcdn.bootstrapcdn.com'],
        'font-src': ["'self'", 'maxcdn.bootstrapcdn.com'],
        'img-src': ["'self'", 'https://static01.nyt.com/', 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Adds an X-Response-Time header to responses to measure response times
app.use(responseTime());

// logs all HTTP requests. The "dev" option gives it a specific styling
app.use(logger('dev'));

// Parses a JSON body request payload and provides the 'body' property
app.use(express.json());

const db = {};
const MongoClient = require('mongodb').MongoClient;

//Use connect method to connect to the Server
MongoClient.connect(process.env.MONGODB_CONNECT_URL, { useNewUrlParser: true, useUnifiedTopology: true, minPoolSize: 10, maxPoolSize: 100 }, (err, client) => {
  if (err === undefined || err === null) {
    db.client = client;
    db.collection = client.db('newswatcherdb').collection('NewsWatcher');
    console.log("Connected to MongoDB server");
  } else {
    console.log("Failed to connected to MongoDB server");
    console.log(err);
    process.exit(0);
  }
});

// Set the database connection for middleware usage
app.use((req, res, next) => {
  req.db = db;
  next();
});

// serving of the React app and other static content like images
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'build', 'index.html'))
);

// Serving up of static content such as HTML for the React SPA, images
// CSS files and JS files
app.use(express.static(path.join(__dirname, 'build')));



// Rest API routes
app.use('/api/users', users);
app.use('/api/sessions', session);
app.use('/api/sharednews', sharedNews);
app.use('/api/homenews', homeNews);

// catch everything else and forward to error handler as a 404 to return
app.use((req, res, next) => {
  let err = new Error('Not found');
  err.status = 404;
  next(err);
});

// development error handler that will add in a stack trace
if (app.get('env') === 'development') {
  app.use((err, req, res, next) => {
    if (err.status)
      res.status(err.status).json({
        message: err.toString(),
        error: err,
      });
    else
      res.status(500).json({
        message: err.toString(),
        error: err,
      });
    console.log(err);
  });
}

// production error handler with no stacktraces exposed to users 
app.use((err, req, res, next) => {
  console.log(err);
  if (err.status)
      res.status(err.status).json({
        message: err.toString(),
        error: {},
      });
    else
      res.status(500).json({
        message: err.toString(),
        error: {},
      });
})

app.set('port', process.env.PORT || 3000);

const server = app.listen(app.get('port'), () => {
  console.log('Express server listening on port ' + server.address().port);
});

server.db = db
console.log(`Worker ${process.pid} started`);

module.exports = server