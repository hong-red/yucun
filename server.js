// ============================================================
// 渔村智慧助手 — 后端服务
// 功能：天气API代理、DeepSeek AI诊断代理、静态文件托管
// ============================================================

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

// 统一 fetch 封装（使用 Node.js 内置 https/http 模块，自动检测代理）
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';

function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);

        // 如果有代理，通过 HTTP CONNECT 隧道走代理
        if (PROXY && !parsed.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
            const proxyUrl = new URL(PROXY);
            const connectReq = http.request({
                host: proxyUrl.hostname,
                port: proxyUrl.port || 80,
                method: 'CONNECT',
                path: `${parsed.hostname}:${parsed.port || 443}`,
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`代理连接失败: ${res.statusCode}`));
                    return;
                }
                const tls = require('tls');
                const tlsSocket = tls.connect({
                    socket: socket,
                    servername: parsed.hostname,
                }, () => {
                    const reqPath = parsed.pathname + parsed.search;
                    let reqStr = `${options.method || 'GET'} ${reqPath} HTTP/1.1\r\nHost: ${parsed.hostname}\r\n`;
                    const headers = options.headers || {};
                    headers['Host'] = parsed.hostname;
                    if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body);
                    for (const [k, v] of Object.entries(headers)) {
                        if (k.toLowerCase() !== 'host') reqStr += `${k}: ${v}\r\n`;
                    }
                    reqStr += '\r\n';
                    if (options.body) reqStr += options.body;

                    tlsSocket.write(reqStr);

                    let rawData = Buffer.alloc(0);
                    let resolved = false;

                    tlsSocket.on('data', chunk => {
                        rawData = Buffer.concat([rawData, chunk]);
                    });

                    tlsSocket.on('end', () => {
                        if (resolved) return;
                        resolved = true;
                        const str = rawData.toString();
                        const headerEnd = str.indexOf('\r\n\r\n');
                        if (headerEnd === -1) { reject(new Error('响应不完整')); return; }
                        const headerPart = str.substring(0, headerEnd);
                        const status = parseInt(headerPart.split(' ')[1]);
                        const isChunked = headerPart.toLowerCase().includes('transfer-encoding: chunked');
                        let rawBody = str.substring(headerEnd + 4);

                        let bodyPart;
                        if (isChunked) {
                            // 用 Buffer 正确解码 chunked body（避免多字节字符被截断）
                            const rawBuf = rawData.subarray(headerEnd + 4);
                            const chunks = [];
                            let pos = 0;
                            while (pos < rawBuf.length) {
                                // 找 chunk size 行
                                let lineEnd = -1;
                                for (let i = pos; i < rawBuf.length - 1; i++) {
                                    if (rawBuf[i] === 0x0d && rawBuf[i+1] === 0x0a) { lineEnd = i; break; }
                                }
                                if (lineEnd === -1) break;
                                const sizeStr = rawBuf.subarray(pos, lineEnd).toString().split(';')[0].trim();
                                const chunkSize = parseInt(sizeStr, 16);
                                if (isNaN(chunkSize) || chunkSize === 0) break;
                                chunks.push(rawBuf.subarray(lineEnd + 2, lineEnd + 2 + chunkSize));
                                pos = lineEnd + 2 + chunkSize + 2;
                            }
                            bodyPart = Buffer.concat(chunks).toString('utf8');
                        } else {
                            bodyPart = rawBody;
                        }

                        resolve({
                            ok: status >= 200 && status < 300,
                            status: status,
                            json: () => Promise.resolve(JSON.parse(bodyPart)),
                            text: () => Promise.resolve(bodyPart),
                        });
                    });

                    tlsSocket.on('error', e => { if (!resolved) reject(e); });
                    tlsSocket.setTimeout(60000, () => { if (!resolved) { tlsSocket.destroy(); reject(new Error('AI 响应超时')); } });
                });
            });

            connectReq.on('error', e => reject(e));
            connectReq.setTimeout(15000, () => { connectReq.destroy(); reject(new Error('代理连接超时')); });
            connectReq.end();
            return;
        }

        // 无代理，直连
        const lib = parsed.protocol === 'https:' ? https : http;
        const reqOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };

        const req = lib.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: () => Promise.resolve(JSON.parse(data)),
                        text: () => Promise.resolve(data),
                    });
                } catch (e) {
                    resolve({ ok: false, status: res.statusCode, text: () => Promise.resolve(data), json: () => Promise.resolve({}) });
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });

        if (options.body) req.write(options.body);
        req.end();
    });
}

