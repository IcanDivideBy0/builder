var getCanonicalName = require('./utils').getCanonicalName;
var glob = require('glob');
var toFileURL = require('./utils').toFileURL;
var fromFileURL = require('./utils').fromFileURL;
var asp = require('bluebird').promisify;
var fs = require('fs');
var path = require('path');
var extend = require('./utils').extend;
var Promise = require('bluebird');
var getPackage = require('./utils').getPackage;
var getPackageConfigPath = require('./utils').getPackageConfigPath;

module.exports = Trace;

function Trace(loader, traceCache) {
  // when creating a new trace, we by default invalidate the freshness of the trace cache
  Object.keys(traceCache).forEach(function(canonical) {
    var load = traceCache[canonical];

    if (load && !load.conditional)
      load.fresh = false;
  });


  this.loader = loader;
  // stored traced load records
  this.loads = traceCache || {};
  // in progress traces
  this.tracing = {};
}

/*
 * High-level functions
 */
var namedRegisterRegEx = /(System\.register(Dynamic)?|define)\(('[^']+'|"[^"]+")/g;
Trace.prototype.traceModule = function(moduleName, traceOpts) {
  var loader = this.loader;

  var self = this;

  return Promise.resolve(loader.normalize(moduleName))
  .then(function(_moduleName) {
    moduleName = getCanonicalName(loader, _moduleName);
    return toCanonicalConditionalEnv.call(self, traceOpts.conditions);
  })
  .then(function(canonicalConditionalEnv) {
    if (!traceOpts.traceConditionsOnly)
      return self.getAllLoadRecords(moduleName, traceOpts.excludeURLs, traceOpts.tracePackageConfig, traceOpts.traceAllConditionals, canonicalConditionalEnv, {}, []);
    else
      return self.getConditionLoadRecords(moduleName, traceOpts.excludeURLs, traceOpts.tracePackageConfig, canonicalConditionalEnv, false, {}, []);
  })
  .then(function(loads) {
    // if it is a bundle, we just use a regex to extract the list of loads
    // as "true" records for subtraction arithmetic use only
    var thisLoad = loads[moduleName];

    if (thisLoad && !thisLoad.conditional && thisLoad.metadata.bundle) {
      namedRegisterRegEx.lastIndex = 0;
      var curMatch;
      while ((curMatch = namedRegisterRegEx.exec(thisLoad.source)))
        loads[curMatch[3].substr(1, curMatch[3].length - 2)] = true;
    }

    return {
      moduleName: moduleName,
      tree: loads
    };
  });
};

function isLoadFresh(load, loader, loads) {
  if (load === undefined)
    return false;

  if (load === false)
    return true;

  if (load.configHash != loader.configHash)
    return false;

  if (load.fresh)
    return true;

  if (load.conditional)
    return false;

  // stat to check freshness
  if (load.plugin) {
    var plugin = loads[load.plugin];
    if (!isLoadFresh(plugin, loader, loads))
      return false;
  }
  try {
    var timestamp = fs.statSync(path.resolve(fromFileURL(loader.baseURL), load.path)).mtime.getTime();
  }
  catch(e) {}
  return load.fresh = timestamp == load.timestamp;
}

/*
 * Low-level functions
 */
// runs the pipeline hooks, returning the load record for a module
Trace.prototype.getLoadRecord = function(canonical, excludeURLs, parentStack) {
  var loader = this.loader;
  var loads = this.loads;

  if (isLoadFresh(loads[canonical], loader, loads))
    return Promise.resolve(loads[canonical]);

  if (this.tracing[canonical])
    return this.tracing[canonical];

  var self = this;
  var isPackageConditional = canonical.indexOf('/#:') != -1;
  return this.tracing[canonical] = Promise.resolve(loader.decanonicalize(canonical))
  .then(function(normalized) {
    // modules already set in the registry are system modules
    if (loader.has(normalized))
      return false;

    // package conditional fallback normalization
    if (!isPackageConditional)
      normalized = normalized.replace('/#:', '/');
    // -- conditional load record creation: sourceless intermediate load record --

    // boolean conditional
    var booleanIndex = canonical.lastIndexOf('#?');
    if (booleanIndex != -1) {
      var condition = canonical.substr(booleanIndex + 2)
      if (condition.indexOf('|') == -1)
        condition += '|default';
      return {
        name: canonical,
        fresh: true,
        conditional: {
          condition: condition,
          branch: canonical.substr(0, booleanIndex)
        }
      };
    }

    // package environment conditional
    // NB handle subpaths as tracked in https://github.com/systemjs/builder/issues/440
    var pkgEnvIndex = canonical.indexOf('/#:');
    if (pkgEnvIndex != -1) {
      // NB handle a package plugin load here too
      if (canonical.indexOf('!') != -1)
        throw new Error('Unable to trace ' + canonical + ' - building package environment mappings of plugins is not currently supported.');

      var pkgName = canonical.substr(0, pkgEnvIndex);
      var subPath = canonical.substr(pkgEnvIndex + 3);

      var normalizedPkgName = loader.decanonicalize(pkgName);

      var pkg = loader.packages[normalizedPkgName];


      // effective analog of the same function in SystemJS packages.js
      // to work out the path with defaultExtension added.
      // we cheat here and use normalizeSync to apply the right checks, while
      // skipping any map entry by temporarily removing it.
      function toPackagePath(subPath) {
        var pkgMap = pkg.map;
        pkg.map = {};
        // NB remove use of normalizeSync
        var normalized = loader.normalizeSync(pkgName + '/' + subPath);
        pkg.map = pkgMap;
        return normalized;
      }

      var envMap = pkg.map[subPath];
      var metadata = {};
      var fallback;

      // resolve the fallback
      return Promise.resolve()
      .then(function() {
        return loader.locate({ name: toPackagePath(subPath), metadata: metadata })
      })
      .then(function(address) {
        // allow build: false trace opt-out
        if (metadata.build === false)
          return false;

        fallback = getCanonicalName(loader, address);

        // check if the fallback exists
        return new Promise(function(resolve) {
          fs.exists(fromFileURL(address), resolve);
        })
        .then(function(fallbackExists) {
          if (!fallbackExists)
            fallback = null;
        });
      })
      .then(function() {
        // environment trace
        return loader.normalize(pkg.map['@env'] || '@system-env')
        .then(function(normalizedCondition) {
          var conditionModule = getCanonicalName(loader, normalizedCondition);

          return Promise.all(Object.keys(envMap).map(function(envCondition) {
            var mapping = envMap[envCondition];
            var negate = envCondition[0] == '~';

            return Promise.resolve()
            .then(function() {
              if (mapping == '.')
                return loader.normalize(pkgName);
              else if (mapping.substr(0, 2) == './')
                return toPackagePath(mapping.substr(2))
              else
                return loader.normalize(mapping);
            })
            .then(function(normalizedMapping) {
              return {
                condition: (negate ? '~' : '') + conditionModule + '|' + (negate ? envCondition.substr(1) : envCondition),
                branch: getCanonicalName(loader, normalizedMapping)
              };
            });
          }));
        })
        .then(function(envs) {
          return {
            name: canonical,
            fresh: true,
            conditional: {
              envs: envs,
              fallback: fallback
            }
          };
        });
      });
    }

    // conditional interpolation
    var interpolationRegEx = /#\{[^\}]+\}/;
    var interpolationMatch = canonical.match(interpolationRegEx);
    if (interpolationMatch) {
      var condition = interpolationMatch[0].substr(2, interpolationMatch[0].length - 3);

      if (condition.indexOf('|') == -1)
        condition += '|default';

      var metadata = {};
      return Promise.resolve(loader.locate({ name: normalized.replace(interpolationRegEx, '*'), metadata: metadata }))
      .then(function(address) {
        // allow build: false trace opt-out
        if (metadata.build === false)
          return false;

        // glob the conditional interpolation variations from the filesystem
        if (address.substr(0, 8) != 'file:///')
          throw new Error('Error tracing ' + canonical + '. It is only possible to trace conditional interpolation for modules resolving to local file:/// URLs during the build.');

        var globIndex = address.indexOf('*');
        return asp(glob)(fromFileURL(address), { dot: true, nobrace: true, noglobstar: true, noext: true, nodir: true })
        .then(function(paths) {
          var branches = {};
          paths.forEach(function(path) {
            path = toFileURL(path);

            var pathCanonical = getCanonicalName(loader, path);
            var interpolate = pathCanonical.substr(interpolationMatch.index, path.length - address.length + 1);

            if (metadata.loader) {
              if (loader.pluginFirst)
                pathCanonical = getCanonicalName(loader, metadata.loader) + '!' + pathCanonical;
              else
                pathCanonical = pathCanonical + '!' + getCanonicalName(metadata.loader);
            }
            branches[interpolate] = pathCanonical;
          });

          return {
            name: canonical,
            fresh: false, // we never cache conditional interpolates and always reglob
            conditional: {
              condition: condition,
              branches: branches
            }
          };
        });
      });
    }

    // -- trace loader hooks --
    var load = {
      name: canonical,
      // baseURL-relative path to address
      path: null,
      metadata: {},
      deps: [],
      depMap: {},
      source: null,

      // this is falsified by builder.reset to indicate we should restat
      fresh: true,
      // timestamp from statting the underlying file source at path
      timestamp: null,
      // each load stores a hash of the configuration from the time of trace
      // configHash is set by the loader.config function of the builder
      configHash: loader.configHash,

      plugin: null,
      runtimePlugin: false,

      // plugins via syntax must build in the plugin package config
      pluginConfig: null,

      // packages have a config file that must be built in for bundles
      packageConfig: null,

      // these are only populated by the separate builder.getDeferredImports(tree) method
      deferredImports: null
    };
    var curHook = 'locate';
    var originalSource;
    return Promise.resolve(loader.locate({ name: normalized, metadata: load.metadata}))
    .then(function(address) {
      curHook = '';

      // build: false build config - null load record
      if (load.metadata.build === false)
        return false;

      if (address.substr(0, 8) == 'file:///')
        load.path = path.relative(fromFileURL(loader.baseURL), fromFileURL(address));

      return Promise.resolve()
      .then(function() {
        // set load.plugin to canonical plugin name if a plugin load
        if (load.metadata.loaderModule)
          return Promise.resolve(loader.normalize(load.metadata.loader, normalized))
          .then(function(pluginNormalized) {
            load.plugin = getCanonicalName(loader, pluginNormalized);

            if (pluginNormalized.indexOf('!') == -1 && load.metadata.loaderModule.build !== false && getPackage(loader.packages, pluginNormalized)) {
              var packageConfigPath = getPackageConfigPath(loader.packageConfigPaths, pluginNormalized);
              if (packageConfigPath) {
                load.pluginConfig = getCanonicalName(loader, packageConfigPath);
                (loader.meta[packageConfigPath] = loader.meta[packageConfigPath] || {}).format = 'json';
              }
            }
          });
      })
      .then(function() {
        if (load.metadata.loaderModule && load.metadata.loaderModule.build === false) {
          load.runtimePlugin = true;
          return load;
        }

        curHook = 'fetch';
        return loader.fetch({ name: normalized, metadata: load.metadata, address: address })
        .then(function(source) {
          if (typeof source != 'string')
            throw new TypeError('Loader fetch hook did not return a source string');
          originalSource = source;
          curHook = 'translate';

          // default loader fetch hook will set load.metadata.timestamp
          if (load.metadata.timestamp) {
            load.timestamp = load.metadata.timestamp;
            load.metadata.timestamp = undefined;
          }

          return loader.translate({ name: normalized, metadata: load.metadata, address: address, source: source });
        })
        .then(function(source) {
          load.source = source;
          curHook = 'instantiate';

          if (load.metadata.format == 'esm' && !load.metadata.originalSource) {
            var esmCompiler = require('../compilers/esm.js');
            load.metadata.parseTree = esmCompiler.parse(source);
            return Promise.resolve({ deps: esmCompiler.getDeps(load.metadata.parseTree) });
          }

          return loader.instantiate({ name: normalized, metadata: load.metadata, address: address, source: source });
        })
        .then(function(result) {
          curHook = '';
          if (!result)
            throw new TypeError('Native ES Module builds not supported. Ensure transpilation is included in the loader pipeline.');

          load.deps = result.deps;

          // legacy es module transpilation translates to get the dependencies, so we need to revert for re-compilation
          if (load.metadata.format == 'esm' && load.metadata.originalSource)
            load.source = originalSource;

          // record package config paths
          if (getPackage(loader.packages, normalized)) {
            var packageConfigPath = getPackageConfigPath(loader.packageConfigPaths, normalized);
            if (packageConfigPath) {
              load.packageConfig = getCanonicalName(loader, packageConfigPath);
              (loader.meta[packageConfigPath] = loader.meta[packageConfigPath] || {}).format = 'json';
            }
          }

          // normalize dependencies to populate depMap
          return Promise.all(result.deps.map(function(dep) {
            return loader.normalize(dep, normalized, address)
            .then(function(normalized) {
              try {
                load.depMap[dep] = getCanonicalName(loader, normalized);
              }
              catch(e) {
                if (!excludeURLs || normalized.substr(0, 7) == 'file://')
                  throw e;
                (loader.meta[normalized] = loader.meta[normalized] || {}).build = false;
                load.depMap[dep] = normalized;
              }
            });
          }));
        });
      })
      .catch(function(err) {
        var msg = (curHook ? ('Error on ' + curHook + ' for ') : 'Error tracing ') + canonical + ' at ' + normalized;

        if (parentStack)
          parentStack.forEach(function(parent) {
            msg += '\n\tLoading ' + parent;
          });

        // rethrow loader hook errors with the hook information
        var newErr;
        if (err instanceof Error) {
          var newErr = new Error(err.message, err.fileName, err.lineNumber);
          // node errors only look correct with the stack modified
          newErr.stack = msg + '\n\t' + (err.stack || err.message) + '\n\t';
        }
        else {
          newErr = err + '\n\t' + msg;
        }

        throw newErr;
      })
      .then(function() {
        // remove unnecessary metadata for trace
        load.metadata.entry = undefined;
        load.metadata.builderExecute = undefined;
        load.metadata.parseTree = undefined;

        return load;
      });
    });
  })
  .then(function(load) {
    self.tracing[canonical] = undefined;
    return loads[canonical] = load;
  }).catch(function(err) {
    self.tracing[canonical] = undefined;
    throw err;
  });
};

/*
 * Returns the full trace tree of a module
 *
 * - traceAllConditionals indicates if conditional boundaries should be traversed during the trace.
 * - conditionalEnv represents the conditional tracing environment module values to impose on the trace
 *   forcing traces for traceAllConditionals false, and skipping traces for traceAllConditionals true.
 *
 * conditionalEnv provides canonical condition tracing rules of the form:
 *
 *  {
 *    'some/interpolation|value': true, // include ALL variations
 *    'another/interpolation|value': false, // include NONE
 *    'custom/interpolation|value': ['specific', 'values']
 *
 *    // default BOOLEAN entry::
 *    '@system-env|browser': false,
 *    '~@system-env|browser': false
 *
 *    // custom boolean entry
 *    // boolean only checks weak truthiness to allow overlaps
 *    '~@system-env|node': true
 *  }
 *
 */
var systemModules = ['@empty', '@system-env', '@@amd-helpers', '@@global-helpers'];
Trace.prototype.getAllLoadRecords = function(canonical, excludeURLs, tracePackageConfig, traceAllConditionals, canonicalConditionalEnv, curLoads, parentStack) {
  var loader = this.loader;

  curLoads = curLoads || {};

  if (canonical in curLoads)
    return curLoads;

  var self = this;
  return this.getLoadRecord(canonical, excludeURLs, parentStack)
  .then(function(load) {
    // conditionals, build: false and system modules are falsy loads in the trace trees
    // (that is, part of depcache, but not built)
    // we skip system modules though
    if (systemModules.indexOf(canonical) == -1)
      curLoads[canonical] = load;

    if (load) {
      parentStack = parentStack.concat([canonical]);
      return Promise.all(Trace.getLoadDependencies(load, tracePackageConfig, true, traceAllConditionals, canonicalConditionalEnv).map(function(dep) {
        return self.getAllLoadRecords(dep, excludeURLs, tracePackageConfig, traceAllConditionals, canonicalConditionalEnv, curLoads, parentStack);
      }));
    }
  })
  .then(function() {
    return curLoads;
  });
};

// helper function -> returns the "condition" build of a tree
// that is the modules needed to determine the exact conditional solution of the tree
Trace.prototype.getConditionLoadRecords = function(canonical, excludeURLs, tracePackageConfig, canonicalConditionalEnv, inConditionTree, curLoads, parentStack) {
  var loader = this.loader;

  if (canonical in curLoads)
    return curLoads;

  var self = this;
  return this.getLoadRecord(canonical, excludeURLs, parentStack)
  .then(function(load) {
    if (inConditionTree && systemModules.indexOf(canonical) == -1)
      curLoads[canonical] = load;

    if (load) {
      parentStack = parentStack.concat([canonical])
      // trace into the conditions themselves
      return Promise.all(Trace.getLoadDependencies(load, tracePackageConfig, true, true, canonicalConditionalEnv, true).map(function(dep) {
        return self.getConditionLoadRecords(dep, excludeURLs, tracePackageConfig, canonicalConditionalEnv, true, curLoads, parentStack);
      }))
      .then(function() {
        // trace non-conditions
        return Promise.all(Trace.getLoadDependencies(load, tracePackageConfig, true, true, canonicalConditionalEnv).map(function(dep) {
          return self.getConditionLoadRecords(dep, excludeURLs, tracePackageConfig, canonicalConditionalEnv, inConditionTree, curLoads, parentStack);
        }));
      });
    }
  })
  .then(function() {
    return curLoads;
  });
}

function conditionalComplement(condition) {
  var negative = condition[0] == '~';
  return (negative ? '' : '~') + condition.substr(negative);
}

function toCanonicalConditionalEnv(conditionalEnv) {
  var loader = this.loader;

  var canonicalConditionalEnv = {};

  return Promise.all(Object.keys(conditionalEnv).map(function(m) {
    var negate = m[0] == '~';
    var exportIndex = m.lastIndexOf('|');
    var moduleName = m.substring(negate, exportIndex != -1 && exportIndex);

    return loader.normalize(moduleName)
    .then(function(normalized) {
      var canonicalCondition = (negate ? '~' : '') + getCanonicalName(loader, normalized) + (exportIndex != -1 ? m.substr(exportIndex) : '');
      canonicalConditionalEnv[canonicalCondition] = conditionalEnv[m];
    });
  }))
  .then(function() {
    return canonicalConditionalEnv;
  });
}

/*
 * to support static conditional builds, we use the conditional tracing options
 * to inline resolved conditions for the trace
 * basically rewriting the tree without any conditionals
 * where conditions are still present or conflicting we throw an error
 */
Trace.prototype.inlineConditions = function(tree, conditionalEnv) {
  var self = this;

  return toCanonicalConditionalEnv.call(this, conditionalEnv)
  .then(function(canonicalConditionalEnv) {
    var inconsistencyErrorMsg = 'For static condition inlining only an exact environment resolution can be built, pending https://github.com/systemjs/builder/issues/311.';

    // ensure we have no condition conflicts
    for (var c in conditionalEnv) {
      var val = conditionalEnv[c];
      if (typeof val == 'string')
        continue;
      var complement = conditionalComplement(c);
      if (val instanceof Array || complement in conditionalEnv && conditionalEnv[complement] != !conditionalEnv[c])
        throw new TypeError('Error building condition ' + c + '. ' + inconsistencyErrorMsg);
    }

    var conditionalResolutions = {};

    // for each conditional in the tree, work out its substitution
    Object.keys(tree)
    .filter(function(m) {
      return tree[m] && tree[m].conditional;
    })
    .forEach(function(c) {
      var resolution = Trace.getConditionalResolutions(tree[c].conditional, false, conditionalEnv);

      var branches = resolution.branches;
      if (branches.length > 1)
        throw new TypeError('Error building condition ' + c + '. ' + inconsistencyErrorMsg);
      if (branches.length == 0)
        throw new TypeError('No resolution found at all for condition ' + c + '.');

      conditionalResolutions[c] = branches[0];
    });

    // finally we do a deep clone of the tree, applying the conditional resolutions as we go
    var inlinedTree = {};
    Object.keys(tree).forEach(function(m) {
      var load = tree[m];

      if (typeof load == 'boolean') {
        inlinedTree[m] = load;
        return;
      }

      if (load.conditional)
        return;

      var clonedLoad = extend({}, load);
      clonedLoad.depMap = {};
      Object.keys(load.depMap).forEach(function(d) {
        var normalizedDep = load.depMap[d];
        clonedLoad.depMap[d] = conditionalResolutions[normalizedDep] || normalizedDep;
      });

      inlinedTree[m] = clonedLoad;
    });

    return inlinedTree;
  });
};

Trace.getConditionalResolutions = function(conditional, traceAllConditionals, conditionalEnv) {
  if (traceAllConditionals !== false)
    traceAllConditionals = true;
  conditionalEnv = conditionalEnv || {};

  // flattens all condition objects into a resolution object
  // with the condition module and possible branches given the environment segment
  var resolution = { condition: null, branches: [] };

  function envTrace(condition) {
    // trace the condition modules as dependencies themselves
    var negate = condition[0] == '~';
    resolution.condition = condition.substr(negate, condition.lastIndexOf('|') - negate);

    // return the environment trace info
    var envTrace = conditionalEnv[condition];
    return envTrace === undefined ? traceAllConditionals : envTrace;
  }

  var deps = [];

  // { condition, branch } boolean conditional
  if (conditional.branch) {
    if (envTrace(conditional.condition))
      resolution.branches.push(conditional.branch);
    else
      resolution.branches.push('@empty');
  }

  // { envs: [{condition, branch},...], fallback } package environment map
  else if (conditional.envs) {
    var doFallback = true;
    conditional.envs.forEach(function(env) {
      if (envTrace(env.condition))
        resolution.branches.push(env.branch);

      // if we're specifically not tracing the negative of this condition
      // then we stop the fallback branch from building
      if (!envTrace(conditionalComplement(env.condition)))
        doFallback = false;
    });
    var resolutionCondition = resolution.condition;
    if (doFallback && conditional.fallback)
      resolution.branches.push(conditional.fallback);
  }

  // { condition, branches } conditional interpolation
  else if (conditional.branches) {
    var et = envTrace(conditional.condition);
    if (et !== undefined && et !== false) {
      Object.keys(conditional.branches).forEach(function(branch) {
        var dep = conditional.branches[branch];
        if (et === true)
          resolution.branches.push(dep);
        else if (et.indexOf(branch) != -1)
          resolution.branches.push(dep);
      });
    }
  }

  return resolution;
};

// Returns the ordered immediate dependency array from the trace of a module
Trace.getLoadDependencies = function(load, tracePackageConfig, traceRuntimePlugin, traceAllConditionals, canonicalConditionalEnv, conditionsOnly) {
  if (traceAllConditionals !== false)
    traceAllConditionals = true;
  canonicalConditionalEnv = canonicalConditionalEnv || {};

  if (!load.conditional && conditionsOnly)
    return [];

  // conditional load records have their branches all included in the trace
  if (load.conditional) {
    var resolution = Trace.getConditionalResolutions(load.conditional, traceAllConditionals, canonicalConditionalEnv);
    if (conditionsOnly)
      return [resolution.condition];
    else
      return [resolution.condition].concat(resolution.branches);
  }

  var deps = [];

  // trace the plugin as a dependency
  if (traceRuntimePlugin && load.runtimePlugin)
    deps.push(load.plugin);

  // plugins by syntax build in their config
  if (tracePackageConfig && load.pluginConfig)
    deps.push(load.pluginConfig);

  // add the dependencies
  load.deps.forEach(function(dep) {
    deps.push(load.depMap[dep]);
  });

  // trace the package config if necessary
  if (tracePackageConfig && load.packageConfig)
    deps.push(load.packageConfig);

  return deps;
};
