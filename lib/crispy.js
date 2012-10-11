
var done = require('done'),
    fs = require('fs'),
    handlebars = require('handlebars'),
    log = require('log'),
    mime = require('mime'),
    path = require('path'),
    static = require('node-static'),
    url = require('url'),
    yaml = require('yaml');

var logger = new log('info');


// merges all provided objects and returns the result
function merge(objs) { 
  var to = {};
  for (arg in arguments) {
    var from = arguments[arg];
    var props = Object.getOwnPropertyNames(from);
    props.forEach(function(name) {
      var dest = Object.getOwnPropertyDescriptor(from, name);
      Object.defineProperty(to, name, dest);
    });
  }
  return to;
}

// A file resource will emit a data blob with the assigned renderer name
function FileResource(site, type, file) {
  this.site = site;
  this.type = type;
  this.file = file;
  logger.debug("Created file resource at " + file);
}

FileResource.prototype = {
  // cb = function(err, blob)
  render: function(cb) {
    var that = this;
    
    fs.readFile(that.file, function(err, data) {
      if (err) {
        logger.error("Failed to read file at " + that.file);
        return cb(err);
      }
      
      logger.debug("Loaded resource from file " + that.file);
      logger.debug("Render next for type " + that.type);
      that.site.renderNext(that.type, data, cb);
    });
  }
};

// A yaml renderer will emit a dissected file with meta and content as an object
function YamlRenderer(site) {
  this.site = site;
}

YamlRenderer.prototype = {
  // cb = function(err, blob)
  render: function(type, blob, cb) {
    var that = this;
    
    var data = blob.toString();
    var parts = data.split("---\n\n", 2);
    var meta = {};
    var nextType = null;
    
    logger.debug("Yaml for type " + type);
    if (parts.length === 2) {
      if (parts[0] === "---\n") {
        // yaml is blank but the parser will choke if we give it nothing
        meta = {};
      }
      else {
        logger.debug("Looks like there's some yaml to parse");
        try {
          meta = yaml.eval(parts[0]);
          logger.debug("Successfully extracted yaml meta and content");
          if (type === "yaml/partial")
            nextType = null; // stop rendering after this step
          else 
            nextType = meta.renderer || "template";
        }
        catch (ex) {
          logger.error("Failed to parse yaml with error " + ex);
          meta = {};
        }
      }
      
      meta.content = parts[1];
    }
    else
      meta = data; // couldn't parse so our output is the raw data
    
    logger.debug("Yaml complete, next type is " + nextType);
    that.site.renderNext(nextType, meta, cb);
  }
};


function LayoutRenderer(site) {
  this.site = site;
}

LayoutRenderer.prototype = {
  render: function(type, blob, cb) {
    var that = this;
    // blob should be yaml-based meta data
    var layout = blob.layout || "default";
    logger.debug("Layout render loading layout " + layout);
    that.site.render(":layouts:"+layout, function(err, data) {
      if (err) {
        logger.error("Failed to render layout " + layout + " because " + err);
        return;
      }
      
      logger.debug("Got layout from render");
      
      // data should also be yaml-based meta data
      var template = handlebars.compile(data.content);
      
      // render the content
      var content = template(blob);
      
      // merge meta data so that the body takes precedence
      var meta = merge(data, blob); 
      
      // overwrite layout data so the correct one gets called
      meta.layout = data.layout;
      
      // add content
      meta.content = content;
      
      logger.debug("Layout complete");
      
      if (meta.layout)
        that.site.renderNext("template", meta, cb);
      else
        that.site.renderNext(null, meta.content, cb);
    });
  }
};


function FileGenerator(site) {
  this.site = site;
}

FileGenerator.prototype = {
  discover: function(dir, cb) {
    var that = this;
    var root = dir;
    var discoverHelper = function(dir, cb) {
      logger.debug("Discovering at " +  dir);
      done.readdir(dir, function(err, loc, isDir, cb){
        if (err) {
          logger.error(err);
          return;
        }
        
        var file = path.basename(loc);
        if (!file.match(/^_/g)) {
          if (isDir) {
            discoverHelper(loc, function(err) {
              if (err) return err;
              cb();
            });
          }
          else {
            if (!file.match(/^_/g) && !isDir) {
              logger.debug("Discovered file " + file);
              that.site.addResource(path.relative(root, loc), new FileResource(that.site, "yaml", loc));
            }
            cb();
          }
        }
        else
          cb();
      }, cb);
    }
    discoverHelper(dir, cb);
  }
}


function LayoutGenerator(site) {
  this.site = site;
}

LayoutGenerator.prototype = {
  discover: function(dir, cb) {
    var that = this;
    dir = path.join(dir, "_layouts");
    done.readdirRecursive(dir, function(err, loc, isDir, cb){
      if (err) {
        logger.error(err);
        return;
      }

      if (!isDir) {
        var ext = path.extname(loc);
        var basename = path.resolve(dir, path.basename(loc, ext));
        var relPath = path.relative(dir, basename);
        that.site.addResource(":layouts:" + relPath, new FileResource(that.site, "yaml/partial", loc));
      }
      cb();
    }, cb);
  }
}

// manages an entire site 
var Site = function(config) {
  var that = this;
  this.config = config;
}

