
var fs = require('fs'),
    handlebars = require('handlebars'),
    log = require('log'),
    mime = require('mime'),
    path = require('path'),
    static = require('node-static'),
    url = require('url'),
    wrench = require('wrench'),
    yaml = require('yaml');

var logger = new log('info');

Object.defineProperty(Object.prototype, "extend", {
  enumerable: false,
  value: function(from) {
    var props = Object.getOwnPropertyNames(from);
    var dest = this;
    props.forEach(function(name) {
      var destination = Object.getOwnPropertyDescriptor(from, name);
      Object.defineProperty(dest, name, destination);
    });
    return this;
  }
});


var StaticRenderer = function(site) { 
  this.site = site;
}

StaticRenderer.prototype = {
  canRender: function(loc) {
    return true; // static can render anything
  },
  
  toOutPath: function(loc) {
    return loc;
  },
  
  render: function(loc, cb) {
    fs.readFile(loc, cb);
  }
}


var TemplateRenderer = function(site) {
  var that = this;
  this.site = site;
  
  var layoutDir = path.resolve(site.dir, site.config.layouts);
  logger.debug("Loading layouts from " + layoutDir);
  
  if (!fs.existsSync(layoutDir) ||
      !fs.statSync(layoutDir).isDirectory())
  {
    logger.error("Specified layout path '" + layoutDir + "' is not a directory");
    return;
  }
  
  this.templates = {};
  var processDir = function(dir) {
    var subFiles = fs.readdirSync(dir);
    subFiles.forEach(function(file) {
      var fullPath = path.resolve(dir, file);
      if (fs.statSync(fullPath).isDirectory())
        processDir(fullPath);
      else {
        var parts = that.openAndSplit(fullPath);
        if (!parts) {
          logger.error("Layout '" + fullPath + "' is missing yaml front matter");
          return;
        }
        var ext = path.extname(file);
        var relPath = path.relative(layoutDir, path.resolve(dir, path.basename(file, ext)));
        logger.debug("Found template '" + relPath + "'");
        try {
          var template = handlebars.compile(parts[1]);
          that.templates[relPath] = [ parts[0], template];
        }
        catch (ex) {
          logger.error("Failed to compile template " + relPath + " error " + ex);
        }
      }
    });
  }
  processDir(layoutDir);
}

TemplateRenderer.prototype = {  
  openAndSplit: function(loc) {
    var data = fs.readFileSync(loc).toString();
    var parts = data.split("---\n\n", 2);
    if (parts.length < 2)
      return false;
    if (parts[0] === "---\n")
      parts[0] = {};
    else {
      try {
        parts[0] = yaml.eval(parts[0]);
      }
      catch (ex) {
        logger.error("Failed to parse yaml for " + loc + " with error " + ex);
        parts[0] = {};
      }
    }
    return parts;
  },
  
  canRender: function(loc) {
    var parts = this.openAndSplit(loc);
    if (!parts)
      return false;
    var meta = parts[0];
    if (!meta)
      return false;
      
    // if the file has yaml then we can process it
    return true;
  },
  
  toOutPath: function(loc) {
    return loc;
  },
  
  renderTemplate: function(meta, layout, cb) {
    var entry = this.templates[layout];
    if (!entry) {
      cb("Failed to find layout " + layout);
      return false;
    }
    
    var templateMeta = entry[0];
    var template = entry[1];
    
    var templateLayout = templateMeta.layout;
    var newMeta = {};
    newMeta.extend(templateMeta);
    newMeta.extend(meta);
    
    var result = template(newMeta);
    newMeta.content = result;
    
    
    if (templateLayout) {
      logger.debug("Layout '" + layout + "' has parent layout '" + templateLayout +"'");
      return this.renderTemplate(newMeta, templateLayout, cb);
    }

    cb(null, result);
  },
  
  render: function(loc, cb) {
    var parts = this.openAndSplit(loc);
    if (!parts) {
      cb("Failed to find meta");
      return false;
    }
    var meta = parts[0];
    if (!meta) {
      cb("Failed to parse meta");
      return false;
    }
    
    meta.layout = meta.layout || "default";
    meta.content = parts[1];
    
    return this.renderTemplate(meta, meta.layout, cb);
  }
}


var File = function(site, loc, renderer) {
  this.site = site;
  this.loc = loc;
  this.renderer = renderer;
  this.outPath = renderer.toOutPath(loc);
}

