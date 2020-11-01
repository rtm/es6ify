import {es6ify} from "./index";

const yargs = require("yargs");

// CONFIGURATION
const findUp = require("find-up");
const configPath = findUp.sync([".es6ify", ".es6ifyrc.json"]);
const config = configPath ? JSON.parse(fs.readFileSync(configPath)) : {};

const argv = yargs
  .usage("$0 <source directory> --dest=<destination directory>")
  .option("dest", {alias: "d", describe: "destination directory"})
  .option("verbose", {alias: "v", describe: "detailed output", type: "boolean"})
  .option("debug", {alias: "d", describe: "very detailed output", type: "boolean"})
  .option("importjs", {describe: "name of file containing re-exports", default: "import.js"})
  .option("stripComments", {
    describe: "how to strip comments",
    choices: ["never", "always", "ifneeded"],
  })
  .config(config)
  .help().argv;

const {verbose, stripComments, debug, dest, importjs} = argv;

es6ify(argv._[0], {dest, verbose, debug, stripComments, importjs});