Site.prototype = {
  init: function(cb) {
    var that = this;
    // returns true if successful
    
    this.dir = path.resolve(this.config.dir);
    this.publicDir = path.resolve(this.dir, this.config.public);
    
    // check public dir
    var publicDir = this.publicDir;
    // wrench.rmdirSyncRecursive(publicDir);
    // wrench.mkdirSyncRecursive(publicDir, 0777);

    if (!fs.existsSync(publicDir)) {
      logger.error("Public output directory '" + publicDir + "' does not exist");
      return cb("Public dir doest not exist");
    }
    
    var publicDirStat = fs.statSync(publicDir);
    if (!publicDirStat || !publicDirStat.isDirectory()) {
      logger.error("Public output directory '" + publicDir + "' is not a directory");
      return cb("Public dir is not a dir");
    }
    
    // load renderers
    this.renderers = {
      'yaml':new YamlRenderer(this),
      'yaml/partial':new YamlRenderer(this),
      'template':new LayoutRenderer(this)
    };
    
    // load generators
    this.generators = [
      new FileGenerator(this),
      new LayoutGenerator(this)
    ];
    
    // find files
    this.resources = {};
    var that = this;
    logger.debug("getting ready to discover at " + that.dir);
    var relPath = path.relative(path.resolve("./"), that.dir);
    var discover = function(i) { 
      logger.debug("Invoking generator " + i);
      if (i === that.generators.length)
        return cb();
      that.generators[i].discover(relPath, function(err) {
        logger.debug("Finised generator " + i);
        if (err) return cb(err); 
        discover(i+1);
      });
    }
    discover(0);
  },
  
  addResource: function(name, resource) {
    logger.debug("Added resource " + name);
    this.resources[name] = resource;
  },
  
  renderNext: function(type, meta, cb) {
    if (type == null)
      return cb(null, meta);
      
    var renderer = this.renderers[type];
    renderer.render(type, meta, cb);
  },
  
  render: function(src, cb) {
    logger.debug("Normal rendering " + src);
    var resource = this.resources[src];
    resource.render(cb);
  },
  
  renderToFile: function(src) {
    logger.debug("File rendering " + src);
    var that = this;
    var resource = this.resources[src];
    resource.render(function(err, data) {
      if (err) {
        logger.err("Failed to render " + src + " with error " + err);
        return;
      }
      
      // now we have data make output dir and file
      var outPath = path.join(that.publicDir, src);
      var dir = path.dirname(outPath);
      done.mkdirRecursive(dir, 0777, null, function(err) {
        if (err) {
          logger.error(err);
          return;
        }
        
        logger.debug("Writing file '" + outPath + "'");
        fs.writeFile(outPath, data, function(err) {
          if (err) logger.error(err);   
        });
      });
    });
  },
  
  renderAllToFile: function() {
    logger.debug("Rendering all files");
    for (resource in this.resources) {
      if (!resource.match(/^:/g)) {
        logger.debug("Preparing to render to file " + resource);
        this.renderToFile(resource);
      }
    }
  }
}


// provides a live server wrapper around a site
function SiteServer(site) {
  this.site = site;
}

SiteServer.prototype = {
  serve: function(req, rep) {
    var pathname = decodeURI(url.parse(req.url).pathname);
    var resPath = path.resolve(path.join(this.site.dir, pathname));
    
    var resPath = path.relative(path.resolve(this.site.dir), resPath);
    logger.info("Rendering '" + resPath + "'");
    
    var cb = function(err, data) {
      if (err || !data) {
        rep.writeHead(404, {});
        rep.end();
      }
      else {
        var mimeType = mime.lookup(resPath) || "text/plain";
        rep.writeHead(200, {"Content-Type": mimeType});
        rep.write(data);
        rep.end();
      }
    }
    
    
    if (this.site.resources[resPath]) {
      // file exists, render
      logger.debug("Live render " + resPath);
      return this.site.render(resPath, cb);
    }
    else if (this.site.resources[path.join(resPath, "index.html")]) {
      resPath = path.join(resPath, "index.html");
      logger.debug("Live render " + resPath); 
      return this.site.render(resPath, cb);
    }
    
    cb("Not found");
  }
}


// exports

exports.version = "0.0.1";

exports.setLogLevel = function(level) {
  logger = new log(level);
}

exports.generate = function(config) {
  var site = new Site(config);
  site.init(function(err) {
    if (err)
      return;
      
    site.renderAllToFile();
  });
}

exports.live = function(config) {
  var site = new Site(config);
  site.init(function(err) {
    if (err)
      return;
      
    logger.info("Serving live site on port " + config.port + " from src " + site.dir);
    var server = new SiteServer(site);
    require('http').createServer(function (request, response) {
      request.addListener('end', function () {
        server.serve(request, response);
      });
    }).listen(config.port);
  });
}

exports.serve = function(config) {
  var site = new Site(config);
  site.init(function(err) {
    if (err)
      return;
      
    logger.info("Serving site on port " + config.port + " from dir " + site.publicDir);
    var file = new static.Server(site.publicDir);
    require('http').createServer(function (request, response) {
      request.addListener('end', function () {
        file.serve(request, response);
      });
    }).listen(config.port);
  });
}
