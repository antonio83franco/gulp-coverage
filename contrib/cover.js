var instrument = require('./instrument');
var Module = require('module').Module;
var path = require('path');
var fs = require('fs');
var vm = require('vm');
var _ = require('underscore');
var multimatch = require('multimatch');

// Coverage tracker
function CoverageData (filename, instrumentor) {
    var theLines = {};
    /*
     * Create a map between the lines and the nodes
     * This is used later for calculating the code coverage stats
     */
    Object.keys(instrumentor.nodes).forEach(function(index) {
        var node = instrumentor.nodes[index],
            lineStruct;

        if (!theLines[node.loc.start.line]) {
            lineStruct = theLines[node.loc.start.line] = {
                nodes: []
            };
        } else {
            lineStruct = theLines[node.loc.start.line];
        }
        if (lineStruct.nodes.indexOf(node) === -1) {
            lineStruct.nodes.push(node);
        }
        if (!theLines[node.loc.end.line]) {
            lineStruct = theLines[node.loc.end.line] = {
                nodes: []
            };
        } else {
            lineStruct = theLines[node.loc.end.line];
        }
        if (lineStruct.nodes.indexOf(node) === -1) {
            lineStruct.nodes.push(node);
        }
    });
    this.lines = theLines;
    this.instrumentor = instrumentor;
    this.filename = filename;
    this.nodes = {};
    this.visitedBlocks = {};
    this.source = instrumentor.source;
}

// Calculate node coverage statistics
CoverageData.prototype.blocks = function() {
    var totalBlocks = this.instrumentor.blockCounter;
    var numSeenBlocks = 0;
    for(var index in this.visitedBlocks) {
        numSeenBlocks++;
    }    
    var toReturn = {
        total: totalBlocks,
        seen: numSeenBlocks
    };
    return toReturn;
};

CoverageData.prototype.prepare = function() {
    var data = require('./coverage_store').getStoreData(this.filename),
        rawData, store, index;

    data = '[' + data  + '{}]';
    rawData = JSON.parse(data);
    store = {nodes: {}, blocks: {}};
    rawData.forEach(function(item) {
        var it;
        if (item.block) {
            store.blocks[item.block] = store.blocks[item.block] || {count: 0};
            store.blocks[item.block].count += 1;
        } else {
            if (item.expression) {
                it = item.expression;
            } else if (item.statement) {
                it = item.statement;
            } else {
                return;
            }
            store.nodes[it.node] = store.nodes[it.node] || {count: 0};
            store.nodes[it.node].count += 1;
        }
    });

    for (index in store.nodes) {
        if (store.nodes.hasOwnProperty(index)) {
            this.instrumentor.nodes[index].count = store.nodes[index].count;
        }
    }
    
    for (index in store.blocks) {
        if (store.blocks.hasOwnProperty(index)) {
            this.visitedBlocks[index] = {count: store.blocks[index].count};
        }
    }
};

/**
 * 
 * Get statistics for the entire file, including per-line code coverage
 * statement coverage and block-level coverage
 * This function returns an object with the following structure:
 * {
 *      lines: Integer - the number of lines covered
 *      blocks: Integer - the number of blocks covered
 *      statements: Integer - the number of statements covered
 *      lineDetails: Array[Object] - a sparse array of the detailed information on each line
 *      sloc: Integer - the number of relevant lines in the file
 *      sboc: Integer - the number of relevant blocks in the file
 *      ssoc: Integer - the number of relevant statements in the file
 *      code: Array[String] - an Array of strings, one for each line of the file
 * }
 *
 * The line detail objects have the following structure
 * {
 *      number: Integer - the line number
 *      count: Integer - the number of times the line was executed
 *      statements: Integer - the number of statements covered
 *      ssoc: Integer - the number of statements in the line
 *      statementDetails : Array[Object] - an array of the statement details
 * }
 *
 * The statement detail objects have the following structure
 * {
 *      loc: Object - a location object
 *      count: the number of times the statement was executed
 * }
 *
 */

