var path = require('path');
var url = require('url');

exports.traceurGet = function(module) {
  require('traceur');
  return $traceurRuntime.ModuleStore.get('traceur@0.0.95/src/' + module);
};

exports.extend = extend;
function extend(a, b) {
  for (var p in b)
    a[p] = b[p];
  return a;
}

exports.dextend = dextend;
function dextend(a, b) {
  for (var p in b) {
    if (!b.hasOwnProperty(p))
      continue;
    var val = b[p];
    if (typeof val === 'object')
      dextend(a[p] = typeof a[p] === 'object' ? a[p] : {}, val);
    else
      a[p] = val;
  }
  return a;
}


var isWin = process.platform.match(/^win/);

exports.fromFileURL = fromFileURL;
function fromFileURL(url) {
  return url.substr(7 + !!isWin).replace(/\//g, path.sep);
}

exports.toFileURL = toFileURL;
function toFileURL(path) {
  return 'file://' + (isWin ? '/' : '') + path.replace(/\\/g, '/');
}

exports.getAlias = getAlias
function getAlias(loader, canonicalName) {
  var pluginIndex = loader.pluginFirst ? canonicalName.indexOf('!') : canonicalName.lastIndexOf('!');
  if (pluginIndex != -1)
    return getAlias(loader, canonicalName.substr(0, pluginIndex)) + '!' + getAlias(loader, canonicalName.substr(pluginIndex + 1));

  if (canonicalName.match(/\#[\:\{\?]/))
    throw new Error('Get alias not implemented for conditional name "' + canonicalName + '". Remove the conditional exclusion, or post a SystemJS Builder bug if needed!');

  var bestAlias;

  function getBestAlias(mapped) {
    return canonicalName.substr(0, mapped.length) == mapped
        && (canonicalName.length == mapped.length || canonicalName[mapped.length + 1] == '/');
  }

  Object.keys(loader.map).forEach(function(alias) {
    if (getBestAlias(loader.map[alias]))
      bestAlias = alias;
  });

  if (bestAlias)
    return bestAlias;

  return canonicalName;
}

exports.verifyTree = verifyTree;
function verifyTree(tree) {
  if (typeof tree != 'object' || tree instanceof Array)
    throw new TypeError('Expected a trace tree object');

  Object.keys(tree).forEach(function(key) {
    var load = tree[key];
    if (typeof load === 'boolean')
      return;
    if (load && typeof load != 'object' || !load.name || !(load.conditional || load.deps))
      throw new TypeError('Expected a trace tree object, but "' + key + '" is not a load record.');
  });
}

exports.getCanonicalName = getCanonicalName;
function getCanonicalName(loader, normalized, isPlugin) {
  // 1. Boolean conditional
  var booleanIndex = normalized.lastIndexOf('#?');
  if (booleanIndex != -1) {
    var booleanModule = normalized.substr(booleanIndex + 2);
    var negate = booleanModule[0] == '~';
    if (negate)
      booleanModule = booleanModule.substr(1);
    return getCanonicalName(loader, normalized.substr(0, booleanIndex)) + '#?' + (negate ? '~' : '') + canonicalizeCondition(loader, booleanModule);
  }

  // 2. Plugins
  var pluginIndex = loader.pluginFirst ? normalized.indexOf('!') : normalized.lastIndexOf('!');
  if (pluginIndex != -1)
    return getCanonicalName(loader, normalized.substr(0, pluginIndex), !loader.pluginFirst) + '!' + getCanonicalName(loader, normalized.substr(pluginIndex + 1), loader.pluginFirst);

  // 3. Package environment map
  var pkgEnvIndex = normalized.indexOf('/#:');
  if (pkgEnvIndex != -1)
    return getCanonicalName(loader, normalized.substr(0, pkgEnvIndex), isPlugin) + '/#:' + normalized.substr(pkgEnvIndex + 3);

  // Finally get canonical plain
  var canonical = getCanonicalNamePlain(loader, normalized, isPlugin);

  // 4. Canonicalize conditional interpolation
  var conditionalMatch = canonical.match(interpolationRegEx);
  if (conditionalMatch)
    return getCanonicalNamePlain(loader, normalized, isPlugin).replace(interpolationRegEx, '#{' + canonicalizeCondition(loader, conditionalMatch[0].substr(2, conditionalMatch[0].length - 3)) + '}');

  return canonical;
}

// calculate the canonical name of the normalized module
// unwraps loader syntaxes to derive component parts
var interpolationRegEx = /#\{[^\}]+\}/;
function canonicalizeCondition(loader, conditionModule) {
  var conditionExport;
  var exportIndex = conditionModule.lastIndexOf('|');
  if (exportIndex != -1) {
    conditionExport = conditionModule.substr(exportIndex + 1)
    conditionModule = conditionModule.substr(0, exportIndex) || '@system-env';
  }
  return getCanonicalName(loader, conditionModule) + (conditionExport ? '|' + conditionExport : '');
}

// syntax-free getCanonicalName
// just reverse-applies paths and defulatJSExtension to determine the canonical
function getCanonicalNamePlain(loader, normalized, isPlugin) {
  // now just reverse apply paths rules to get canonical name
  var pathMatch;

  // first check exact path matches
  for (var p in loader.paths) {
    if (loader.paths[p].indexOf('*') != -1)
      continue;

    var curPath = normalizePath(loader, p, isPlugin);

    if (normalized === curPath) {
      // always stop on first exact match
      pathMatch = p;
      break;
    }
  }

  // then wildcard matches
  var pathMatchLength = 0;
  var curMatchLength;
  if (!pathMatch)
    for (var p in loader.paths) {
      if (loader.paths[p].indexOf('*') == -1)
        continue;

      // normalize the output path
      var curPath = normalizePath(loader, p, isPlugin);

      // do reverse match
      var wIndex = curPath.indexOf('*');
      if (normalized.substr(0, wIndex) === curPath.substr(0, wIndex)
        && normalized.substr(normalized.length - curPath.length + wIndex + 1) === curPath.substr(wIndex + 1)) {
        curMatchLength = curPath.split('/').length;
        if (curMatchLength >= pathMatchLength) {
          pathMatch = p.replace('*', normalized.substr(wIndex, normalized.length - curPath.length + 1));
          pathMatchLength = curMatchLength;
        }
      }
    }

  // when no path was matched, act like the standard rule is *: baseURL/*
  if (!pathMatch) {
    if (normalized.substr(0, loader.baseURL.length) == loader.baseURL)
      pathMatch = normalized.substr(loader.baseURL.length);
    else if (normalized.match(absURLRegEx))
      throw new Error('Unable to calculate canonical name to bundle ' + normalized);
    else
      pathMatch = normalized;
  }

  return pathMatch;
}

exports.getPackageConfigPath = getPackageConfigPath;

// check if the given normalized name matches a packageConfigPath
// if so, loads the config
var packageConfigPaths = {};

// data object for quick checks against package paths
function createPkgConfigPathObj(path) {
  var lastWildcard = path.lastIndexOf('*');
  var length = Math.max(lastWildcard + 1, path.lastIndexOf('/'));
  return {
    length: length,
    // NB handle regex control character escapes or simply create a test function here
    regEx: new RegExp('^(' + path.substr(0, length).replace(/\*/g, '[^\\/]+') + ')(\\/|$)'),
    wildcard: lastWildcard != -1
  };
}

// most specific match wins
function getPackageConfigPath(packageConfigPaths, normalized) {
  var pkgName, exactMatch = false, configPath;
  for (var i = 0; i < packageConfigPaths.length; i++) {
    var packageConfigPath = packageConfigPaths[i];
    var p = packageConfigPaths[packageConfigPath] || (packageConfigPaths[packageConfigPath] = createPkgConfigPathObj(packageConfigPath));
    if (normalized.length < p.length)
      continue;
    var match = normalized.match(p.regEx);
    if (match && (!pkgName || (!(exactMatch && p.wildcard) && pkgName.length < match[1].length))) {
      pkgName = match[1];
      exactMatch = !p.wildcard;
      configPath = pkgName + packageConfigPath.substr(p.length);
    }
  }

  if (!pkgName)
    return;

  // return value is only part modified from SystemJS implementation of getPackageConfigMatch
  return configPath;
}

exports.getPackage = getPackage;
function getPackage(packages, name) {
  // use most specific package
  var curPkg, curPkgLen = 0, pkgLen;
  for (var p in packages) {
    if (name.substr(0, p.length) === p && (name.length === p.length || name[p.length] === '/')) {
      pkgLen = p.split('/').length;
      if (pkgLen > curPkgLen) {
        curPkg = p;
        curPkgLen = pkgLen;
      }
    }
  }
  return curPkg;
}

var absURLRegEx = /^[^\/]+:\/\//;
function normalizePath(loader, path, isPlugin) {
  var curPath;
  if (loader.paths[path][0] == '.')
    curPath = decodeURI(url.resolve(toFileURL(process.cwd()) + '/', loader.paths[path]));
  else
    curPath = decodeURI(url.resolve(loader.baseURL, loader.paths[path]));
  if (loader.defaultJSExtensions && !isPlugin && curPath.substr(curPath.length - 3, 3) != '.js')
    curPath += '.js';
  return curPath;
}