File.prototype = {
  render: function(cb) {
    this.renderer.render(this.loc, cb);
  },
  
  renderToFile: function() {
    var that = this;
    that.renderer.render(that.loc, function(err, data) {
      if (err) {
        logger.error(err);
        return;
      }
      // now we have data make output dir and file
      var localPath = path.relative(that.site.dir, that.loc);
      var outPath = path.join(that.site.publicDir, that.renderer.toOutPath(localPath));
      var dir = path.dirname(outPath);
      wrench.mkdirSyncRecursive(dir, 0777);
      logger.debug("Writing file '" + outPath + "'");
      fs.writeFile(outPath, data, function(err) {
        if (err) logger.error(err);   
      });
      
    });
  }
}

 
var Site = function(config) {
  var that = this;
  this.config = config;
}

Site.prototype = {
  init: function() {
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
      return false;
    }
    
    var publicDirStat = fs.statSync(publicDir);
    if (!publicDirStat || !publicDirStat.isDirectory()) {
      logger.error("Public output directory '" + publicDir + "' is not a directory");
      return false;
    }
    
    // load renderers
    // NOTE: this has to happen in init() because the renders rely on paths
    // calculated above.
    this.renderers = {'template':new TemplateRenderer(this),
                    'static':new StaticRenderer(this)
                    }
    
    // find files
    this.files = {};
    var processDir = function(dir) {
      var subFiles = fs.readdirSync(dir);
      subFiles.forEach(function(file) {
        var fullPath = path.resolve(dir, file);
        if (file.match(/^_/g))
          return;
        if (fs.statSync(fullPath).isDirectory())
          processDir(fullPath);
        else {
          var renderer = that.findRenderer(fullPath);
          if (!renderer) {
            logger.error("Failed to find renderer for '" + fullPath + "'");
            return;
          }
          logger.debug("Found file '" + fullPath + "'");
          var file = new File(that, fullPath, renderer);
          that.files[file.outPath] = file;
        }
      });
    }
    processDir(this.dir);
    
    return true;
  },
  
  findRenderer: function(loc) {
    for (name in this.renderers) {
      var renderer = this.renderers[name];
      if (renderer.canRender(loc)) {
        logger.debug("Selected renderer '" + name + "' for file '" + loc + "'");
        return renderer;
      }
    }
    return false;
  },
  
  render: function(src, cb) {
    var file = this.files[src];
    if (file)
      file.render(cb);
  },
  
  renderToFile: function(src) {
    var file = this.files[src];
    if (file)
      file.renderToFile();
  },
  
  renderAllToFile: function() {
    for (file in this.files)
      this.renderToFile(file);
  }
}

function makeSite(config) {
  // returns a new site instance
  var site = new Site(config);
  return site.init() ? site : null;
}

function SiteServer(site) {
  this.site = site;
}

SiteServer.prototype = {
  serve: function(req, rep) {
    var pathname = decodeURI(url.parse(req.url).pathname);
    var resPath = path.resolve(path.join(this.site.dir, pathname));
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
    
    if (this.site.files[resPath]) {
      // file exists, render
      return this.site.render(resPath, cb);
    }
    else if (this.site.files[path.join(resPath, "index.html")]) {
      resPath = path.join(resPath, "index.html"); 
      return this.site.render(resPath, cb);
    }
    
    cb("Not found");
  }
}

exports.version = "0.0.1";

exports.setLogLevel = function(level) {
  logger = new log(level);
}

exports.generate = function(config) {
  var site = makeSite(config);
  if (site == null)
    return;
    
  site.renderAllToFile();
}

exports.live = function(config) {
  var site = makeSite(config);
  if (site == null)
    return;
    
  logger.info("Serving live site on port " + config.port + " from src " + site.dir);
  var server = new SiteServer(site);
  require('http').createServer(function (request, response) {
    request.addListener('end', function () {
      server.serve(request, response);
    });
  }).listen(config.port);
}

exports.serve = function(config) {
  var site = makeSite(config);
  if (site == null)
    return;
    
  logger.info("Serving site on port " + config.port + " from dir " + site.publicDir);
  var file = new static.Server(site.publicDir);
  require('http').createServer(function (request, response) {
    request.addListener('end', function () {
      file.serve(request, response);
    });
  }).listen(config.port);
    
}
