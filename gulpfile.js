'use strict';

var spawn = require('child_process').spawn;
var exec = require('child_process').exec;

var gulp = require('gulp');
var useref = require('gulp-useref');
var livereload = require('gulp-livereload');
var sass = require('gulp-sass');
var compass = require('gulp-compass');
var rename = require('gulp-rename');
var insert = require('gulp-insert');
var concat = require('gulp-concat');
var git = require('gulp-git');
var bump = require('gulp-bump');
var tag_version = require('gulp-tag-version');

var packager = require('electron-packager');
var del = require('del');
var runSequence = require('run-sequence');
var fs = require('fs');
var path = require('path');
var archiver = require('archiver');
var glob = require('glob');
var browserify = require('browserify');
var source = require('vinyl-source-stream');
var buffer = require('vinyl-buffer');
var merge = require('merge-stream');
var _ = require('underscore');
var notifier = require('node-notifier');
var packageJSON = require('./package.json');

var buildDir = 'build';
var distDir = 'dist';
var electronVersion = '0.30.4';

function incrementVersion(importance) {
  return gulp.src(['./package.json'])
    .pipe(bump({type: importance}))
    .pipe(gulp.dest('./'))
    .pipe(git.commit('Version++'))
    .pipe(tag_version());
}

gulp.task('bump:patch', function() { return incrementVersion('patch'); });
gulp.task('bump:minor', function() { return incrementVersion('minor'); });
gulp.task('bump:major', function() { return incrementVersion('major'); });

gulp.task('clean', function (done) {
  del([ buildDir, distDir ], done);
});

gulp.task('watch', [ 'watch:sass' ], function () {
  livereload.listen();
});

gulp.task('notify', function (done) {
  notifier.notify({
    title: 'Gulp task',
    message: 'done!!',
    icon: path.join(__dirname, 'images', 'AppIcon.iconset', 'icon_256x256.png'),
    sound: 'Submarine'
  }, done);
});

gulp.task('l10n:extract', function (done) {
  var proc = spawn('node_modules/jsxgettext/lib/cli.js', _.flatten([ '-o', 'po/ja.po', '-j', glob.sync('javascripts/**/*.js') ]));
  proc.on('exit', done);
});

gulp.task('l10n:po2json', [ 'l10n:extract' ], function (done) {
  exec('node etc/po2json.js -p po/ja.po > po/ja.json', done);
});

gulp.task('l10n', [ 'l10n:po2json' ], function (done) {});

gulp.task('watch:sass', function () {
  gulp.watch('sass/**/*.scss', ['build:sass']);
});

var platformAndArchs = [ ['win32', 'ia32'], ['win32', 'x64'], ['darwin', 'x64'] ];
var distTasks = platformAndArchs.map( function (platformAndArch) {
  var platform = platformAndArch[0];
  var arch = platformAndArch[1];
  var appName = 'IRKit Updater';
  var appVersion = packageJSON.version;
  var appPath = path.join(distDir, platform, [appName, platform, arch].join("-"));
  var taskName = [ 'dist', platform, arch ].join(":");
  gulp.task(taskName+":packager", function (done) {
    packager({
      dir: buildDir,
      name: appName,
      arch: arch,
      platform: platform,
      out: distDir + '/' + platform,
      version: electronVersion,
      icon: 'images/AppIcon.icns',
      'app-bundle-id': 'jp.maaash.irkitupdater',
      'app-version': appVersion,
      'version-string': {
        CompanyName: 'maaash.jp',
        FileDescription: appName,
        FileVersion: appVersion,
        ProductVersion: appVersion,
        ProductName: appName
      }
    }, done);
  });
  gulp.task(taskName+":copyserialnode", function (done) {
    // copy native module
    var src = path.join("etc", "serialport.node."+platform+"_"+arch);
    var dstfiles = glob.sync(appPath+"/**/serialport-electron/serialport.node");
    if (dstfiles.length !== 1) {
      done( "Expected dstfiles.length to be 1 but got: " + dstfiles.join(", ") );
      return null;
    }
    return gulp.src(src)
      .pipe(rename('serialport.node'))
      .pipe(gulp.dest(path.dirname(dstfiles[0])))
    ;
  });
  gulp.task(taskName+":copydriver", function (done) {
    if (platform === 'darwin') {
      return done();
    }
    // copy windows driver to a visible place
    var src = path.join("windows-driver", "IRKit.inf");
    return gulp.src(src)
      .pipe(gulp.dest(appPath))
    ;
  });
  gulp.task(taskName+":makelproj", function (done) {
    if (platform !== 'darwin') {
      return done();
    }
    var asarPath = glob.sync(appPath+"/**/atom.asar");
    if (asarPath.length !== 1) {
      return done( "Expected asarPath.length to be 1 but got: " + asarPath.join(", ") );
    }
    var languages = [ 'ja' ];
    languages.forEach(function (language) {
      fs.mkdirSync( path.join(path.dirname(asarPath[0]), language+'.lproj') );
    });
    return done();
  });
  gulp.task(taskName+":copylicense", function (done) {
    var ourStream = gulp.src('LICENSE').
          pipe(gulp.dest(appPath))
    ;
    var electronStream = gulp.src(path.join(appPath, 'LICENSE')).
          pipe(insert.prepend("ELECTRON\nhttps://github.com/atom/electron\n\n")).
          pipe(insert.append("\n\n"))
    ;
    var dependencies = Object.keys(packageJSON.dependencies);
    var streams = dependencies.map( function (dependency) {
      var repo = require('./'+path.join('node_modules',dependency,'package.json')).repository.url;
      return gulp.src(path.join('node_modules',dependency,'LICENSE')).
        pipe(insert.prepend([dependency, repo].join("\n")+"\n\n")).
        pipe(insert.append("\n\n"))
      ;
    });
    var acknowledgements = merge(_.flatten([electronStream,streams])).
      pipe(concat("ACKNOWLEDGEMENTS")).
      pipe(gulp.dest(appPath))
    ;
    return merge([ acknowledgements, ourStream ]);
  });
  gulp.task(taskName+":zip", function (done) {
    var dest = [appName, platform, arch, appVersion].join("-") + ".zip";
    var cwd = path.join(distDir, platform);
    var zip = archiver.create('zip', {});
    var output = fs.createWriteStream(path.join(cwd, dest));
    zip.pipe(output);
    zip.bulk([
      {
        expand: true,
        cwd: cwd,
        src: [path.basename(appPath) + "/**/*"],
        dot: true
      }
    ]);
    zip.finalize();
    return output;
  });
  gulp.task(taskName, function (done) {
    runSequence( taskName+":packager",
                 [
                   taskName+":copyserialnode",
                   taskName+":copydriver",
                   taskName+":makelproj",
                   taskName+":copylicense"
                 ],
                 taskName+":zip",
                 done );
  });
  return taskName;
});
gulp.task('dist', function (done) {
  var tasks = [ 'clean',
                'build',
                distTasks,
                'notify',
                done ];
  var flattened = Array.prototype.concat.apply([], tasks); // serialize distTasks too
  runSequence.apply( null, flattened );
});