CoverageData.prototype.stats = function() {
    this.prepare();
        var filedata = this.instrumentor.source.split('\n');
    var lineDetails = [],
        lines = 0, fileStatements = 0, fileSsoc = 0, fileSloc = 0,
        theLines = this.lines,
        blockInfo;

    Object.keys(theLines).forEach(function(index) {
        var line = theLines[index],
            lineStruct,
            lineCount = 0,
            statements = 0,
            ssoc = 0,
            statementDetails = [];
        line.nodes.forEach(function(node) {
            if (node.count === null || node.count === undefined) {
                node.count = 0;
            }
            lineCount = Math.max(lineCount, node.count);
            ssoc += 1;
            if (node.count) {
                statements += 1;
            }
            statementDetails.push({
                loc: node.loc,
                count: node.count
            });
        });
        lineStruct = {
            number: index,
            count: lineCount,
            ssoc: ssoc,
            statements: statements,
            statementDetails: statementDetails
        };
        lines += (lineStruct.count ? 1 : 0);
        fileSloc += 1;
        fileStatements += lineStruct.statements;
        fileSsoc += lineStruct.ssoc;
        lineDetails[index-1] = lineStruct;
    });
    blockInfo = this.blocks();
    retVal = {
        lines: lines,
        statements: fileStatements,
        blocks: blockInfo.seen,
        sloc: fileSloc,
        ssoc: fileSsoc,
        sboc: blockInfo.total,
        lineDetails: lineDetails,
        code: filedata
    };
    return retVal;
};

var addInstrumentationHeader = function(template, filename, instrumented, coverageStorePath) {
    var templ = _.template(template),
        renderedSource = templ({
            instrumented: instrumented,
            coverageStorePath: coverageStorePath,
            filename: filename,
            source: instrumented.instrumentedSource
        });
    return renderedSource;
};

var stripBOM = function(content) {
    // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
    // because the buffer-to-string conversion in `fs.readFileSync()`
    // translates it to FEFF, the UTF-16 BOM.
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
    }
    return content;
};

var cover = function(pattern, debugDirectory) {    
    var originalRequire = require.extensions['.js'];
    var coverageData = {};

    var pathToCoverageStore = path.resolve(path.resolve(__dirname), "coverage_store.js").replace(/\\/g, "/");
    var templatePath = path.resolve(path.resolve(__dirname), "templates", "instrumentation_header.js");
    var template = fs.readFileSync(templatePath, 'utf-8');

    require.extensions['.js'] = function(module, filename) {
        filename = filename.replace(/\\/g, "/");

        //console.log('filename: ', filename, ', pattern: ', pattern, ', match: ', multimatch(filename, pattern));
        if (!multimatch(filename, pattern).length) {
            return originalRequire(module, filename);
        }
        if (filename === pathToCoverageStore) {
            return originalRequire(module, filename);
        }

        var data = stripBOM(fs.readFileSync(filename, 'utf8').trim());
        data = data.replace(/^\#\!.*/, '');

        var instrumented = instrument(data);
        coverageData[filename] = new CoverageData(filename, instrumented);

        var newCode = addInstrumentationHeader(template, filename, instrumented, pathToCoverageStore);

        if (debugDirectory) {
            var outputPath = path.join(debugDirectory, filename.replace(/[\/|\:|\\]/g, "_") + ".js");
            fs.writeFileSync(outputPath, newCode);
        }

        return module._compile(newCode, filename);
    };
    
    // Setup the data retrieval and release functions
    var coverage = function(ready) {
      ready(coverageData);
    };
    
    coverage.release = function() {
      require.extensions['.js'] = originalRequire;
    };
    
    coverage.coverageData = coverageData;
    
    return coverage;
};


/**
 * This initializes a new coverage run. It does this by creating a randomly generated directory
 * in the .coverdata and updating the .coverrun file in the process' cwd with the directory's
 * name, so that the data collection can write data into this directory
 */
function removeDir(dirName) {
    fs.readdirSync(dirName).forEach(function(name) {
        if (name !== '.' && name !== '..') {
            fs.unlinkSync(dirName + '/' + name);
        }
    });
    fs.rmdirSync(dirName);
}

var init = function() {
    var directoryName = '.cover_' + Math.random().toString().substring(2),
        dataDir = process.cwd() + '/.coverdata';
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    } else {
        fs.readdirSync(dataDir).forEach(function(name) {
            if (name !== '.' && name !== '..') {
                removeDir(dataDir + '/' + name);
            }
        });
    }
    fs.mkdirSync(dataDir + '/' + directoryName);
    fd = fs.writeFileSync(process.cwd() + '/.coverrun', '{ "run" : "' + directoryName + '" }');
    global.coverageData = {};
};

var cleanup = function() {
    var store = require('./coverage_store');

    store.clearStore();
};

module.exports = {
    cover: cover,
    init: init,
    cleanup: cleanup,
    reporters: {
        html:   require('./reporters/html')
    }
};