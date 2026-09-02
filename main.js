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
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, session, protocol, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- 原生存储：数据落 userData/crm-store.json，替代 localStorage ----------
// 目的：1) 突破 localStorage 约 5MB 的配额与「可被系统清理」的风险；
//       2) 数据以文件形式存在，便于备份/迁移。
const STORE_PATH = path.join(app.getPath('userData'), 'crm-store.json');

/** 注册原生存储 IPC（同步调用：页面启动必须同步拿到数据，异步会读到空） */
function setupStorageIPC() {
    ipcMain.on('crm-storage:load', (event) => {
        try {
            event.returnValue = fs.existsSync(STORE_PATH)
                ? fs.readFileSync(STORE_PATH, 'utf-8')
                : '';
        } catch (e) {
            console.error('[desktop] 读取原生存储失败', e && e.message);
            event.returnValue = '';
        }
    });

    // 原子写入：先写临时文件再 rename，避免写到一半崩溃导致数据文件损坏
    ipcMain.on('crm-storage:save', (event, raw) => {
        try {
            const tmp = `${STORE_PATH}.tmp`;
            fs.writeFileSync(tmp, typeof raw === 'string' ? raw : '', 'utf-8');
            fs.renameSync(tmp, STORE_PATH);
            event.returnValue = true;
        } catch (e) {
            console.error('[desktop] 写入原生存储失败', e && e.message);
            event.returnValue = false;
        }
    });
}

// ---------- WebDAV 通道：请求在 main 进程发出，绕开渲染进程 CORS ----------
// 页面通过 electronAPI.webdav.request 调用；Node 18+ 自带全局 fetch。
function setupWebdavIPC() {
    ipcMain.handle('crm-webdav:request', async (_event, opts) => {
        const method = (opts && opts.method ? String(opts.method) : 'GET').toUpperCase();
        const url = opts && opts.url ? String(opts.url) : '';
        if (!url) return { status: 0, data: 'URL 为空', headers: {} };
        // 安全约束：只允许 http/https，防止利用主进程探测本地文件或内网资源
        let u;
        try { u = new URL(url); } catch (e) { return { status: 0, data: 'URL 非法', headers: {} }; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
            return { status: 0, data: '不支持的协议：' + u.protocol, headers: {} };
        }
        try {
            const headers = Object.assign({}, opts.headers || {});
            const hasBody = method !== 'GET' && method !== 'HEAD' && opts.body != null;
            const res = await fetch(url, {
                method,
                headers,
                body: hasBody ? String(opts.body) : undefined,
                redirect: 'follow',
            });
            let data = '';
            try { data = await res.text(); } catch (e) { data = ''; }
            const out = {};
            try { res.headers.forEach((v, k) => { out[k] = v; }); } catch (e) { /* 忽略 */ }
            return { status: res.status, data, headers: out };
        } catch (e) {
            return { status: 0, data: '请求失败：' + ((e && e.message) || String(e)), headers: {} };
        }
    });
}

