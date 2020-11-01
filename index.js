// Given a possibly nested directory of ES3/5 files designed to
// be concatenated and thus eventually share globally declared variables,
// convert them into a set of ES6 modules constructed so as to share
// those variables via exports and import.

const fs = require("fs").promises;
const Path = require("path");
const {Parser} = require("acorn");
const AcornGlobals = require("acorn-globals");

// Walk a directory recursively.
async function walkDir(dir, callback, n = 0) {
  const files = await fs.readdir(dir);

  for (const f of files) {
    let dirPath = Path.join(dir, f);
    let isDirectory = (await fs.stat(dirPath)).isDirectory();

    if (isDirectory) await walkDir(dirPath, callback, n + 1);
    else await callback(dirPath, n);
  }
}

// Return the depth of a path. "foo" would be zero. "foo/bar" or "./foo/bar" would be one.
const depth = path => Path.normalize(path).split(Path.sep).length - 1;

// Partition array into subarrays starting at item defined by predicate.
// We use this to partition the top-level statements so that none exceed some maximum.
function partitionAt(array, fn) {
  const result = [];
  let subarray = [];

  for (let i = 0; i < array.length; i++) {
    const elt = array[i];

    if (!i || fn(elt, i, array)) result.push((subarray = []));
    subarray.push(elt);
  }

  return result;
}

module.exports = async function es6ify(
  dir,
  {
    dest,
    verbose,
    debug,
    importjs = "import.js",
    maxSize = Infinity,
    stripComments,
    indexjs = "index.js",
  }
) {
  let symbols = new Map(); // symbols found in all files, and where they were found
  let files = new Map(); // all input and/or split files, with their contents
  let fileCount = 0;

  if (verbose) console.log("Processing", dir);

  await scan();
  if (verbose) console.log("Found", symbols.size, "symbols in", files.size, "files.");

  combine();

  if (dest) await write();

  async function scan() {
    await walkFiles();
    removeGlobalSymbols();

    async function walkFiles() {
      await walkDir(dir, async function(path) {
        if (debug) console.log(`Reading ${path}`);
        await oneFile(path);
      });

      async function oneFile(path) {
        let file = await fs.readFile(path, "utf8");
        let ast;
        const pieces = [];
        const onComment = [];

        try {
          ast = Parser.parse(file, {ecmaVersion: 5, allowReturnOutsideFunction: true, onComment});
        } catch (e) {
          console.error("Parse error in", path, e, file.slice(0, 100));
          return;
        }

        if (stripComments) {
          for (let i = onComment.length - 1; i >= 0; i--) {
            const {start, end} = onComment[i];

            file = file.slice(0, start) + file.slice(end);
          }
        }

        // Partition the file so that each partition is under max size.
        let remainingPiece = file;

        const partitions = partitionAt(ast.body, ({start}) => {
          let lastSize = 0;

          if (start >= lastSize + maxSize) {
            pieces.push(file.slice(lastSize, start));
            remainingPiece = file.slice(start);
            lastSize = start;
            return true;
          }
        });
        pieces.push(remainingPiece);

        for (let i = 0; i < partitions.length; i++) {
          const partition = partitions[i];
          const partitionName =
            partitions.length > 1 ? `${Path.basename(path, ".js")}.${i}.js` : path;
          const code = pieces[i];
          files.set(partitionName, code);
          const destName = partitionName.replace(dir, ".");

          // Find definitions.
          for (let node of partition) {
            switch (node.type) {
              case "VariableDeclaration":
                for (let {
                  id: {name},
                } of node.declarations)
                  addSymbolDefinition(name);
                break;
              case "FunctionDeclaration":
                addSymbolDefinition(node.id.name);
                break;
              default:
            }
          }

          // Find references, including assignments.
          // TODO: worry about this throwing.
          const symbolsUsed = AcornGlobals(code);

          for (let {name, nodes} of symbolsUsed) {
            const entry = createSymbolEntry(name);
            const isAssignment = nodes.some(isAssignmentExpression);

            entry[isAssignment ? "assignments" : "references"].add(destName);

            if (debug && isAssignment)
              console.info("Found global assignment to", name, "in", destName);
          }

          // Add a symbol definition to our list of all symbols defined globally.
          // Remember the file where it occurred (vis-a-vis the destination).
          function addSymbolDefinition(symbol) {
            const entry = createSymbolEntry(symbol);

            if (entry.definition)
              console.error("Name", symbol, "in", path, "already found in", symbols[symbol]);
            entry.definition = destName;
          }

          function createSymbolEntry(symbol) {
            if (!symbols.has(symbol))
              symbols.set(symbol, {assignments: new Set(), references: new Set()});
            return symbols.get(symbol);
          }

          function isAssignmentExpression({parents}) {
            const [parent, self] = parents.slice(-2);

            return parent.type === "AssignmentExpression" && parent.left === self;
          }
        }
      }
    }

    function removeGlobalSymbols() {
      const symbols = [];

      for (const [symbol, {definition}] of symbols)
        if (!definition) {
          symbols.delete(symbol);
          symbols.push(symbol);
        }

      if (verbose) console.info("Removed global symbols", ...symbols);
    }
  }

  function combine() {}

  // Write out the files, with import and export statements, and the import.js file.
  async function write() {
    await fs.rmdir(dest, {recursive: true});

    for (let [path, data] of files) {
      const srcDir = Path.dirname(path);
      const destDir = srcDir.replace(dir, dest);
      const destPath = Path.join(destDir, Path.basename(path));
      const destPathRelative = path.replace(dir, "."); // e.g. `./src/foo.js`
      const importJsPath = "../".repeat(depth(destPathRelative)) + importjs;

      // Generate import statements for global symbols used by this file,
      // and export statements for globals it defines.

      // Create import statement for symbols used here, to insert at top of file.
      const symbolsUsed = symbols
        .entries()
        .filter(([symbol, {references}]) => references.has(destPathRelative))
        .map(([symbol]) => symbol);
      const symbolsUsedImport = symbolsUsed.length
        ? `import {${symbolsUsed.join(", ")}} from "${importJsPath}";\n\n`
        : "";

      // Create export statement for symbols defined here, to insert at bottom of file.
      const symbolsDefined = Object.keys(symbols).filter(
        symbol => symbols[symbol].definitions === destPathRelative
      );
      const symbolsDefinedExport = symbolsDefined.length
        ? `\n\nexport {${symbolsDefined.join(", ")}};\n`
        : "";

      const destData = symbolsUsedImport + data + symbolsDefinedExport;

      await fs.mkdir(destDir, {recursive: true});
      await fs.writeFile(destPath, destData);
      if (debug) console.info(`Wrote ${destPath}`);
    }

    await writeImportJs();
    await writeIndexJs();

    async function writeImportJs() {
      const importJsPath = Path.join(dir, importjs);
      const importData = Object.keys(symbols)
        .map(k => `export {${k}} from "${symbols[k]}";\n`)
        .join("");

      await fs.writeFile(importJsPath, importData);
      if (verbose) console.info("Wrote imports file", importJsPath);
    }

    async function writeIndexJs() {
      const indexJsPath = Path.join(dir, indexjs);
      const imports = files
        .keys()
        .map(file => `import "${file}";\n`)
        .join("");

      await fs.writeFile(indexJsPath, imports);

      if (verbose) console.info("Wrote index file", indexJsPath);
    }
  }
};
