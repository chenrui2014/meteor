var meteorNpm = require(path.join(__dirname, '..', 'meteor_npm.js'));

///
/// TEST PACKAGE DIR
///
var tmpPackageDirContainer = tmpDir();
var testPackageDir = path.join(tmpPackageDirContainer, 'test-package');

var updateTestPackage = function(npmDependencies) {
  if (!fs.existsSync(testPackageDir))
    fs.mkdirSync(testPackageDir);

  fs.writeFileSync(path.join(testPackageDir, 'package.js'),
                   "Package.describe({summary: 'a package that uses npm modules'});\n"
                   + "\n"
                   + "Npm.depends(" + JSON.stringify(npmDependencies) + ");"
                   + "\n"
                   + "Package.on_use(function (api) { api.add_files('dummy.js', 'server'); });");
  // we need at least one server file, otherwise we don't bother copying
  // the gcd module into the bundle.
  fs.writeFileSync(path.join(testPackageDir, 'dummy.js'), "");
};

process.env.PACKAGE_DIRS = tmpPackageDirContainer;


///
/// TEST APP USING TEST PACKAGE DIR
///
var appWithPackageDir = path.join(__dirname, 'app-with-package');

///
/// HELPERS
///

var _assertCorrectPackageNpmDir = function(deps) {
  // test-package/.npm was generated

  // sort of a weird way to do it, but i don't want to have to look up all subdependencies
  // to write these tests, so just transplant that information
  var actualMeteorNpmShrinkwrapDependencies = JSON.parse(fs.readFileSync(path.join(testPackageDir, ".npm", "npm-shrinkwrap.json"), 'utf8')).dependencies;
  var expectedMeteorNpmShrinkwrapDependencies = _.object(_.map(deps, function(version, name) {
    var expected = {};
    if (/tarball/.test(version)) {
      expected.from = version;
    } else {
      expected.version = version;
    }

    // copy fields with values generated by shrinkwrap that can't be known to the
    // test author. We set keys on val always in this order so that comparison works well.
    var val = {};
    _.each(['version', 'from', 'resolved', 'dependencies'], function(key) {
      if (expected[key])
        val[key] = expected[key];
      else if (actualMeteorNpmShrinkwrapDependencies[name] && actualMeteorNpmShrinkwrapDependencies[name][key])
        val[key] = actualMeteorNpmShrinkwrapDependencies[name][key];
    });

    return [name, val];
  }));

  assert.equal(
    fs.readFileSync(path.join(testPackageDir, ".npm", "npm-shrinkwrap.json"), 'utf8'),
    JSON.stringify({
      dependencies: expectedMeteorNpmShrinkwrapDependencies}, null, /*indentation, the way npm does it*/2) + '\n');

  assert.equal(
    fs.readFileSync(path.join(testPackageDir, ".npm", ".gitignore"), 'utf8'),
    "node_modules\n");
  assert(fs.existsSync(path.join(testPackageDir, ".npm", "README")));

  // verify the contents of the `node_modules` dir
  var nodeModulesDir = path.join(testPackageDir, ".npm", "node_modules");

  // all expected dependencies are installed correctly, with the correct version
  _.each(deps, function(version, name) {
    assert(looksInstalled(nodeModulesDir, name));

    if (!/tarball/.test(version)) { // 'version' in package.json from a tarball won't be correct
      assert.equal(JSON.parse(
        fs.readFileSync(
          path.join(nodeModulesDir, name, "package.json"),
          'utf8')).version,
                   version);
    }
  });

  // all installed dependencies were expected to be found there,
  // meaning we correctly removed unused node_modules directories
  _.each(
    fs.readdirSync(nodeModulesDir),
    function(installedNodeModule) {
      if (fs.existsSync(path.join(nodeModulesDir, installedNodeModule, "package.json")))
        assert(installedNodeModule in deps);
    });
};

var _assertCorrectBundleNpmContents = function(bundleDir, deps) {
  // sanity check -- main.js has expected contents.
  assert.strictEqual(fs.readFileSync(path.join(bundleDir, "main.js"), "utf8").trim(),
                     "require('./server/server.js');");

  var bundledPackageNodeModulesDir = path.join(bundleDir, 'app', 'packages', 'test-package', 'node_modules');

  // bundle actually has the npm modules
  _.each(deps, function(version, name) {
    assert(looksInstalled(bundledPackageNodeModulesDir, name));

    if (!/tarball/.test(version)) { // 'version' in package.json from a tarball won't be correct
      assert.equal(JSON.parse(
        fs.readFileSync(path.join(bundledPackageNodeModulesDir, name, 'package.json'), 'utf8'))
                   .version,
                   version);
    }
  });
};

var looksInstalled = function (nodeModulesDir, name) {
  // All of the packages in this test have one of these two files, so presumably
  // if one of these files is here we have correctly installed the package.
  return fs.existsSync(path.join(nodeModulesDir, name, 'README.md')) ||
    fs.existsSync(path.join(nodeModulesDir, name, 'LICENSE'));
};

///
/// TESTS
///

var library = new library.Library();

console.log("app that uses gcd - clean run");
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0'});
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
});

console.log("app that uses gcd - no changes, running again");
assert.doesNotThrow(function () {
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
});

