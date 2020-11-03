// Given a possibly nested directory of ES3/5 files designed to
// be concatenated and thus eventually share globally declared variables,
// convert them into a set of ES6 modules constructed so as to share
// those variables via exports and import.

const fs = require("fs").promises;
const Path = require("path");
const {Parser} = require("acorn");
const AcornGlobals = require("acorn-globals");
const chalk = require("chalk");

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

/**
 * Generate a list of directory segments.
 */
async function* walkDirectories(dir, n = 0) {
  const files = await fs.readdir(dir);

  for (const f of files) {
    let dirPath = Path.join(dir, f);
    let isDirectory = (await fs.stat(dirPath)).isDirectory();

    if (isDirectory) {
      yield [f, n];

      for await (const result of walkDirectories(dirPath, n + 1)) yield result;
    }
  }
}

// Given an iterable, and a function to derive a key from each element,
// group the items by key, and return a map indexed by key containing
// a set giving the elements for that key.
function groupBy(iterable, keyFn) {
  const result = new Map();

  for (const elt of iterable) {
    const key = keyFn.call(this, elt);
    let set = result.get(key);

    if (!set) result.set(key, (set = new Set()));
    set.add(elt);
  }

  return result;
}

function replaceInSet(set, oldValue, newValue) {
  if (set.has(oldValue)) {
    set.delete(oldValue);
    set.add(newValue);
    return true;
  }
}

function modifyFilename(path, fn) {
  const elements = Path.parse(path);

  elements.name = fn(elements.name);
  delete elements.base;

  return Path.format(elements);
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
    maxSize = Infinity,
    stripComments,
    indexjs = "index.js",
    renameDups = false,
    combine, // combine files containing assignment to import with file where it is declared.
  }
) {
  // Symbols found in all files, where they were defined, assigned, and referenced.
  let symbols = new Map();

  // All input, split, and merged files, indexed by relative path, with contents.
  let files = new Map(); // all input and/or split files, with their contents

  // Remember all directory and file names (without `.js`), in order to rename if necessary.
  let fileNames = new Set();

  let dupCount = 0;

  if (verbose) console.log("Processing", dir);

  await scan();

  if (verbose) {
    console.log("Found", symbols.size, "symbols in", files.size, "files");
    if (dupCount) console.info("Renamed", dupCount, "files");
  }
  if (debug) console.log("Symbols are", ...symbols.keys());

  if (combine) combineFiles();

  if (dest) await write();

  async function scan() {
    // Pre-populate set of file names with directory segments.
    // It seems that files with the same name as directories can make LWC unhappy.
    if (renameDups) for await (const [segment] of walkDirectories(dir)) fileNames.add(segment);

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
        let relativePath = Path.relative(dir, path); // e.g. `src/foobar.js`
        let fileName = Path.basename(path);

        // If we have already encountered this file name, then rename it.
        if (fileNames.has(Path.basename(fileName, ".js").toLowerCase()) && renameDups) {
          const oldRelativePath = relativePath;

          relativePath = modifyFilename(
            relativePath,
            fn => fn + String(dupCount++).padStart(3, "0")
          );
          fileName = Path.basename(relativePath);

          if (debug) console.info("Renaming duplicate", oldRelativePath, "to", relativePath);
        }

        fileNames.add(Path.basename(fileName, ".js").toLowerCase());

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
          const destName =
            i === 0 ? relativePath : modifyFilename(relativePath, fn => fn + "." + i);
          const code = pieces[i];

          files.set(destName, code);

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

            if (verbose && isAssignment)
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
      const removedSymbols = [];

      for (const [symbol, {definition}] of symbols) {
        if (!definition) {
          symbols.delete(symbol);
          removedSymbols.push(symbol);
        }
      }

      if (verbose) console.info("Removed", removedSymbols.length, "global symbols");
      if (debug) console.info("Removed global symbols were", ...removedSymbols);
    }
  }

  /**
   * Is a symbol is declared in one file and assigned to in another,
   * we need to combine those two files.
   * Hopefully the result will not be too big. If it is, we're screwed.
   * Currently we do not handle the case where this gives rise to additional mergers!
   */
  function combineFiles() {
    for (const [symbol, {assignments, definition}] of symbols) {
      // Find other files where this symbol is assigned.
      const otherFileAssignments = new Set(
        [...assignments.values()].filter(file => file !== definition)
      );

      // For each such file, combine it into the file containing the definition.
      // JavaScript does not allow assignment of imports.
      for (const otherFile of otherFileAssignments) {
        if (verbose)
          console.info(
            "Combining",
            chalk.yellow(otherFile),
            "into",
            chalk.yellow(definition),
            "because of symbol",
            chalk.yellow(symbol)
          );

        files.set(definition, files.get(definition) + files.get(otherFile)); // Concatenate the files.
        files.delete(otherFile); // Forget about this file.

        let replacementCount = 0;

        // Across the entire symbol table,
        // remap assignments, definitions, and references to the merged file.
        for (const [_symbol, entry] of symbols) {
          replaceInSet(entry.assignments, otherFile, definition);
          if (replaceInSet(entry.references, otherFile, definition)) replacementCount++;
          if (entry.definition === otherFile) entry.definition = definition;
        }

        if (debug) console.info("Remapped", replacementCount, "references to combined file");
      }
    }
  }

  // Write out the files, with import and export statements, and the import.js file.
  async function write() {
    await fs.rmdir(dest, {recursive: true});

    for (let [path, data] of files) {
      const destPath = Path.join(dest, path);
      const destDir = Path.dirname(destPath);
      const upDir = "../".repeat(depth(path));

      // Generate import statements for global symbols used by this file,
      // and export statements for globals it defines.

      // Create import statement for symbols used here and defined elsewhere,
      // to insert at top of file.
      const symbolsUsed = [...symbols.entries()].filter(
        ([symbol, {references, definition}]) => definition !== path && references.has(path)
      );
      // Group symbols useed by where they are defined.
      // `symbolsUsedByDefinition` is a map of definition location to sets of symbol entries.
      const symbolsUsedByDefinition = groupBy(symbolsUsed, ([, {definition}]) => definition);

      // Create a single import statement for each file in which symbols were defined,
      // making it slightly easier for a human to view the file.
      const symbolsUsedImport =
        Array.from(symbolsUsedByDefinition.entries())
          .map(
            ([definition, symbolEntries]) =>
              `import {${Array.from(symbolEntries)
                .map(([symbol]) => symbol)
                .join(", ")}} from '${Path.normalize(Path.join(upDir, definition))}';\n`
          )
          .join("") + "\n";

      // Create export statement for symbols defined here, to insert at bottom of file.
      const symbolsDefined = [...symbols.entries()]
        .filter(([symbol, {definition}]) => definition === path)
        .map(([symbol]) => symbol);
      const symbolsDefinedExport = symbolsDefined.length
        ? `\n\nexport {${symbolsDefined.join(", ")}};\n`
        : "";

      const destData = symbolsUsedImport + data + symbolsDefinedExport;

      await fs.mkdir(destDir, {recursive: true});
      await fs.writeFile(destPath, destData);
      if (debug) console.info(`Wrote ${destPath}`);
    }

    await writeIndexJs();

    async function writeIndexJs() {
      const indexJsPath = Path.join(dest, indexjs);
      const imports = [...files.keys()].map(file => `import './${file}';\n`).join("");

      await fs.writeFile(indexJsPath, "// Automatically generated by es6ify\n\n" + imports);

      if (verbose) console.info("Wrote index file", chalk.yellow(indexJsPath));
    }
  }
};
