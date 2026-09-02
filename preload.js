/**
 * 桌面端预加载脚本（contextIsolation: true 下的受控桥）
 *
 * 只暴露极小的 API 面，避免把整个 Node/IPC 能力暴露给页面：
 *   - electronAPI.storage：原生文件读写（替代 localStorage，数据落 userData/crm-store.json）
 *   - 后续同步能力（WebDAV）也会从这里以最小接口挂出
 *
 * 说明：读取用 ipcRenderer.sendSync 是刻意为之——页面启动加载数据时必须同步拿到
 * 内容（CRMStore 对上层保持同步 KV 语义），异步会导致 init 流程读到空数据。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // ---------- 原生存储（替代 localStorage）----------
    storage: {
        /** 同步读取全部 KV（JSON 字符串）；文件不存在返回空串 */
        loadSync: () => ipcRenderer.sendSync('crm-storage:load'),
        /** 同步写入全部 KV（JSON 字符串）；返回是否成功 */
        saveSync: (raw) => ipcRenderer.sendSync('crm-storage:save', raw),
    },

    // ---------- WebDAV 通道（在 main 进程发请求，绕开渲染进程 CORS）----------
    webdav: {
        /**
         * @param {{method:string,url:string,headers:Object,body:string|null}} opts
         * @returns {Promise<{status:number,data:string,headers:Object}>}
         */
        request: (opts) => ipcRenderer.invoke('crm-webdav:request', opts),
    },

    // ---------- 系统安全存储（safeStorage 加密，仅本机可解密）----------
    secret: {
        /** 读取加密项；无或解密失败返回空串 */
        get: (key) => ipcRenderer.sendSync('crm-secret:get', key),
        /** 写入加密项；返回是否成功（false 表示系统安全存储不可用，调用方应回落本地存储） */
        set: (key, value) => ipcRenderer.sendSync('crm-secret:set', key, value),
    },

    // ---------- 自动更新：主进程转发进度/状态到渲染进程，渲染进程用下载框展示 ----------
    // 通道约定（main→renderer）：
    //   crm-update:available    payload: info（含 version）
    //   crm-update:progress     payload: {percent, transferred, total}
    //   crm-update:downloaded   payload: info（含 version）
    //   crm-update:not-available payload: info|undefined
    //   crm-update:error        payload: msg(string)
    updater: {
        /** 手动触发一次检查（菜单/页面按钮调用） */
        check: () => ipcRenderer.invoke('crm-update:check'),
        /** 下载完成后触发安装（立即重启） */
        install: () => ipcRenderer.invoke('crm-update:install'),
        onAvailable: (cb) => ipcRenderer.on('crm-update:available', (_e, info) => cb && cb(info)),
        onProgress: (cb) => ipcRenderer.on('crm-update:progress', (_e, p) => cb && cb(p)),
        onDownloaded: (cb) => ipcRenderer.on('crm-update:downloaded', (_e, info) => cb && cb(info)),
        onNotAvailable: (cb) => ipcRenderer.on('crm-update:not-available', () => cb && cb()),
        onError: (cb) => ipcRenderer.on('crm-update:error', (_e, msg) => cb && cb(msg)),
    },
});
