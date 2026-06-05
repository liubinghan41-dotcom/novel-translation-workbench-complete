const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const defaultInputs = [
  path.join(root, "release")
];
const allowed = new Set([".apk", ".exe", ".zip", ".7z", ".blockmap", ".yml"]);
const inputs = process.argv.slice(2).map((item) => path.resolve(item));
const output = path.resolve(process.env.CHECKSUM_OUTPUT || path.join(root, "release", "SHA256SUMS.txt"));

function walk(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const rows = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    rows.push(...walk(path.join(target, entry.name)));
  }
  return rows;
}

const files = (inputs.length ? inputs : defaultInputs)
  .flatMap(walk)
  .filter((file) => allowed.has(path.extname(file).toLowerCase()))
  .filter((file) => path.basename(file) !== "SHA256SUMS.txt")
  .filter((file) => path.basename(file) !== "builder-debug.yml")
  .filter((file) => !file.split(path.sep).includes("win-unpacked"))
  .sort((a, b) => a.localeCompare(b));

if (!files.length) {
  console.error("No release files found for checksums.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const lines = files.map((file) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return `${hash}  ${path.relative(path.dirname(output), file).replace(/\\/g, "/")}`;
});
fs.writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${output}`);
