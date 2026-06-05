const { existsSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

const root = join(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

run("npm", ["run", "build:web"]);

if (!existsSync(join(root, "android"))) {
  run("npx", ["cap", "add", "android"]);
} else {
  run("npx", ["cap", "sync", "android"]);
}

const hasSigningSecrets =
  Boolean(process.env.ANDROID_KEYSTORE_BASE64 || process.env.ANDROID_KEYSTORE_FILE);
const task = process.env.ANDROID_BUILD_TASK || (hasSigningSecrets ? "assembleRelease" : "assembleDebug");
const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
run(gradle, [task], { cwd: join(root, "android") });
