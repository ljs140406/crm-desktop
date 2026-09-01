/**
 * 客户跟进管理系统 - 桌面版主进程
 *
 * 数据仍存放在 localStorage（由 Chromium 持久化到 userData 目录），
 * 通过应用内「设置中心 → 手动备份 / 云端 Gist 同步」做备份，与网页版行为一致。
 *
 * 加载方式：使用自定义 app:// 协议（而非 file://）加载页面。
 * 原因：1) 安装目录含中文（如 Programs\客户跟进管理系统\），file:// 下易触发
 *       加载失败/白屏；2) app:// 作为 secure+standard 源，localStorage 与
 *       跨域 fetch（GitHub Gist）行为更可靠。
 */
const { app, BrowserWindow, Menu, shell, dialog, session, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// 自动更新（electron-updater）。未安装依赖时降级为不可用，不影响主流程。
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
    autoUpdater = null;
}

// 更新源：采用 GitHub Releases（在 package.json 的 build.publish 配置 owner/repo）。
// 构建时 electron-builder 会把 provider 信息写进 app-update.yml 并打进 asar，
// electron-updater 运行时会自动读取，无需在这里硬编码地址。
// 若改用自有服务器，把 package.json 的 build.publish 改回 generic 并填 url 即可。
const UPDATE_PROVIDER = 'github';

// 是否已配置真正的更新服务器（app-update.yml 的 owner/repo 仍是占位符 YOUR_ 时视作未配置）
let updateConfigured = false;

// 桌面版为表单类应用，无需 GPU 加速；禁用可避免部分环境（无显卡/远程桌面/虚拟机）
// 下 GPU 进程启动失败导致白屏或崩溃的问题。
app.disableHardwareAcceleration();

const APP_NAME = '客户跟进管理系统';

// ---------- 注册特权协议：让 app:// 成为 secure/standard 源（localStorage/fetch 可用）----------
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            bypassCSP: false,
        },
    },
]);

// ---------- 单实例锁：避免重复打开多个窗口导致数据互相覆盖 ----------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

let mainWindow = null;

/**
 * 自定义协议处理器：把 app://app/<path> 映射到本地 app/ 目录下的文件。
 *
 * 注意：必须用 registerFileProtocol（而非 protocol.handle 的 Fetch 式 Response）。
 * protocol.handle 会让页面拿到「不透明源（origin=null）」，导致 localStorage
 * 被浏览器拒绝（SecurityError: Access is denied）；registerFileProtocol 才会
 * 赋予页面规范的 app://app 源，localStorage / fetch(Gist) 才能正常工作。
 */
function registerAppProtocol() {
    const baseDir = path.join(__dirname, 'app');

    protocol.registerFileProtocol('app', (request, callback) => {
        try {
            const url = new URL(request.url);
            let rel = decodeURIComponent(url.pathname);
            if (rel === '/' || rel === '') rel = '/crm-app.html';
            // 归一化并阻止目录穿越
            const safe = path.normalize(rel).replace(/^(\.\.[\\/])+/, '').replace(/^[\\/]+/, '');
            const filePath = path.join(baseDir, safe);
            if (!filePath.startsWith(baseDir)) {
                return callback({ error: 403 });
            }
            if (!fs.existsSync(filePath)) {
                return callback({ error: 404 });
            }
            callback({ path: filePath });
        } catch (e) {
            callback({ error: 404 });
        }
    });
}

// ---------- 文件导入：把 .json / .crmbak 备份（双击/打开方式/菜单选择）导入进应用 ----------
const BACKUP_FILE_RE = /\.(json|crmbak)$/i;
let pendingImportFile = null;

/** 等页面（window._crm）就绪后再执行回调，避免 importData 尚未挂载 */
function runWhenPageReady(win, fn, tries = 0) {
    if (!win || win.isDestroyed()) return;
    if (tries > 50) return; // ~10s 超时放弃
    win.webContents.executeJavaScript('typeof window._crm')
        .then((t) => {
            if (t === 'object' || t === 'function') {
                fn();
            } else {
                setTimeout(() => runWhenPageReady(win, fn, tries + 1), 200);
            }
        })
        .catch(() => setTimeout(() => runWhenPageReady(win, fn, tries + 1), 200));
}

