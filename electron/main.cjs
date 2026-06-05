const path = require("path");
const { app, BrowserWindow, shell } = require("electron");

let serverHandle;
let mainWindow;

function resolveDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, "NovelTranslationWorkbench-data");
  }
  return path.join(app.getPath("userData"), "data");
}

function resolveStaticDir() {
  return path.join(__dirname, "..", "dist");
}

async function createMainWindow() {
  app.setAppUserModelId("com.liubinghan.noveltranslationworkbench");

  const dataDir = resolveDataDir();
  const { createServer } = require("../server");
  const workbenchServer = createServer({
    port: 0,
    dataDir,
    staticDir: resolveStaticDir()
  });
  serverHandle = await workbenchServer.start();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: "#f6f7fb",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(serverHandle.url);
}

app.whenReady().then(createMainWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on("before-quit", () => {
  if (serverHandle?.server) serverHandle.server.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
