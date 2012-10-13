#!/usr/bin/env node
 
var path     = require('path');
var fs       = require('fs');
var crispy   = require(path.join(path.dirname(fs.realpathSync(__filename)), '../lib/crispy'));

var argv = require('optimist')
  .usage([
      'USAGE: $0 [<directory>]',
      'USAGE: $0 -m live [-p <port>] [<directory>]',
      'USAGE: $0 -m static [-p <port>] [<directory>]',
      '\nstatic site generator']
      .join('\n'))
  .option('port', {
      alias: 'p',
      'default': 8080,
      description: 'TCP port at which the files will be served'
  })
  .option('mode', {
      alias: 'm',
      'default': 'generate',
      description: 'Mode of operation (generate, live, or static)'
  })
  .option('public', {
      'default': './_public',
      description: 'Location for output files'
  })
  .option('layouts', {
      'default': './_layouts',
      description: 'Location for layout files'
  })
  .option('title', {
      'default': 'mysite',
      description: 'Title of the site'
  })
  .option('url', {
      'default': 'http://example.com/',
      description: 'Base url of the site (used mostly for rss stuff)'
  })
  .option('verbose', {
      alias: 'v',
      'default': false,
      description: 'display detailed output',
      boolean: true
  })
  .option('help', {
      alias: 'h',
      description: 'display this help message'
  })
  .argv;
  
if (argv.help){
    require('optimist').showHelp(console.log);
    process.exit(0);
}
  
var dir = argv._[0] || './';
var config = {};
try { config = require(path.join(dir, "_config.json")); }
catch (ex) {}

// extract prefs
config.dir = dir;
config.mode = argv.mode || config.mode;
config.port = argv.port || config.port;
config.public = argv.public || config.public;
config.layouts = argv.layouts || config.layouts;
config.title = argv.title || config.title;
config.description = argv.description || config.description;
config.author = argv.author || config.author;
config.url = argv.url || config.url;

if (argv.verbose)
  crispy.setLogLevel('debug');

if (argv.mode == "generate")
  crispy.generate(config);
else if (argv.mode == "live")
  crispy.live(config);
else if (argv.mode == "static")
  crispy.serve(config);
else
  console.log("'" + argv.mode + "' is not a recognized mode");