/** 读取 .json 备份文本，注入到渲染进程调用 window._crm.importData(File) */
function importBackupFromFile(filePath) {
    if (!filePath || !BACKUP_FILE_RE.test(filePath)) return;
    if (!fs.existsSync(filePath)) return;
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        dialog.showErrorBox('读取失败', `无法读取备份文件：\n${e.message}`);
        return;
    }
    // JSON.stringify 会把文本安全地转义为 JS 双引号字符串字面量（含中文/引号/换行）
    const baseName = path.basename(filePath);
    const code = `(() => {
        try {
            const txt = ${JSON.stringify(text)};
            const f = new File([txt], ${JSON.stringify(baseName)}, { type: 'application/json' });
            if (window._crm && typeof window._crm.importData === 'function') {
                window._crm.importData(f);
            } else {
                console.warn('[desktop] importData 尚未就绪');
            }
        } catch (e) { console.error('[desktop] 导入注入失败', e); }
    })()`;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        runWhenPageReady(mainWindow, () => {
            mainWindow.webContents.executeJavaScript(code).catch(() => {});
        });
    } else {
        pendingImportFile = filePath; // 窗口还没建好，稍后重试
    }
}

/** 菜单「导入备份…」：弹文件选择框 */
function openBackupFileDialog() {
    if (!mainWindow) return;
    const res = dialog.showOpenDialogSync(mainWindow, {
        title: '选择备份文件',
        filters: [{ name: 'CRM 备份', extensions: ['json', 'crmbak'] }],
        properties: ['openFile'],
    });
    if (res && res[0]) importBackupFromFile(res[0]);
}

// ---------- 自动更新（electron-updater）----------
/**
 * 读取打包进 asar 的 app-update.yml，判断是否已配置真实的 GitHub 更新源。
 * owner/repo 仍为占位符（YOUR_GITHUB_OWNER / YOUR_REPO）时视为未配置，
 * 跳过自动检查，避免每次启动都向无效地址发请求。
 */
function isUpdateConfigured() {
    try {
        const p = path.join(process.resourcesPath, 'app-update.yml');
        if (!fs.existsSync(p)) return false;
        const txt = fs.readFileSync(p, 'utf-8');
        const owner = (txt.match(/^owner:\s*(.+)$/m) || [])[1];
        const repo = (txt.match(/^repo:\s*(.+)$/m) || [])[1];
        if (!owner || !repo) return false;
        if (/YOUR_/i.test(owner) || /YOUR_/i.test(repo)) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function setupAutoUpdater() {
    if (!autoUpdater) return;
    updateConfigured = isUpdateConfigured();
    if (!updateConfigured) {
        // 未配置真实更新源（仍是占位符）：静默跳过，不在启动时发无效请求
        console.log('[desktop] 自动更新未配置（build.publish 仍为占位符），跳过自动检查');
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // 不在这里 setFeedURL：electron-updater 会自动读取打包进 asar 的 app-update.yml
    // （由 package.json 的 build.publish 生成，当前为 GitHub Releases）。

    autoUpdater.on('update-available', (info) => {
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '发现新版本',
                message: `检测到新版本 v${info.version || '?'} ，正在后台下载…`,
                buttons: ['确定'],
            });
        }
    });
    autoUpdater.on('update-downloaded', (info) => {
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '更新就绪',
            message: `新版本 v${info.version || '?'} 已下载完成。`,
            detail: '重启应用即可完成更新。',
            buttons: ['现在重启', '稍后'],
            defaultId: 0,
            cancelId: 1,
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
        });
    });
    autoUpdater.on('error', (e) => {
        // 静默失败，不打扰用户（多为未配置更新服务器 / 网络问题）
        console.error('[desktop] autoUpdater error:', e && e.message);
    });

    autoUpdater.checkForUpdates().catch(() => {});
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        // 最小宽度锁在 1024：源应用内建的 @media (min-width:1024px) 桌面布局才会生效
        minWidth: 1024,
        minHeight: 700,
        title: APP_NAME,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        backgroundColor: '#F5F6FA',
        autoHideMenuBar: false,
        show: false,
        webPreferences: {
            nodeIntegration: false,   // 页面脚本无需 Node 能力，保持隔离更安全
            contextIsolation: true,
            webSecurity: true,
            spellcheck: false,
        },
    });

    mainWindow.loadURL('app://app/crm-app.html');

    // 启动期若通过「打开方式」/命令行传入了 .json 备份，加载完成后导入
    mainWindow.webContents.once('did-finish-load', () => {
        if (pendingImportFile) {
            const f = pendingImportFile;
            pendingImportFile = null;
            importBackupFromFile(f);
        }
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();   // 直接最大化，确保进入宽屏布局
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // ---------- 外链用系统默认浏览器打开，不要在本窗口里跳走 ----------
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        const current = mainWindow.webContents.getURL();
        if (!url.startsWith('app://') && url !== current) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });

    // ---------- 页面标题跟随应用内页面名 ----------
    mainWindow.webContents.on('page-title-updated', (event, title) => {
        event.preventDefault();
        mainWindow.setTitle(title && title.trim() ? `${title} - ${APP_NAME}` : APP_NAME);
    });
}