const app = express();
const PORT = process.env.PORT || 8383;

// ============================================================
// 配置（API Key 安全存储在后端，不暴露给前端）
// ============================================================
const CONFIG = {
    AMAP_KEY: process.env.AMAP_KEY || 'c40aa3998d164cc816e618f7f0a1dbb1',
    DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',  // 请在环境变量 DEEPSEEK_KEY 中配置，勿提交真实密钥
    DEEPSEEK_URL: 'https://api.deepseek.com/chat/completions',
    AMAP_WEATHER_URL: 'https://restapi.amap.com/v3/weather/weatherInfo',
    AMAP_GEO_URL: 'https://restapi.amap.com/v3/geocode/regeo',
    DEFAULT_ADCODE: '110117', // 平谷区
};

// ============================================================
// 中间件
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 请求日志
app.use((req, res, next) => {
    const now = new Date().toLocaleString('zh-CN');
    console.log(`[${now}] ${req.method} ${req.path}`);
    next();
});

// ============================================================
// API 路由
// ============================================================

/**
 * GET /api/weather/live?city=110117
 * 获取实况天气（代理高德天气 API）
 */
app.get('/api/weather/live', async (req, res) => {
    try {
        const city = req.query.city || CONFIG.DEFAULT_ADCODE;
        const url = `${CONFIG.AMAP_WEATHER_URL}?city=${city}&key=${CONFIG.AMAP_KEY}&extensions=base`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status === '1' && data.lives && data.lives.length > 0) {
            res.json({ success: true, data: data.lives[0] });
        } else {
            res.json({ success: false, error: data.info || '天气数据获取失败' });
        }
    } catch (err) {
        console.error('天气实况请求失败:', err.message);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

/**
 * GET /api/weather/forecast?city=110117
 * 获取天气预报（代理高德天气 API）
 */
app.get('/api/weather/forecast', async (req, res) => {
    try {
        const city = req.query.city || CONFIG.DEFAULT_ADCODE;
        const url = `${CONFIG.AMAP_WEATHER_URL}?city=${city}&key=${CONFIG.AMAP_KEY}&extensions=all`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status === '1' && data.forecasts && data.forecasts.length > 0) {
            const forecast = data.forecasts[0];
            // 后端计算洪涝风险评估
            const riskAnalysis = analyzeFloodRisk(forecast.casts);
            res.json({
                success: true,
                data: forecast,
                risk: riskAnalysis
            });
        } else {
            res.json({ success: false, error: data.info || '预报数据获取失败' });
        }
    } catch (err) {
        console.error('天气预报请求失败:', err.message);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

/**
 * GET /api/geocode/regeo?lng=116.5&lat=40.1
 * 逆地理编码（代理高德 API）
 */
app.get('/api/geocode/regeo', async (req, res) => {
    try {
        const { lng, lat } = req.query;
        if (!lng || !lat) {
            return res.status(400).json({ success: false, error: '缺少经纬度参数' });
        }
        const url = `${CONFIG.AMAP_GEO_URL}?location=${lng},${lat}&key=${CONFIG.AMAP_KEY}&output=JSON`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status === '1' && data.regeocode) {
            const ac = data.regeocode.addressComponent;
            res.json({
                success: true,
                data: {
                    province: ac.province,
                    city: ac.city,
                    district: ac.district,
                    adcode: ac.adcode,
                    township: ac.township,
                    formattedAddress: data.regeocode.formattedAddress
                }
            });
        } else {
            res.json({ success: false, error: '地理编码失败' });
        }
    } catch (err) {
        console.error('地理编码请求失败:', err.message);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

/**
 * POST /api/diagnose
 * AI 鱼病诊断（代理 DeepSeek API）
 * 前端发送症状列表，后端构建 prompt 调用 AI
 */
app.post('/api/diagnose', async (req, res) => {
    try {
        const { symptoms, extraDesc, location } = req.body;

        if (!symptoms || symptoms.length === 0) {
            return res.status(400).json({ success: false, error: '请至少选择一个症状' });
        }

        const locationInfo = location || '北京平谷区';

        const prompt = `你是一位经验丰富的水产养殖病害专家，现在在${locationInfo}的淡水鱼养殖场工作。

渔民报告了以下鱼病症状：
${symptoms.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${extraDesc ? '\n渔民补充描述：' + extraDesc : ''}

请严格按以下 JSON 格式回复（不要加 markdown 代码块标记，直接输出纯 JSON）：
{
  "disease": "最可能的病害名称",
  "confidence": "高/中/低",
  "severity": "高/中/低",
  "description": "病害的详细描述，包括病因、危害对象、流行条件等，2-3句话",
  "treatment": "具体治疗方案，包括用药名称、用量、用法，分步骤列出",
  "prevention": "预防措施和注意事项，2-3条",
  "needReport": true/false,
  "reportReason": "如果需要上报政府，说明原因；否则为空字符串"
}

注意：
- severity 为"高"时 needReport 必须为 true
- 治疗方案要具体到药品名称和用量
- 用渔民能听懂的语言，不要用太多专业术语`;

        console.log(`[诊断] 收到 ${symptoms.length} 个症状，调用 DeepSeek AI...`);

        const aiStart = Date.now();
        const response = await fetch(CONFIG.DEEPSEEK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.DEEPSEEK_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: '你是一位专业的水产养殖病害诊断专家，擅长淡水鱼病害识别和治疗。请始终用中文回复，并以纯 JSON 格式输出诊断结果。'
                    },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 1000
            })
        });

        const aiTime = Date.now() - aiStart;

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[诊断] DeepSeek API 错误 ${response.status}:`, errText);
            return res.status(response.status).json({
                success: false,
                error: `AI 服务暂时不可用 (${response.status})`,
                aiTime
            });
        }

        const data = await response.json();
        let content = data.choices[0].message.content.trim();

        // 清理可能的 markdown 代码块标记
        content = content.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

        let result;
        try {
            result = JSON.parse(content);
        } catch (parseErr) {
            console.error('[诊断] JSON 解析失败，原始内容:', content);
            // 尝试从内容中提取 JSON
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
            } else {
                return res.json({
                    success: false,
                    error: 'AI 返回格式异常，请重试',
                    rawContent: content,
                    aiTime
                });
            }
        }

        console.log(`[诊断] 完成: ${result.disease} (严重度: ${result.severity}, 耗时: ${aiTime}ms)`);

        res.json({
            success: true,
            data: result,
            aiTime
        });

    } catch (err) {
        console.error('[诊断] 服务器错误:', err);
        res.status(500).json({ success: false, error: '服务器内部错误' });
    }
});

/**
 * POST /api/report
 * 政府上报接口（MVP 阶段记录日志，后续对接真实政府系统）
 */
app.post('/api/report', (req, res) => {
    const { disease, severity, description, treatment, reportReason, location } = req.body;
    const timestamp = new Date().toLocaleString('zh-CN');

    console.log('========== 政府上报 ==========');
    console.log(`时间: ${timestamp}`);
    console.log(`位置: ${location || '未知'}`);
    console.log(`病害: ${disease}`);
    console.log(`严重度: ${severity}`);
    console.log(`描述: ${description}`);
    console.log(`上报原因: ${reportReason}`);
    console.log('=============================');

    // MVP 阶段：记录日志并返回成功
    // 生产环境：对接政府系统 API，发送标准化报告
    res.json({
        success: true,
        message: '报告已提交',
        reportId: `RPT-${Date.now()}`,
        timestamp
    });
});

// ============================================================
// 洪涝风险评估逻辑（后端计算，确保逻辑不可被篡改）
// ============================================================
function analyzeFloodRisk(casts) {
    if (!casts || casts.length === 0) {
        return { level: 'unknown', score: 0, days: [], advice: '', measures: [] };
    }

    let maxRiskScore = 0;
    const riskDays = [];

    casts.forEach(c => {
        const dayW = c.dayweather + c.nightweather;
        let dayRisk = 0;
        let rainLevel = '无雨';

        if (dayW.includes('特大暴雨')) { dayRisk = 100; rainLevel = '特大暴雨'; }
        else if (dayW.includes('大暴雨')) { dayRisk = 85; rainLevel = '大暴雨'; }
        else if (dayW.includes('暴雨')) { dayRisk = 70; rainLevel = '暴雨'; }
        else if (dayW.includes('大雨') || dayW.includes('强雷阵雨')) { dayRisk = 55; rainLevel = '大雨'; }
        else if (dayW.includes('中雨') || dayW.includes('雷阵雨')) { dayRisk = 40; rainLevel = '中雨'; }
        else if (dayW.includes('小雨') || dayW.includes('阵雨')) { dayRisk = 20; rainLevel = '小雨'; }

        if (dayRisk > 0) {
            riskDays.push({ date: c.date, dayweather: c.dayweather, nightweather: c.nightweather, level: rainLevel, risk: dayRisk });
        }
        maxRiskScore = Math.max(maxRiskScore, dayRisk);
    });

    let level, classType, advice;
    if (maxRiskScore >= 70) {
        level = '高风险';
        classType = 'danger';
        advice = '严重警告：预报有暴雨以上降雨，漫塘逃鱼风险极高！请立即采取防汛措施：降低鱼塘水位、加固塘埂、备好增氧机和防逃网。';
    } else if (maxRiskScore >= 40) {
        level = '中等风险';
        classType = 'warn';
        advice = '注意：未来几天有中到大雨，存在一定洪涝风险。建议提前检查排水设施，适当降低水位，做好防逃准备。';
    } else if (maxRiskScore >= 20) {
        level = '低风险';
        classType = 'warn';
        advice = '轻微注意：未来有小雨，当前风险不大。保持日常巡塘，注意排水口畅通即可。';
    } else {
        level = '安全';
        classType = 'safe';
        advice = '未来几天无明显降雨，洪涝风险低。保持正常养殖管理即可。';
    }

    // 生成防汛措施清单
    const measures = [];
    if (maxRiskScore >= 70) {
        measures.push({ text: '立即降低鱼塘水位 30-50cm', priority: '紧急' });
        measures.push({ text: '加固塘埂，封堵所有低洼缺口', priority: '紧急' });
        measures.push({ text: '检查并确保排水口、溢洪道畅通', priority: '紧急' });
        measures.push({ text: '备好增氧机，暴雨后立即开启', priority: '重要' });
        measures.push({ text: '安装防逃网，防止漫塘逃鱼', priority: '重要' });
        measures.push({ text: '将增氧设备、发电机检查就位', priority: '重要' });
        measures.push({ text: '安排人员24小时值班巡查', priority: '重要' });
    } else if (maxRiskScore >= 40) {
        measures.push({ text: '检查鱼塘排水口是否畅通', priority: '建议' });
        measures.push({ text: '提前降低鱼塘水位 20-30cm', priority: '建议' });
        measures.push({ text: '加固塘埂，封堵低洼缺口', priority: '建议' });
        measures.push({ text: '备好增氧机，防止暴雨后缺氧', priority: '建议' });
        measures.push({ text: '准备防逃网，防止漫塘逃鱼', priority: '建议' });
    } else if (maxRiskScore >= 20) {
        measures.push({ text: '检查排水口畅通', priority: '提醒' });
        measures.push({ text: '关注天气变化', priority: '提醒' });
    } else {
        measures.push({ text: '正常巡塘管理', priority: '日常' });
        measures.push({ text: '关注后续天气更新', priority: '日常' });
    }

    return {
        score: maxRiskScore,
        level,
        classType,
        advice,
        days: riskDays,
        measures
    };
}

// ============================================================
// 前端路由回退（所有非 API 请求返回 index.html）
// ============================================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('🐟 渔村智慧助手 后端服务已启动');
    console.log(`   本地访问: http://localhost:${PORT}`);
    console.log(`   局域网访问: http://<你的IP>:${PORT}`);
    console.log(`   环境: ${process.env.NODE_ENV || 'development'}`);
    console.log('');
    console.log('   API 路由:');
    console.log('   GET  /api/weather/live     — 实况天气');
    console.log('   GET  /api/weather/forecast  — 天气预报 + 洪涝风险');
    console.log('   GET  /api/geocode/regeo     — 逆地理编码');
    console.log('   POST /api/diagnose          — AI 鱼病诊断');
    console.log('   POST /api/report            — 政府上报');
    console.log('');
});