gulp.task('build:sass', function () {
  return gulp.src('sass/**/*.scss')
    .pipe(compass({
      config_file: './config.rb',
      css: 'stylesheets',
      sass: 'sass',
      sourcemap: true
    }))
    .pipe(gulp.dest(buildDir+"/stylesheets"))
    .pipe(livereload())
  ;
});

gulp.task('build:html', function () {
  return gulp.src('*.html')
    .pipe(useref())
    .pipe(gulp.dest(buildDir))
  ;
});

gulp.task('build:scripts', function () {
  return gulp.src(['javascripts/**/*.js'], { base: '.' })
    .pipe(gulp.dest(buildDir))
  ;
});

gulp.task('build:modules', function () {
  // thanks to http://qiita.com/Quramy/items/90d61ff37ca1b95a7f6d
  function mainFile(module) {
    var main = require('./'+path.join('node_modules',module,'package.json')).main;
    if (path.extname(main) == "") {
      main = main + ".js"; // for serialport-electron
    }
    return path.normalize(main);
  }
  
  var dependencies = Object.keys(packageJSON.dependencies);
  var defaultModules = ['assert', 'buffer', 'console', 'constants', 'crypto', 'domain', 'events', 'fs', 'http', 'https', 'os', 'path', 'punycode', 'querystring', 'stream', 'string_decoder', 'timers', 'tty', 'url', 'util', 'vm', 'zlib'];
  var nativeModules = ['./serialport.node'];
  var browserifiedModules = dependencies.map( function (module) {
    var main = mainFile(module);
    var b = browserify(path.join('node_modules',module,main), {
      detectGlobals: false,
      standalone: main
    });
    _.flatten([defaultModules, nativeModules]).forEach(function(module) {
      b.exclude(module);
    });
    var mainStream = b.bundle().
      pipe(source(main)).
      pipe(buffer()).
      pipe(gulp.dest(path.join(buildDir,'node_modules',module)))
    ;
    var packageJSONStream = gulp.src(path.join('node_modules',module,'package.json')).
          pipe(gulp.dest(path.join(buildDir,'node_modules',module)))
    ;
    return [mainStream, packageJSONStream];
  });
  var serialportPath = 'node_modules/serialport-electron/';
  var serialportStream = gulp.src(path.join(serialportPath, 'serialport.node')).
        pipe(gulp.dest(path.join(buildDir, serialportPath)))
  ;
  
  return merge(_.flatten([browserifiedModules, serialportStream]));
});

gulp.task('build:etc', function () {
  return gulp.src(['etc/**', 'bin/**', 'fonts/**', 'images/**', 'package.json', 'po/**'], { base: '.' })
    .pipe(gulp.dest(buildDir))
  ;
});

gulp.task('build', [
  'build:html',
  'build:sass',
  'build:scripts',
  'build:modules',
  'build:etc'
], function () {
});

gulp.task('cleanbuild', function (done) {
  runSequence( 'clean',
               'build',
               done );
});

gulp.task('default', [ 'build' ], function () {
});