/** 导出/下载：自动保存到「下载」目录，重名自动加序号，完成后在资源管理器中定位 */
function setupDownloads() {
    session.defaultSession.on('will-download', (event, item) => {
        const fileName = item.getFilename() || 'download';
        const dir = app.getPath('downloads');
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);

        let savePath = path.join(dir, fileName);
        let n = 1;
        while (fs.existsSync(savePath)) {
            savePath = path.join(dir, `${base} (${n})${ext}`);
            n += 1;
        }
        item.setSavePath(savePath);

        item.once('done', (e, state) => {
            if (state === 'completed') {
                shell.showItemInFolder(savePath);
            } else if (state === 'cancelled') {
                // 用户取消，静默处理
            } else {
                dialog.showErrorBox('下载失败', `文件未能保存：\n${savePath}`);
            }
        });
    });
}

function showAbout() {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '关于',
        message: APP_NAME,
        detail: [
            `版本：${app.getVersion()}`,
            '',
            '数据保存在本机浏览器存储中。',
            '请通过「设置中心 → 手动备份」或「云端同步（Gist）」定期备份，',
            '以免重装系统或清理数据时丢失。',
        ].join('\n'),
        buttons: ['确定'],
    });
}

function buildMenu() {
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '打开数据目录',
                    click: () => shell.openPath(app.getPath('userData')),
                },
                {
                    label: '打开下载目录',
                    click: () => shell.openPath(app.getPath('downloads')),
                },
                {
                    label: '导入备份…',
                    click: () => openBackupFileDialog(),
                },
                { type: 'separator' },
                { label: '退出', role: 'quit' },
            ],
        },
        {
            label: '视图',
            submenu: [
                { label: '重新加载', role: 'reload' },
                { label: '强制重新加载', role: 'forceReload' },
                { type: 'separator' },
                { label: '放大', role: 'zoomIn' },
                { label: '缩小', role: 'zoomOut' },
                { label: '实际大小', role: 'resetZoom' },
                { type: 'separator' },
                { label: '切换全屏', role: 'togglefullscreen' },
                { label: '开发者工具', role: 'toggleDevTools' },
            ],
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '检查更新',
                    click: () => {
                        if (!updateConfigured) {
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                title: '尚未配置更新',
                                message: '自动更新尚未配置。\n请在 package.json 的 build.publish 填写 GitHub 的 owner / repo，并设置 GH_TOKEN 后重新发布安装包。',
                                buttons: ['确定'],
                            });
                            return;
                        }
                        if (autoUpdater) {
                            autoUpdater.checkForUpdates().catch(() => {});
                        } else {
                            dialog.showErrorBox('更新不可用', '未配置自动更新服务（electron-updater 未安装）。');
                        }
                    },
                },
                { label: '关于', click: showAbout },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 生命周期 ----------
app.on('second-instance', (event, argv) => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
    }
    // Windows 下通过「打开方式」或双击关联文件再次打开应用时，文件路径在 argv 里
    const f = (argv || []).find((a) => BACKUP_FILE_RE.test(a));
    if (f) importBackupFromFile(f);
});

app.whenReady().then(() => {
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.crm.desktop');
    }
    registerAppProtocol();
    buildMenu();
    setupDownloads();
    createWindow();
    setupAutoUpdater();

    // 首次启动若通过命令行 /「打开方式」/双击关联文件传入了备份文件
    const f = (process.argv || []).find((a) => BACKUP_FILE_RE.test(a));
    if (f) importBackupFromFile(f);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
