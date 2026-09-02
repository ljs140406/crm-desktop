/**
 * 把源 HTML 同步进 app/，并注入桌面端样式。
 * 这样以后改完 crm-app-mobile.html，直接 `npm run dist` 就能带上最新内容，
 * 不需要手工复制粘贴，也不用改源文件本身。
 */
const fs = require('fs');
const path = require('path');

// 源单文件版 HTML（唯一源，由用户日常维护）
const SOURCE = path.resolve('E:/分贝通资料/测试的/crm-app-mobile.html');
const TARGET_DIR = path.join(__dirname, 'app');
const TARGET = path.join(TARGET_DIR, 'crm-app.html');
const CSS_TAG = '<link rel="stylesheet" href="desktop.css">';

function sync() {
    if (!fs.existsSync(SOURCE)) {
        console.error('[sync] 找不到源文件：' + SOURCE);
        process.exit(1);
    }
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    let html = fs.readFileSync(SOURCE, 'utf8');

    // 注入桌面端样式（幂等：已注入过就跳过）
    if (html.indexOf('desktop.css') === -1) {
        const idx = html.lastIndexOf('</head>');
        if (idx === -1) {
            console.error('[sync] 源 HTML 中没有 </head>，无法注入样式');
            process.exit(1);
        }
        html = html.slice(0, idx) + '    ' + CSS_TAG + '\n' + html.slice(idx);
    }

    fs.writeFileSync(TARGET, html, 'utf8');
    const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
    console.log('[sync] 已同步 ' + kb + ' KB -> app/crm-app.html');
}

sync();
