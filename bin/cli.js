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
  .option('help', {
      alias: 'h',
      description: 'display this help message'
  })
  .argv;
  
if (argv.help){
    require('optimist').showHelp(console.log);
    process.exit(0);
}
  
var dir = argv._[0] || '.';
var config = {};
try { config = require(path.join(dir, "_config.json")); }
catch (ex) {}

// extract prefs
config.dir = dir;
config.mode = argv.mode || config.mode;
config.port = argv.port || config.port;
config.public = argv.public || config.public;
config.layouts = argv.layouts || config.layouts;

if (argv.mode == "generate")
  crispy.generate(config);
else if (argv.mode == "live")
  crispy.live(config);
else if (argv.mode == "static")
  crispy.serve(config);
else
  console.log("'" + argv.mode + "' is not a recognized mode");