console.log("app that uses gcd - as would be in a 3rd party repository (no .npm/node_modules)");
assert.doesNotThrow(function () {
  var tmpOutputDir = tmpDir();

  // rm -rf .npm/node_modules
  var nodeModulesDir = path.join(testPackageDir, ".npm", "node_modules");
  assert(fs.existsSync(path.join(nodeModulesDir)));
  files.rm_recursive(nodeModulesDir);
  assert(!fs.existsSync(path.join(nodeModulesDir)));

  // while bundling, verify that we don't call `npm install
  // name@version unnecessarily` -- calling `npm install` is enough,
  // and installing each package separately coul unintentionally bump
  // subdependency versions. (to intentionally bump subdependencies,
  // just remove all of the .npm directory)
  var bareExecFileSync = meteorNpm._execFileSync;
  meteorNpm._execFileSync = function(file, args, opts) {
    if (args[0] === 'install' && args[1])
      assert.fail("shouldn't be installing specific npm packages: " + args[1]);
    return bareExecFileSync(file, args, opts);
  };
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  meteorNpm._execFileSync = bareExecFileSync;

  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
});


console.log("app that uses gcd - add mime and semver");
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
});

console.log("app that uses gcd - add mime, as it would happen if you pulled in this change (updated npm-shrinkwrap.json but not node_modules)");
assert.doesNotThrow(function () {
  var tmpOutputDir = tmpDir();

  // rm -rf .npm/node_modules/mime
  var nodeModulesMimeDir = path.join(testPackageDir, ".npm", "node_modules", "mime");
  assert(fs.existsSync(path.join(nodeModulesMimeDir)));
  files.rm_recursive(nodeModulesMimeDir);
  assert(!fs.existsSync(path.join(nodeModulesMimeDir)));

  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
});

console.log("app that uses gcd - upgrade mime, remove semver");
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0', mime: '1.2.8'});
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.8'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0', mime: '1.2.8'});
});

console.log("app that uses gcd - try downgrading mime to non-existant version");
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0', mime: '0.1.2'});
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors.length, 1);
  assert(/version not found/.test(errors[0]));
  _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.8'}); // shouldn't've changed
});

console.log("app that uses gcd - downgrade mime to an existant version");
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0', mime: '1.2.7'});
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);

  _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.7'});
  _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7'});
});


console.log("app that uses gcd - install gzippo via tarball");
assert.doesNotThrow(function () {
  var deps = {gzippo: 'https://github.com/meteor/gzippo/tarball/1e4b955439abc643879ae264b28a761521818f3b'};
  updateTestPackage(deps);
  var tmpOutputDir = tmpDir();
  var errors = bundler.bundle(appWithPackageDir, tmpOutputDir, {nodeModulesMode: 'skip', releaseStamp: 'none', library: library});
  assert.strictEqual(errors, undefined, errors && errors[0]);
  _assertCorrectPackageNpmDir(deps);
  _assertCorrectBundleNpmContents(tmpOutputDir, deps);
  // Check that a string introduced by our fork is in the source.
  assert(/clientMaxAge = 604800000/.test(
    fs.readFileSync(
      path.join(testPackageDir, ".npm", "node_modules", "gzippo", "lib", "staticGzip.js"), "utf8")));
});

console.log("bundle multiple apps in parallel using a meteor package dependent on an npm package");
// this fails if we don't manage the package .npm directory correctly
// against parallel bundling.  this happens if you are running more
// than one app at once using a certain package and that package is
// updated.
// (Note that it still can fail if the _renameAlmostAtomically fails due to its
//  lack of atomicity, but this is relatively rare.)
assert.doesNotThrow(function () {
  updateTestPackage({gcd: '0.0.0', mime: '1.2.7'});
  // rm -rf .npm/node_modules, to make sure installing modules takes some time
  var nodeModulesDir = path.join(testPackageDir, ".npm", "node_modules");
  assert(fs.existsSync(path.join(nodeModulesDir)));
  files.rm_recursive(nodeModulesDir);
  assert(!fs.existsSync(path.join(nodeModulesDir)));

  var futures = _.map(_.range(0, 10), function() {
    var future = new Future;
    Fiber(function () {
      var tmpAppDir = tmpDir();
      files.cp_r(appWithPackageDir, tmpAppDir);

      var tmpDirToPutBundleTarball = tmpDir();

      // bundle in a separate process, since we have various bits of
      // shared state, such as cached compiled packages
      try {
        var result = meteorNpm._execFileSync(
          path.join(files.getCurrentToolsDir(), "meteor"),
          ["bundle", path.join(tmpDirToPutBundleTarball, "bundle.tar.gz")],
          {cwd: tmpAppDir});
        files.rm_recursive(tmpDirToPutBundleTarball);
      } catch (e) {
        console.log(e.stdout);
        console.log(e.stderr);
        throw e;
      }
      _assertCorrectPackageNpmDir({gcd: '0.0.0', mime: '1.2.7'});

      files.rm_recursive(tmpAppDir);
      future["return"]();
    }).run();
    return future;
  });

  Future.wait(futures);
});



///
/// SUCCESS
///
delete process.env.PACKAGE_DIRS;