// ---------- 系统安全存储：safeStorage 加密，仅当前系统用户可解密 ----------
// 用于保存 WebDAV 密码/应用密码；不可用时返回 false，页面会回落本地存储。
const SECRET_PATH = path.join(app.getPath('userData'), 'crm-secrets.json');
function setupSecretIPC() {
    let safeStorage = null;
    try { safeStorage = require('electron').safeStorage; } catch (e) { safeStorage = null; }

    const usable = () => !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());

    const readAll = () => {
        try {
            return fs.existsSync(SECRET_PATH) ? JSON.parse(fs.readFileSync(SECRET_PATH, 'utf-8')) : {};
        } catch (e) { return {}; }
    };
    const writeAll = (obj) => {
        try {
            const tmp = `${SECRET_PATH}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
            fs.renameSync(tmp, SECRET_PATH);
            return true;
        } catch (e) { return false; }
    };

    ipcMain.on('crm-secret:get', (event, key) => {
        try {
            if (!usable()) { event.returnValue = ''; return; }
            const all = readAll();
            const enc = all[String(key)];
            if (!enc) { event.returnValue = ''; return; }
            event.returnValue = safeStorage.decryptString(Buffer.from(enc, 'base64'));
        } catch (e) {
            console.error('[desktop] 读取安全存储失败', e && e.message);
            event.returnValue = '';
        }
    });

    ipcMain.on('crm-secret:set', (event, key, value) => {
        try {
            if (!usable()) { event.returnValue = false; return; }
            const all = readAll();
            if (value == null || value === '') {
                delete all[String(key)];
            } else {
                all[String(key)] = safeStorage.encryptString(String(value)).toString('base64');
            }
            event.returnValue = writeAll(all);
        } catch (e) {
            console.error('[desktop] 写入安全存储失败', e && e.message);
            event.returnValue = false;
        }
    });
}

// 自动更新（electron-updater）。未安装依赖时降级为不可用，不影响主流程。
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
    autoUpdater = null;
}

// 更新源：采用 Gitee Releases 镜像（国内访问稳定），由 package.json 的 build.publish
// 配置 generic provider（url 指向 Gitee release 的 latest 标签下载地址）。
// 构建时 electron-builder 会把 provider 信息写进 app-update.yml 并打进 asar，
// electron-updater 运行时会自动读取，无需在这里硬编码地址。
// 若改用 GitHub 或自有服务器，把 build.publish 改回对应 provider 并填 owner/repo 或 url 即可。
const UPDATE_PROVIDER = 'generic';

// 是否已配置真正的更新服务器（app-update.yml 的 owner/repo 仍是占位符 YOUR_ 时视作未配置）
let updateConfigured = false;
// 自动更新是否已完成初始化（setupAutoUpdater 只应执行一次，避免重复监听）
let updaterInitialized = false;
// 手动检查入口（初始化后由菜单/托盘调用，带「已是最新」弹窗与失败提示）
let manualCheckFn = null;

// 桌面版默认启用 GPU 加速（卡片阴影/渐变/过渡动画在 GPU 合成下滚动更顺滑）。
// 仅当设置环境变量 CRM_DISABLE_GPU=1 时（如远程桌面 / 虚拟机下 GPU 进程异常）
// 才回退到软件渲染，规避白屏或崩溃。该开关必须在 app ready 前判断。
if (process.env.CRM_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration();
}

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
let tray = null;          // 系统托盘实例
let isQuiting = false;    // 真正退出标志；为 false 时点 X 仅隐藏到托盘

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
        // 1) GitHub provider：检查 owner/repo
        const owner = (txt.match(/^owner:\s*(.+)$/m) || [])[1];
        const repo = (txt.match(/^repo:\s*(.+)$/m) || [])[1];
        if (owner && repo && !/YOUR_/i.test(owner) && !/YOUR_/i.test(repo)) return true;
        // 2) generic provider（如 Gitee 镜像）：检查 url 是否为有效 http(s) 地址
        const url = (txt.match(/^url:\s*(.+)$/m) || [])[1];
        if (url && !/YOUR_/i.test(url) && /^https?:\/\//i.test(url.trim())) return true;
        return false;
    } catch (e) {
        return false;
    }
}

function setupAutoUpdater() {
    if (!autoUpdater) return;
    if (updaterInitialized) return;          // 仅初始化一次，防止重复监听
    updaterInitialized = true;
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

    // 是否为「用户手动检查」：手动检查才弹「已是最新 / 失败」提示，避免开机静默检查蹦窗
    let manualCheck = false;
    let checking = false;   // 是否正在检查中（防重复触发）

    autoUpdater.on('update-available', (info) => {
        // 静默检查时才弹「正在后台下载」；手动检查等下载完再提示，避免冗余
        if (!manualCheck && mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '发现新版本',
                message: `检测到新版本 v${info.version || '?'} ，正在后台下载…`,
                buttons: ['确定'],
            });
        }
    });
    autoUpdater.on('update-not-available', (info) => {
        // 已是最新版本：仅手动检查时才提示（修复「点检查更新毫无反应」）
        if (manualCheck && mainWindow) {
            const v = (info && info.version) || app.getVersion();
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '已是最新版本',
                message: `当前已是最新版本 v${v}。`,
                buttons: ['确定'],
            });
        }
        manualCheck = false;
        checking = false;
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
        manualCheck = false;
        checking = false;
    });
    autoUpdater.on('error', (e) => {
        // 手动检查失败：一定弹窗告知（不再被短超时静默吞掉）
        if (manualCheck && mainWindow) {
            dialog.showErrorBox('检查更新失败', `更新检查出错：\n${(e && e.message) || e}`);
        } else {
            // 静默失败，不打扰用户（多为未配置更新服务器 / 网络问题）
            console.error('[desktop] autoUpdater error:', e && e.message);
        }
        manualCheck = false;
        checking = false;
    });

    // 暴露手动检查入口：菜单「检查更新」/托盘菜单调用
    manualCheckFn = () => {
        if (checking) return;            // 正在检查则忽略重复点击
        manualCheck = true;
        checking = true;
        // 启动检查；错误交由上面的 error 事件统一弹窗（此处不复位 manualCheck，
        // 否则网络慢时 10s 内错误事件未到就被置 false → 静默失败、用户"没反应"）
        autoUpdater.checkForUpdates().catch(() => { /* error 事件会处理 */ });
        // 安全兜底：120s 仍无结果则静默复位（GitHub 国内超时通常 <60s，error 事件会先到）。
        // 仅复位标志，不弹窗，避免与后台下载中的「更新就绪」提示冲突。
        setTimeout(() => {
            if (checking) { checking = false; manualCheck = false; }
        }, 120000);
    };

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
            preload: path.join(__dirname, 'preload.js'),   // 受控桥：原生存储 / 后续同步能力
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
        // 首屏显示后再检查更新，避免与首屏渲染抢网络/主线程资源
        setTimeout(setupAutoUpdater, 1500);
    });

    // 点 X / 触发关闭：未真正退出时改为隐藏到托盘，而非销毁窗口
    mainWindow.on('close', (e) => {
        if (!isQuiting) {
            e.preventDefault();
            mainWindow.hide();
        }
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
                    click: () => manualCheckUpdate(),
                },
                { label: '关于', click: showAbout },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 托盘（最小化到托盘）与窗口显隐 ----------
/** 显示并聚焦主窗口；若窗口已被销毁则重建 */
function showMainWindow() {
    if (!mainWindow) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

/** 真正退出：置标志后退出，使 close 事件不再被拦截 */
function quitApp() {
    isQuiting = true;
    app.quit();
}

/** 手动检查更新（菜单「帮助 → 检查更新」与托盘菜单共用，避免重复逻辑） */
function manualCheckUpdate() {
    if (!isUpdateConfigured()) {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '尚未配置更新',
            message: '自动更新尚未配置。\n请在 package.json 的 build.publish 填写 GitHub 的 owner / repo，并设置 GH_TOKEN 后重新发布安装包。',
            buttons: ['确定'],
        });
        return;
    }
    if (!autoUpdater) {
        dialog.showErrorBox('更新不可用', '未配置自动更新服务（electron-updater 未安装）。');
        return;
    }
    // 若首屏 1.5s 内用户就点了检查（更新器尚未初始化），先初始化（带守卫，不会重复监听）
    if (!updaterInitialized) setupAutoUpdater();
    if (manualCheckFn) manualCheckFn();
    else autoUpdater.checkForUpdates().catch(() => {});
}

/** 创建系统托盘：图标复用 assets/icon.ico（缺失则回退 icon.png），左键单击切换显隐，右键菜单含退出 */
function createTray() {
    try {
        const icoPath = path.join(__dirname, 'assets', 'icon.ico');
        const pngPath = path.join(__dirname, 'assets', 'icon.png');
        let trayIcon = nativeImage.createFromPath(icoPath);
        // 打包若漏了 assets 或 ico 加载失败，回退到 icon.png
        if (trayIcon.isEmpty() && fs.existsSync(pngPath)) {
            trayIcon = nativeImage.createFromPath(pngPath);
        }
        if (trayIcon.isEmpty()) {
            console.warn('[desktop] 托盘图标 assets/icon.ico/png 加载失败，托盘可能显示空白');
        }
        tray = new Tray(trayIcon);
        tray.setToolTip(`${APP_NAME} - 已最小化到托盘`);

        const rebuildTrayMenu = () => {
            const menu = Menu.buildFromTemplate([
                { label: '显示窗口', click: () => showMainWindow() },
                {
                    label: '检查更新',
                    click: () => manualCheckUpdate(),
                },
                { type: 'separator' },
                { label: '退出', click: () => quitApp() },
            ]);
            tray.setContextMenu(menu);
        };
        rebuildTrayMenu();

        // 左键单击：可见则隐藏，隐藏则显示（与右键「显示窗口」一致）
        tray.on('click', () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else showMainWindow();
        });
    } catch (e) {
        // 托盘创建失败不应影响主流程（如无桌面环境）
        console.error('[desktop] 托盘创建失败', e && e.message);
    }
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
    setupStorageIPC();   // 必须在 createWindow 之前注册，否则页面首帧就可能读不到数据
    setupWebdavIPC();    // WebDAV 同步：主进程代发请求，绕开渲染进程 CORS
    setupSecretIPC();    // WebDAV 密码：safeStorage 加密存储
    buildMenu();
    setupDownloads();
    createWindow();
    createTray();

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
