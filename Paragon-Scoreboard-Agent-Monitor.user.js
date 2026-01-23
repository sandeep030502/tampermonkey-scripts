// ==UserScript==
// @name         Agent Scoreboard Pro + Slaris +ai (final)
// @namespace    https://github.com/sandeep030502/tampermonkey-scripts
// @version      1.0
// @description  Paragon Scoreboard + Slaris (Pulsing Dot Indicator)
// @author       @ysaisan
// @match        https://paragon-na.amazon.com/hz/*
// @updateURL    https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Scoreboard-Agent-Monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Scoreboard-Agent-Monitor.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
    "use strict";

    /* ───────── CONFIGURATION ───────── */
    const STORAGE_KEY_LOGIN = 'scoreboard_login_v26';
    const STORAGE_KEY_DATA = 'scoreboard_data_v26';
    const REALTIME_URL = 'https://c2-na-prod.awsapps.com/connect/awas/api/v1/rtm-tables';
    const SEARCH_API_URL = '/hz/api/search';
    const PROFILE_ID = "7c680a87-92df-4c98-95e7-e182acfe5b4a";

    // --- SLARIS CONFIG ---
    const SLA_REFRESH_INTERVAL = 60000; // 60s
    const CONCURRENCY = 5;
    const PAGE_SIZE = 75;
    const SLA_THR = {
        PRILO:    { ok: 5,   alertLo: 10,  alertHi: 14 },
        OB:       { ok: 15,  alertLo: 20,  alertHi: 29 },
        IB:       { ok: 30,  alertLo: 45,  alertHi: 59 },
        IB_OTHER: { ok: 120, alertLo: 145, alertHi: 179 },
    };
    const SLA_QUEUES = {
        PRILO: ['toc-na-priority-loads'],
        OB:    ['toc-na-support'],
        IB:    ['toc-ib-na-freight-refusals','toc-ib-na-po-bol-mismatch','noc-na-misships','roc-ib-na-split-shipments','toc-ib-na-other-issues']
    };
    const SLA_QUERY = `(queue:"toc-na-support@amazon.com" OR queue:"toc-na-priority-loads@amazon.com" OR queue:"toc-ib-na-other-issues@amazon.com" OR queue:"toc-ib-na-freight-refusals@amazon.com" OR queue:"noc-na-misships@amazon.com" OR queue:"roc-ib-na-split-shipments@amazon.com") AND (status:"Pending Amazon Action" OR status:"Unassigned" OR status:"Work-in-Progress")`;

    // Global State for Dashboard
    let liveCases = [];
    let liveStats = { PRILO: 0, OB: 0, IB: 0, PRILO_TOT: 0, OB_TOT: 0, IB_TOT: 0 };
    let dashRef = null;



/* ───────── GEMINI AI (ADD THIS) ───────── */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";
const DEFAULT_MODEL = "gemini-2.5-flash";

async function callGeminiSummary(apiKey, text) {
    if (!apiKey) return "❌ Gemini API key missing";

    const url = `${GEMINI_BASE_URL}${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

    const payload = {
        contents: [{
            parts: [{
                text: `Summarize the following text in 3 bullet points:\n\n${text}`
            }]
        }]
    };

    return new Promise((resolve) => {
        GM_xmlhttpRequest({
            method: "POST",
            url,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    resolve(
                        data.candidates?.[0]?.content?.parts?.[0]?.text ||
                        "⚠️ No response from Gemini"
                    );
                } catch {
                    resolve("⚠️ Gemini response error");
                }
            },
            onerror: () => resolve("❌ Gemini request failed")
        });
    });
}



    /* ───────── 1. CORE NETWORK LOGIC ───────── */

    function getParagonToken() {
        const match = document.cookie.match(/pgn_csrf_token=([^;]+)/);
        if (match && match[1]) return decodeURIComponent(match[1]);
        const el = document.getElementById('csrfToken') || document.querySelector('input[name="csrfToken"]');
        return el ? el.value : '';
    }

    // A. AGENT MONITOR (CCP)
    function gmFetch(url, options) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                data: options.body,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try { resolve(JSON.parse(response.responseText)); }
                        catch (e) { reject("JSON Parse Error"); }
                    } else { reject(`Error: ${response.status}`); }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    async function fetchRealtimeData(agentId) {
        const payload = {
            "realTmeContactLensEnabled": true,
            "requests": [{
                "agentsFilter": [], "agentsFor": {"expandGroup": true, "type": "Profile"}, "channelFilter": [],
                "cols": ["AGENT_VIEW_LOGIN", "AGENT_VIEW_STATE", "AGENT_VIEW_STATE_DURATION"],
                "filterEntityList": [{"resourceId": PROFILE_ID}], "filterResourceIdList": [PROFILE_ID],
                "filterType": "PROFILE", "grouping": {"groupByProfile": false},
                "name": "Agents", "pageOffset": 0, "pageSize": 100,
                "sorting": {"ascending": true, "colId": "AGENT_VIEW_LOGIN"},
                "subType": "AGENT", "timerWindowType": "TRAILING", "timezoneId": {"id": "UTC", "text": "UTC"},
                "totalMetricsCount": 50, "trailingWindowValue": "2", "type": "AGENT"
            }]
        };

        try {
            const data = await gmFetch(REALTIME_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const rows = data.requests?.[0]?.table?.agentEntryRows || [];
            const target = agentId.trim().toLowerCase();
            const agent = rows.find(r => {
                const login = (r.voiceContactEntryRow?.metrics?.AGENT_VIEW_LOGIN || r.metrics?.AGENT_VIEW_LOGIN || "").toLowerCase();
                return login.includes(target);
            });
            if (agent) {
                const m = agent.voiceContactEntryRow ? agent.voiceContactEntryRow.metrics : agent.metrics;
                return { status: m.AGENT_VIEW_STATE, duration: m.AGENT_VIEW_STATE_DURATION };
            }
            return { error: "Name Not Found" };
        } catch (e) { return { error: "Net/Auth Err" }; }
    }

    // B. CASE COUNTER (API)
    async function fetchAssignedCases(alias) {
        if(!alias) return "--";
        try {
            const token = getParagonToken();
            if (!token) return "Auth?";

            const payload = {
                "query": `owner:"${alias}" AND (status:"Carrier Action Completed" OR status:"FC Action Completed" OR status:"Pending Amazon Action" OR status:"Pending Carrier Action" OR status:"Pending FC Action" OR status:"Reopened" OR status:"Work-in-Progress")`,
                "contentTypes": [{ "contentType": "CASE", "pageSize": "75", "pageNum": 1, "sortOrder": "asc", "sortField": "status" }],
                "searchAllTenants": false, "typeAhead": false
            };

            const response = await fetch(SEARCH_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'pgn-csrf-token': token },
                body: JSON.stringify(payload)
            });

            if (response.status === 403) return "403";
            if (!response.ok) return "Err";

            const data = await response.json();
            if (data.payload && data.payload.resultsByContentType && data.payload.resultsByContentType.CASE) {
                return data.payload.resultsByContentType.CASE.totalCount || 0;
            }
            return "0";
        } catch (e) { console.error(e); return "Err"; }
    }

    // C. SLARIS LOGIC (RINGS & DASHBOARD)
    async function fetchSlaPage(pageNum) {
        const token = getParagonToken();
        if (!token) return null;
        const payload = {
            "typeAhead": false, "query": SLA_QUERY,
            "contentTypes": [{"contentType": "CASE", "pageSize": PAGE_SIZE, "pageNum": pageNum, "sortOrder": "desc", "sortField": "creationDate"}],
            "searchAllTenants": false
        };
        try {
            const res = await fetch(SEARCH_API_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'pgn-csrf-token': token },
                body: JSON.stringify(payload)
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }

    async function fetchSlaHistory(caseId) {
        const token = getParagonToken();
        if (!token) return [];
        try {
            const res = await fetch(`/hz/api/case/history/get?caseId=${caseId}&sort=desc`, { headers: { 'pgn-csrf-token': token } });
            if (!res.ok) return [];
            const d = await res.json();
            return d.entries || [];
        } catch(e) { return []; }
    }

    function getSlaQueueCategory(q) {
        q = (q || '').toLowerCase();
        if (SLA_QUEUES.PRILO.some(x => q.includes(x))) return 'PRILO';
        if (SLA_QUEUES.OB.some(x => q.includes(x))) return 'OB';
        if (SLA_QUEUES.IB.some(x => q.includes(x))) return 'IB';
        return 'UNKNOWN';
    }

    function determineSlaStart(entries) {
        if (!entries || !entries.length) return Date.now();
        for (const e of entries) {
            const op = (e.operation || '').toLowerCase();
            const st = String(e.status || e.newStatus || e.newState || "").toUpperCase();
            if (op === 'createcase' || op === 'transfercasetoqueue' || op === 'replytocase') return (e.updatingDate || e.timestamp);
            if (st === 'PA' || st === 'PENDING AMAZON ACTION') return (e.updatingDate || e.timestamp);
        }
        const last = entries[entries.length-1];
        return (last.updatingDate || last.timestamp || Date.now());
    }

    /* ───────── DASHBOARD POPUP LOGIC ───────── */
    function openDashboard() {
        if (dashRef && !dashRef.closed) { dashRef.focus(); return; }
        dashRef = window.open('', '_blank');
        if (!dashRef) { alert('Popup blocked'); return; }

        dashRef.document.write(`
        <!doctype html><html><head><title>Slaris Live Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
        <style>
        body{margin:0;background:#070b14;color:#e6f0ff;font-family:sans-serif;overflow-x:hidden}
        .page{max-width:1100px;margin:0 auto;padding:18px}
        header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
        .btn{padding:5px 10px;border-radius:8px;border:1px solid #444;background:#222;color:#fff;cursor:pointer}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
        .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px;text-align:center}
        canvas{max-width:180px;max-height:180px;margin:0 auto}
        table{width:100%;border-collapse:collapse;margin-top:14px}
        th,td{padding:8px;border-bottom:1px solid #333;text-align:left}
        a{color:#e6f0ff;text-decoration:none}
        .alert-row{background:rgba(255,215,0,0.16)}
        .tabs { display: flex; gap: 10px; margin-top: 20px; border-bottom: 1px solid #444; }
        .tab-btn { background: #1a1a1a; color: #888; border: none; padding: 10px 20px; cursor: pointer; border-radius: 8px 8px 0 0; font-weight: bold; }
        .tab-btn.active { background: #333; color: #fff; border-bottom: 2px solid #007FFF; }
        .tab-content { display: none; padding: 10px; background: #111; border-radius: 0 0 8px 8px; }
        .tab-content.active { display: block; }
        </style></head><body>
        <div class="page">
          <header><h1>Slaris Live View (Alerts Only)</h1><button class="btn" onclick="window.opener.postMessage({type:'sla-request-refresh'},'*')">Refresh Scan</button></header>
          <h2>Live Lobby Risk</h2>
          <section class="grid">
              <div class="card">PRILO Alerts<canvas id="aPr"></canvas></div>
              <div class="card">OB Alerts<canvas id="aOb"></canvas></div>
              <div class="card">IB Alerts<canvas id="aIb"></canvas></div>
          </section>
          <div class="tabs">
              <button class="tab-btn active" onclick="openTab('tab-PRILO')">PRILO</button>
              <button class="tab-btn" onclick="openTab('tab-OB')">OB</button>
              <button class="tab-btn" onclick="openTab('tab-IB')">IB</button>
          </div>
          <div id="tab-PRILO" class="tab-content active"><table><thead><tr><th>ID</th><th>Mins</th><th>Status</th><th>Link</th></tr></thead><tbody id="tbody-PRILO"></tbody></table></div>
          <div id="tab-OB" class="tab-content"><table><thead><tr><th>ID</th><th>Mins</th><th>Status</th><th>Link</th></tr></thead><tbody id="tbody-OB"></tbody></table></div>
          <div id="tab-IB" class="tab-content"><table><thead><tr><th>ID</th><th>Mins</th><th>Status</th><th>Link</th></tr></thead><tbody id="tbody-IB"></tbody></table></div>
        </div>
        <script>
        let charts={};
        function mkAlertChart(id, al, tot){
             const ctx=document.getElementById(id); if(charts[id])charts[id].destroy();
             const safe = Math.max(0, tot - al);
             charts[id]=new Chart(ctx,{type:'doughnut',data:{labels:['Alerts','Safe'],datasets:[{data:[al,safe],backgroundColor:['#FFD700','rgba(255,255,255,0.1)'],borderWidth:0}]},options:{cutout:'70%',plugins:{legend:{display:false}}}});
        }
        window.openTab = function(id) {
            document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(e => e.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            event.target.classList.add('active');
        }
        window.addEventListener('message',e=>{
            if(e.data.type!=='sla-snapshot')return;
            const p=e.data.payload;
            mkAlertChart('aPr', p.live.PRILO, p.live.PRILO_TOT);
            mkAlertChart('aOb', p.live.OB, p.live.OB_TOT);
            mkAlertChart('aIb', p.live.IB, p.live.IB_TOT);

            ['PRILO','OB','IB'].forEach(q => {
                const tb = document.getElementById('tbody-'+q); tb.innerHTML='';
                const qCases = p.cases.filter(c => c.queue === q);
                qCases.sort((a,b) => b.duration - a.duration);
                qCases.forEach(c=>{
                    tb.innerHTML += '<tr class="alert-row"><td>'+c.caseID+'</td><td>'+c.duration+'</td><td>'+c.status+'</td><td><a href="'+c.url+'" target="_blank">View</a></td></tr>';
                });
                if(qCases.length === 0) tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#666">No Alert Cases</td></tr>';
            });
        });
        window.opener.postMessage({type:'sla-dashboard-ready'},'*');
        <\/script></body></html>`);
        dashRef.document.close();
    }

    /* ───────── 2. DRAG & DROP UTILS ───────── */
    function makeDraggable(element, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handle.onmousedown = dragMouseDown;
        function dragMouseDown(e) {
            e.preventDefault();
            pos3 = e.clientX; pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }
        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
            pos3 = e.clientX; pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
            element.style.bottom = 'auto'; element.style.right = 'auto';
        }
        function closeDragElement() { document.onmouseup = null; document.onmousemove = null; }
    }

    function formatDuration(input) {
        if (!input) return '00:00';
        if (typeof input === 'string' && input.includes(':')) return input;
        let seconds = parseFloat(input);
        if (isNaN(seconds)) return '00:00';
        if (seconds > 864000) seconds = seconds / 1000;
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`;
    }

    /* ───────── 3. UI & LOGIC ───────── */
    function showLoginPrompt() {
        if (document.getElementById('sb-login-overlay')) return;
        const div = document.createElement("div");
        div.id = "sb-login-overlay";
        div.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.8); z-index:100000; display:flex; flex-direction:column; align-items:center; justify-content:center; backdrop-filter:blur(8px);";
        div.innerHTML = `
            <div style="background:rgba(30, 41, 59, 0.95); color:#fff; padding:40px; border-radius:16px; text-align:center; border:1px solid rgba(255,255,255,0.1); width:320px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
                <h2 style="margin:0 0 10px; font-family:'Amazon Ember', sans-serif;">Welcome</h2>
                <input type="text" id="sb-login-input" placeholder="Enter Login ID" style="padding:12px; margin-bottom:20px; border-radius:8px; border:1px solid #475569; background:#0f172a; color:#fff; width:100%; outline:none; font-family:'Amazon Ember', sans-serif;">
                <button id="sb-login-btn" style="width:100%; padding:12px; background:#FF9900; color:#111; font-weight:bold; border:none; border-radius:8px; cursor:pointer; font-family:'Amazon Ember', sans-serif;">Start Monitor</button>
            </div>
        `;
        document.body.appendChild(div);
        document.getElementById('sb-login-btn').onclick = () => {
            const val = document.getElementById('sb-login-input').value.trim();
            if(val) { GM_setValue(STORAGE_KEY_LOGIN, val); location.reload(); }
        };
    }

    function initializeScoreboard(AGENT_NAME) {
        const getToday = () => new Date().toISOString().split('T')[0];
        const defaults = {
            date: getToday(),
            transfers: 0, resolves: 0, pending: 0, seenAlerts: [], caseStates: {},
            goal: 50, shiftStart: "08:00", shiftEnd: "17:00",
            timers: {
                break: { acc: 0, active: false, lastStart: 0 },
                lunch: { acc: 0, active: false, lastStart: 0 },
                personal: { acc: 0, active: false, lastStart: 0, lastReset: getToday() },
                available: { acc: 0, active: false, lastStart: 0 }
            }
        };

        // LOAD DATA FROM GM STORAGE
        let data = GM_getValue(STORAGE_KEY_DATA, defaults);
        const today = getToday();
        const currentDay = new Date().getDay();

        if (data.date !== today) {
            data.date = today;
            data.transfers = 0; data.resolves = 0; data.pending = 0; data.seenAlerts = []; data.caseStates = {};
            data.timers.break = { acc: 0, active: false, lastStart: 0 };
            data.timers.lunch = { acc: 0, active: false, lastStart: 0 };
            data.timers.available = { acc: 0, active: false, lastStart: 0 };
        }
        if (currentDay === 0 && data.timers.personal.lastReset !== today) {
            data.timers.personal = { acc: 0, active: false, lastStart: 0, lastReset: today };
        }

        const save = () => GM_setValue(STORAGE_KEY_DATA, data);
        save();

        const PHOTO_URL = `https://badgephotos.corp.amazon.com/?uid=${AGENT_NAME}`;

        // --- STYLES ---
       const style = document.createElement('style');
        style.textContent = `
            /* FLIGHT WING / RADAR PULSE EFFECT */
            @keyframes sb-pulse-dot {
                0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); transform: scale(0.95); }
                70% { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); transform: scale(1); }
                100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); transform: scale(0.95); }
            }
            .sb-panel { display: none; font-family: "Amazon Ember", Arial, sans-serif; background: rgba(23, 31, 46, 0.98); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 8px 32px rgba(0,0,0,0.6); color: #fff; border-radius: 12px; z-index: 999999; }
            .sb-view { padding: 16px; transition: transform 0.3s ease; }
            .sb-btn-small { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; cursor: pointer; border-radius: 4px; padding: 2px 8px; font-size: 10px; transition: all 0.2s; font-weight:bold; }
            .sb-btn-small:hover { background: rgba(255,255,255,0.2); color: #fff; }
            .sb-timer-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-top: 4px; }
            .sb-timer-fill { height: 100%; width: 0%; transition: width 0.5s linear; }
            .sb-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
            .sb-label { color: #94a3b8; } .sb-val { font-weight: 700; color: #fff; }
            .sb-icon-min { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px; border-radius: 50%; border: 3px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.5); cursor: pointer; z-index: 100000; display: block; overflow: hidden; }
            .sb-bucket { margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
            .sb-bucket-title { font-size: 10px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; }
            .sb-timer-header { display: flex; align-items: center; font-size: 11px; margin-bottom: 2px; }
            .sb-th-title { flex: 0 0 auto; color: #94a3b8; width: 85px; }
            .sb-th-val { flex: 1 1 auto; text-align: center; font-family: monospace; font-weight: bold; }
            .sb-th-btn { flex: 0 0 auto; }
            .sb-stat-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; text-align: center; }
            .sb-stat-box { background: rgba(255,255,255,0.05); border-radius: 6px; padding: 6px; }
            .sb-stat-num { display: block; font-size: 14px; font-weight: bold; color: #fff; }
            .sb-stat-lbl { font-size: 10px; color: #cbd5e1; }
            .sb-input { background: rgba(0,0,0,0.3); border: 1px solid #475569; color: #fff; padding: 6px; border-radius: 4px; width: 100px; text-align: center; }
            .sb-setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 13px; }
            .sb-setting-header { font-size: 11px; color: #94a3b8; text-transform: uppercase; margin-top: 15px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px; }

            /* RINGS STYLES */
            .sb-ring-wrap { display: flex; flex-direction: column; align-items: center; cursor: pointer; transition: transform 0.1s; }
            .sb-ring-wrap:hover { transform: scale(1.05); }
            .sb-ring { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; background: conic-gradient(#4ade80 0% 100%); }
            .sb-ring::before { content: ""; position: absolute; width: 24px; height: 24px; background: #151b26; border-radius: 50%; }
            .sb-ring-val { position: relative; z-index: 2; font-size: 10px; font-weight: bold; color: #fff; }
            .sb-ring-lbl { font-size: 9px; color: #94a3b8; margin-top: 4px; }

            /* COLLAPSIBLE */
            .sb-collapsible .sb-bucket-title { cursor: pointer; display: flex; justify-content: space-between; user-select: none; }
            .sb-collapsible .sb-bucket-title::after { content: '▼'; font-size: 8px; transition: transform 0.2s; }
            .sb-collapsible.sb-collapsed .sb-bucket-title::after { transform: rotate(-90deg); }
            .sb-bucket-content { transition: all 0.2s; display: block; }
            .sb-collapsible.sb-collapsed .sb-bucket-content { display: none; }

            /* PULSING DOT */
            .sb-live-badge { display: inline-block; margin-left: 8px; width: 8px; height: 8px; background-color: #4ade80; border-radius: 50%; vertical-align: middle; animation: sb-pulse-dot 2s infinite; }

            /* --- NEW: MESSENGER STYLE AI CHAT --- */
            .sb-ai-chat {
                position: absolute;
                bottom: 100%; /* Sits exactly on top of the main panel */
                left: 0;
                width: 100%;
                background: #1e293b; /* Slate-800 */
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 12px 12px 0 0; /* Rounded top only, or full bubble? Let's do bubble above */
                border-radius: 12px;
                margin-bottom: 8px;
                box-shadow: 0 -4px 20px rgba(0,0,0,0.4);
                display: none; /* Hidden by default */
                flex-direction: column;
                overflow: hidden;
                transform-origin: bottom center;
                animation: sb-pop-in 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                z-index: 1000000;
            }
            @keyframes sb-pop-in { from { opacity: 0; transform: scale(0.9) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }

            .sb-ai-header {
                background: linear-gradient(90deg, #7c3aed, #db2777); /* Purple to Pink gradient */
                padding: 8px 12px;
                font-size: 12px;
                font-weight: bold;
                color: #fff;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            }
            .sb-ai-body {
                padding: 12px;
                max-height: 250px;
                overflow-y: auto;
                font-size: 13px;
                line-height: 1.5;
                color: #e2e8f0;
                white-space: pre-wrap; /* Keeps formatting */
                background: #0f172a;
            }
            .sb-ai-close { background: none; border: none; color: rgba(255,255,255,0.8); cursor: pointer; font-size: 14px; font-weight: bold; }
            .sb-ai-close:hover { color: #fff; }

            /* Typing Dots Animation */
            .sb-typing { display: flex; align-items: center; gap: 4px; padding: 4px; }
            .sb-dot { width: 6px; height: 6px; background: #94a3b8; border-radius: 50%; animation: sb-bounce 1.4s infinite ease-in-out both; }
            .sb-dot:nth-child(1) { animation-delay: -0.32s; }
            .sb-dot:nth-child(2) { animation-delay: -0.16s; }
            @keyframes sb-bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        `;
        document.head.appendChild(style);

        const icon = document.createElement('div');
        icon.className = 'sb-icon-min'; icon.innerHTML = `<img src="${PHOTO_URL}" style="width:100%; height:100%; object-fit:cover;">`;
        document.body.appendChild(icon);
        makeDraggable(icon, icon);

        const container = document.createElement("div");
        container.className = "sb-panel";
        container.style.cssText = "position: fixed; bottom: 80px; right: 20px; width: 300px;";
        document.body.appendChild(container);

        // --- NEW: CHAT HTML ADDED AT THE TOP OF CONTAINER ---


        const mainView = `
            <div id="sb-view-main" class="sb-view">
                <div id="sb-header" style="display:flex; gap:12px; align-items:center; padding-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.1); margin-bottom:12px; cursor: move;">
                    <img src="${PHOTO_URL}" style="width:42px; height:42px; border-radius:50%; object-fit:cover; border:2px solid rgba(255,255,255,0.1);" onerror="this.style.display='none'">
                    <div style="flex:1;">
                        <div style="font-weight:700; font-size:15px;">${AGENT_NAME} <span class="sb-live-badge"></span></div>
                        <div id="sb-status-txt" style="font-size:12px; color:#fbbf24;">Loading...</div>
                    </div>

                    <button id="sb-ai-btn" style="display:none; background:rgba(124, 58, 237, 0.2); border:1px solid rgba(124, 58, 237, 0.5); border-radius:6px; padding:4px 8px; color:#c084fc; font-size:14px; cursor:pointer; transition:all 0.2s;" title="Summarize Selection">
                        ✨
                    </button>

                    <button id="sb-settings-btn" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">⚙️</button>
                    <button id="sb-min-btn" style="background:none; border:none; color:#94a3b8; font-size:20px; cursor:pointer;">&minus;</button>
                </div>

                <div class="sb-bucket">
                    <div class="sb-bucket-title">Productivity</div>
                    <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.05);">
                        <span style="color:#cbd5e1;">Assigned Cases</span>
                        <span id="sb-assigned-val" style="font-weight:bold; color:#fff;">--</span>
                    </div>
                    <div style="margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px; color:#cbd5e1;">
                            <span>Goal Progress</span>
                            <span><span id="sb-cur-total">0</span> / <span id="sb-goal-display">${data.goal}</span></span>
                        </div>
                        <div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden;">
                            <div id="sb-prod-bar" style="height:100%; width:0%; background:#38bdf8;"></div>
                        </div>
                    </div>
                    <div class="sb-stat-grid">
                        <div class="sb-stat-box"><span class="sb-stat-num" id="sb-t">0</span><span class="sb-stat-lbl">Transfers</span></div>
                        <div class="sb-stat-box"><span class="sb-stat-num" id="sb-r">0</span><span class="sb-stat-lbl">Resolves</span></div>
                        <div class="sb-stat-box"><span class="sb-stat-num" id="sb-p">0</span><span class="sb-stat-lbl">Pending</span></div>
                    </div>
                </div>

                <div class="sb-bucket sb-collapsible" id="bucket-risks">
                    <div class="sb-bucket-title">
                        <span>Live Risks</span>
                        <span id="sb-sla-status" style="font-size:9px; color:#555; margin-right:10px;">Init...</span>
                    </div>
                    <div class="sb-bucket-content">
                        <div style="display:flex; justify-content:space-around; padding-top:4px;">
                            <div class="sb-ring-wrap" id="wrap-prilo">
                                <div id="sb-ring-prilo" class="sb-ring"><span id="sb-alert-prilo" class="sb-ring-val">0</span></div>
                                <span class="sb-ring-lbl">PRILO</span>
                            </div>
                            <div class="sb-ring-wrap" id="wrap-ob">
                                <div id="sb-ring-ob" class="sb-ring"><span id="sb-alert-ob" class="sb-ring-val">0</span></div>
                                <span class="sb-ring-lbl">OB</span>
                            </div>
                            <div class="sb-ring-wrap" id="wrap-ib">
                                <div id="sb-ring-ib" class="sb-ring"><span id="sb-alert-ib" class="sb-ring-val">0</span></div>
                                <span class="sb-ring-lbl">IB</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="sb-bucket sb-collapsible" id="bucket-npt" style="margin-bottom:0;">
                    <div class="sb-bucket-title">Non-Productivity</div>
                    <div class="sb-bucket-content">
                        <div style="margin-bottom:12px;">
                            <div class="sb-timer-header">
                                <span class="sb-th-title">NPT %</span>
                                <span class="sb-th-val" id="tmr-npt-val">0.0%</span>
                                <span class="sb-th-btn"></span>
                            </div>
                            <div class="sb-timer-bar"><div id="tmr-npt-bar" class="sb-timer-fill" style="background:#2dd4bf;"></div></div>
                        </div>
                        <div style="margin-bottom:10px;">
                            <div class="sb-timer-header">
                                <span class="sb-th-title">Break (30m)</span>
                                <span class="sb-th-val" id="tmr-break-val">00:00</span>
                                <button id="btn-break" class="sb-btn-small sb-th-btn" style="display:none;">Stop</button>
                            </div>
                            <div class="sb-timer-bar"><div id="tmr-break-bar" class="sb-timer-fill" style="background:#38bdf8;"></div></div>
                        </div>
                        <div style="margin-bottom:10px;">
                            <div class="sb-timer-header">
                                <span class="sb-th-title">Lunch (30m)</span>
                                <span class="sb-th-val" id="tmr-lunch-val">00:00</span>
                                <button id="btn-lunch" class="sb-btn-small sb-th-btn" style="display:none;">Stop</button>
                            </div>
                            <div class="sb-timer-bar"><div id="tmr-lunch-bar" class="sb-timer-fill" style="background:#a855f7;"></div></div>
                        </div>
                        <div>
                            <div class="sb-timer-header">
                                <span class="sb-th-title">Personal (30m)</span>
                                <span class="sb-th-val" id="tmr-personal-val">00:00</span>
                                <button id="btn-personal" class="sb-btn-small sb-th-btn" style="display:none;">Stop</button>
                            </div>
                            <div class="sb-timer-bar"><div id="tmr-personal-bar" class="sb-timer-fill" style="background:#f472b6;"></div></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const settingsView = `
            <div id="sb-view-settings" class="sb-view" style="display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.1);">
                    <h3 style="margin:0; font-size:14px;">Settings</h3>
                    <button id="sb-close-settings" style="background:none; border:none; color:#fff; cursor:pointer;">✕</button>
                </div>
                <!-- GEMINI AI SETTINGS -->
<div class="sb-setting-header">Gemini AI</div>
<div class="sb-setting-row" style="flex-direction:column; align-items:flex-start;">
    <span style="color:#cbd5e1; font-size:10px; margin-bottom:4px;">API Key</span>
    <input
        type="password"
        id="set-gemini-key"
        placeholder="AIza..."
        style="width:100%; text-align:left; padding:6px; border-radius:6px;
               background:#0f172a; border:1px solid #334155; color:#fff;">
</div>

                <div class="sb-setting-header">Shift Config</div>
                <div class="sb-setting-row"><span>Start</span><input type="time" id="set-shift-start" class="sb-input" value="${data.shiftStart}"></div>
                <div class="sb-setting-row"><span>End</span><input type="time" id="set-shift-end" class="sb-input" value="${data.shiftEnd}"></div>
                <div class="sb-setting-row"><span>Goal</span><input type="number" id="set-goal" class="sb-input" value="${data.goal}"></div>
                <div class="sb-setting-header">Timer Corrections (Today)</div>
                <div class="sb-setting-row"><span>Break (mins)</span><input type="number" id="adj-break" class="sb-input"></div>
                <div class="sb-setting-row"><span>Lunch (mins)</span><input type="number" id="adj-lunch" class="sb-input"></div>
                <div class="sb-setting-row"><span>Personal (mins)</span><input type="number" id="adj-personal" class="sb-input"></div>
                <div style="margin-top:20px; text-align:center;">
                    <button id="sb-save-settings" style="background:#38bdf8; color:#0f172a; border:none; padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer; width:100%; margin-bottom:10px;">Save & Back</button>
                    <button id="sb-logout" style="background:rgba(239,68,68,0.2); color:#fca5a5; border:1px solid #ef4444; padding:8px 16px; border-radius:6px; cursor:pointer; width:100%;">Logout</button>
                </div>
            </div>
        `;

// 1. Define the Chat Box HTML
    const chatView = `
        <div id="sb-ai-chat" class="sb-ai-chat">
            <div class="sb-ai-header">
                <span>✨ AI Insight</span>
                <button id="sb-ai-close" class="sb-ai-close">✕</button>
            </div>
            <div id="sb-ai-body" class="sb-ai-body">
                </div>
        </div>
    `;

    // 2. Add Chat View to the Container (Updated Line 664)
    container.innerHTML = chatView + mainView + settingsView;

    // 3. Make Draggable (Keep this)
    makeDraggable(container, document.getElementById('sb-header'));

    // ───────── NEW AI CHAT LOGIC ─────────

    // Get references to the new chat elements
    const aiChatBox = document.getElementById('sb-ai-chat');
    const aiBody = document.getElementById('sb-ai-body');
    const aiClose = document.getElementById('sb-ai-close');
    const aiBtn = document.getElementById('sb-ai-btn');

    // Close button handler
    if (aiClose) {
        aiClose.onclick = () => {
            aiChatBox.style.display = 'none';
        };
    }

    // Monitor text selection to show/hide the "✨" button
    document.addEventListener('selectionchange', () => {
        const sel = window.getSelection().toString().trim();
        if (!aiBtn) return;
        aiBtn.style.display = sel.length > 0 ? 'inline-block' : 'none';
    });

    // The Magic Button Click Handler
    if (aiBtn) {
        aiBtn.onclick = async () => {
            const selectedText = window.getSelection().toString().trim();
            if (!selectedText) {
                alert("Select some text first");
                return;
            }

            if (!data.geminiKey) {
                alert("⚠️ Please add your Gemini API key in Settings ⚙️ first.");
                return;
            }

            // A. Open Chat Box & Show Loading State
            aiChatBox.style.display = 'flex';
            aiBody.innerHTML = `
                <div class="sb-typing">
                    <div class="sb-dot"></div><div class="sb-dot"></div><div class="sb-dot"></div>
                </div>
                <div style="color:#94a3b8; font-size:11px; margin-top:4px;">Analyzing text...</div>
            `;

            // B. Call the Gemini API
            const result = await callGeminiSummary(data.geminiKey, selectedText);

            // C. Format the result
            let formatted = result
                .replace(/\*\*(.*?)\*\*/g, '<b style="color:#e879f9">$1</b>') // Bold -> Pink
                .replace(/^\* /gm, '• '); // Bullets -> Dots

            // D. Display result
            aiBody.innerHTML = formatted;
        };
    }

        // --- COLLAPSE LOGIC ---
        document.querySelectorAll('.sb-collapsible .sb-bucket-title').forEach(header => {
            header.addEventListener('click', function() {
                this.parentElement.classList.toggle('sb-collapsed');
            });
        });

        // Click handler for rings to open Dashboard
        ['wrap-prilo','wrap-ob','wrap-ib'].forEach(id => {
            document.getElementById(id).onclick = (e) => {
                e.stopPropagation(); // Prevent collapsing parent bucket
                openDashboard();
            };
        });

        // Dashboard Message Listener
        window.addEventListener('message', (ev) => {
            if (ev.data?.type === 'sla-dashboard-ready') {
                if(dashRef && !dashRef.closed) {
                    dashRef.postMessage({ type:'sla-snapshot', payload: { live: liveStats, cases: liveCases } }, '*');
                }
            } else if (ev.data?.type === 'sla-request-refresh') {
                runSlaScan();
            }
        });

        const refs = {
            main: document.getElementById('sb-view-main'), settings: document.getElementById('sb-view-settings'),
            t: document.getElementById('sb-t'), r: document.getElementById('sb-r'), p: document.getElementById('sb-p'),
            statusTxt: document.getElementById('sb-status-txt'),
            curTotal: document.getElementById('sb-cur-total'), goalDisplay: document.getElementById('sb-goal-display'), prodBar: document.getElementById('sb-prod-bar'),
            assignedVal: document.getElementById('sb-assigned-val'),
            nptVal: document.getElementById('tmr-npt-val'), nptBar: document.getElementById('tmr-npt-bar'),
            breakVal: document.getElementById('tmr-break-val'), breakBar: document.getElementById('tmr-break-bar'), breakBtn: document.getElementById('btn-break'),
            lunchVal: document.getElementById('tmr-lunch-val'), lunchBar: document.getElementById('tmr-lunch-bar'), lunchBtn: document.getElementById('btn-lunch'),
            personalVal: document.getElementById('tmr-personal-val'), personalBar: document.getElementById('tmr-personal-bar'), personalBtn: document.getElementById('btn-personal'),
            setStart: document.getElementById('set-shift-start'), setEnd: document.getElementById('set-shift-end'), setGoal: document.getElementById('set-goal'),
            adjBreak: document.getElementById('adj-break'), adjLunch: document.getElementById('adj-lunch'), adjPersonal: document.getElementById('adj-personal'),
            // Rings
            ringPrilo: document.getElementById('sb-ring-prilo'), alertPrilo: document.getElementById('sb-alert-prilo'),
            ringOb: document.getElementById('sb-ring-ob'), alertOb: document.getElementById('sb-alert-ob'),
            ringIb: document.getElementById('sb-ring-ib'), alertIb: document.getElementById('sb-alert-ib'),
            slaStatus: document.getElementById('sb-sla-status')
        };

        document.getElementById('sb-min-btn').onclick = () => { container.style.display = 'none'; icon.style.display = 'block'; };
        icon.onclick = () => { icon.style.display = 'none'; container.style.display = 'block'; };

        document.getElementById('sb-settings-btn').onclick = () => {
            refs.adjBreak.value = Math.floor(data.timers.break.acc / 60);
            refs.adjLunch.value = Math.floor(data.timers.lunch.acc / 60);
            refs.adjPersonal.value = Math.floor(data.timers.personal.acc / 60);
            refs.main.style.display = 'none'; refs.settings.style.display = 'block';
            document.getElementById('set-gemini-key').value = data.geminiKey || "";

        };
        document.getElementById('sb-close-settings').onclick = () => { refs.settings.style.display = 'none'; refs.main.style.display = 'block'; };

       document.getElementById('sb-save-settings').onclick = () => {
    data.shiftStart = refs.setStart.value;
    data.shiftEnd = refs.setEnd.value;
    data.goal = parseInt(refs.setGoal.value);

    if(refs.adjBreak.value !== '') data.timers.break.acc = parseInt(refs.adjBreak.value) * 60;
    if(refs.adjLunch.value !== '') data.timers.lunch.acc = parseInt(refs.adjLunch.value) * 60;
    if(refs.adjPersonal.value !== '') data.timers.personal.acc = parseInt(refs.adjPersonal.value) * 60;

    // ✅ SAVE GEMINI KEY BEFORE save()
    data.geminiKey = document.getElementById('set-gemini-key').value.trim();

    save();
    renderStats();
    refs.settings.style.display = 'none';
    refs.main.style.display = 'block';
};

        document.getElementById('sb-logout').onclick = () => { if(confirm("Logout?")) { GM_setValue(STORAGE_KEY_LOGIN, ""); location.reload(); } };

        const renderStats = () => {
            const total = data.transfers + data.resolves + data.pending;
            refs.t.innerText = data.transfers; refs.r.innerText = data.resolves; refs.p.innerText = data.pending;
            refs.curTotal.innerText = total; refs.goalDisplay.innerText = data.goal;
            const pct = Math.min((total / data.goal) * 100, 100);
            refs.prodBar.style.width = `${pct}%`;
            refs.prodBar.style.background = pct >= 100 ? "#EAB308" : pct > 50 ? "#38bdf8" : "#f472b6";
        };
        renderStats();

        const limits = { break: 30*60, lunch: 30*60, personal: 30*60 };
        function getAccumulatedTime(type) {
            const t = data.timers[type];
            if (!t.active) return t.acc;
            return t.acc + Math.floor((Date.now() - t.lastStart) / 1000);
        }

        function toggleTimer(type, forceState = null) {
            const t = data.timers[type];
            const now = Date.now();
            const newState = forceState !== null ? forceState : !t.active;
            if (newState === t.active) return;
            if (newState) { t.active = true; t.lastStart = now; }
            else { t.active = false; t.acc += Math.floor((now - t.lastStart) / 1000); t.lastStart = 0; }
            save(); if(type !== 'available') updateButtonUI(type, newState);
        }

        function updateButtonUI(type, active) {
            const btn = refs[`${type}Btn`];
            if (active) {
                btn.style.display = 'inline-block';
                btn.innerText = "Stop";
                btn.style.background = "rgba(239, 68, 68, 0.2)";
                btn.style.borderColor = "#ef4444";
                btn.style.color = "#fca5a5";
            } else {
                btn.style.display = 'none';
            }
        }
        ['break', 'lunch', 'personal'].forEach(type => { refs[`${type}Btn`].onclick = () => toggleTimer(type); updateButtonUI(type, data.timers[type].active); });

        // --- TICKER ---
        function getShiftElapsed() {
            const now = new Date();
            const [sh, sm] = data.shiftStart.split(':').map(Number);
            const start = new Date(now); start.setHours(sh, sm, 0, 0);
            const diff = (now - start) / 1000;
            return diff > 0 ? diff : 0;
        }

        setInterval(() => {
            ['break', 'lunch', 'personal'].forEach(type => {
                const sec = getAccumulatedTime(type);
                const limit = limits[type];
                let display = "", color = "#fff", barColor = type === 'break' ? '#38bdf8' : type === 'lunch' ? '#a855f7' : '#f472b6';
                if (sec > limit) {
                    const extra = sec - limit;
                    display = `+${Math.floor(extra/60).toString().padStart(2,'0')}:${(extra%60).toString().padStart(2,'0')}`; color = "#ef4444"; barColor = "#ef4444";
                } else {
                    display = `${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}`;
                }
                refs[`${type}Val`].innerText = display; refs[`${type}Val`].style.color = color;
                refs[`${type}Bar`].style.width = `${Math.min((sec/limit)*100, 100)}%`; refs[`${type}Bar`].style.background = barColor;
            });

            // NPT Calc
            const totalOnline = getShiftElapsed();
            const deductions = getAccumulatedTime('break') + getAccumulatedTime('lunch') + getAccumulatedTime('personal') + getAccumulatedTime('available');
            const nptSeconds = Math.max(0, totalOnline - deductions);
            let nptPct = 100;
            if (totalOnline > 0) nptPct = (nptSeconds / totalOnline) * 100;
            refs.nptVal.innerText = `${nptPct.toFixed(1)}%`;
            refs.nptBar.style.width = `${nptPct}%`;
            if (nptPct > 90) { refs.nptBar.style.background = "#2dd4bf"; refs.nptVal.style.color = "#2dd4bf"; }
            else if (nptPct > 75) { refs.nptBar.style.background = "#facc15"; refs.nptVal.style.color = "#facc15"; }
            else { refs.nptBar.style.background = "#f87171"; refs.nptVal.style.color = "#f87171"; }
        }, 1000);

        // --- MONITOR & API CHECKER ---
        async function checkAssignedCases() {
            const count = await fetchAssignedCases(AGENT_NAME);
            refs.assignedVal.innerText = count;
        }
        setInterval(checkAssignedCases, 30000);
        checkAssignedCases();

        function isShiftTime() { const cur = new Date().toTimeString().slice(0,5); return cur >= data.shiftStart && cur <= data.shiftEnd; }
        setInterval(async () => {
            const res = await fetchRealtimeData(AGENT_NAME);
            if (res.error) { refs.statusTxt.innerText = "Err"; refs.statusTxt.style.color = "#ef4444"; icon.style.borderColor = "#ef4444"; }
            else {
                refs.statusTxt.innerText = `${res.status} (${formatDuration(res.duration)})`;
                let color = '#f87171';
                if (res.status === 'Available') color = '#4ade80';
                else if (['Meeting', 'Break', 'Lunch', 'Aux', 'Personal'].some(s => res.status.includes(s))) color = '#fbbf24';
                refs.statusTxt.style.color = color; icon.style.borderColor = color;

                if (isShiftTime()) {
                    if (res.status.includes("Break")) toggleTimer('break', true);
                    else if (res.status.includes("Lunch")) toggleTimer('lunch', true);
                    else if (res.status.includes("Personal")) toggleTimer('personal', true);
                    else if (res.status === 'Available') toggleTimer('available', true);
                    else {
                         if(data.timers.break.active) toggleTimer('break', false);
                         if(data.timers.lunch.active) toggleTimer('lunch', false);
                         if(data.timers.personal.active) toggleTimer('personal', false);
                         if(data.timers.available.active) toggleTimer('available', false);
                    }
                }
            }
        }, 2000);

        /* ───────── SLA SCAN ENGINE (SLARIS LOGIC FIXED) ───────── */
        async function runSlaScan() {
            refs.slaStatus.innerText = "Scanning...";
            refs.slaStatus.style.color = "#fbbf24";

            // Get initial page to determine total
            const p1 = await fetchSlaPage(1);
            if (!p1) {
                refs.slaStatus.innerText = "API Err"; refs.slaStatus.style.color = "#ef4444";
                return;
            }

            let rObj = p1.contentTypes?.[0] || p1.payload?.resultsByContentType?.CASE;
            if (!rObj) { refs.slaStatus.innerText = "0 Recs"; return; }

            let cases = rObj.results || [];
            const totalCount = rObj.totalCount || 0;
            const totalPages = Math.min(Math.ceil(totalCount / PAGE_SIZE), 3); // Limit to 3 pages for performance

            // Fetch extra pages if needed
            if (totalPages > 1) {
                const p = [];
                for (let i = 2; i <= totalPages; i++) p.push(fetchSlaPage(i));
                const others = await Promise.all(p);
                others.forEach(d => {
                    let res = d?.contentTypes?.[0]?.results || d?.payload?.resultsByContentType?.CASE?.results;
                    if (res) cases = cases.concat(res);
                });
            }

            // Stats containers
            liveStats = { PRILO: 0, OB: 0, IB: 0, PRILO_TOT: 0, OB_TOT: 0, IB_TOT: 0 };
            liveCases = []; // RESET DATA

            // Process cases in batches
            for (let i = 0; i < cases.length; i += CONCURRENCY) {
                const batch = cases.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (c) => {
                    const cid = c.document ? c.document.caseId : c.caseId;
                    const cqueue = c.document ? c.document.queue : c.queue;
                    const cat = getSlaQueueCategory(cqueue);

                    if (cat === 'UNKNOWN') return;

                    const history = await fetchSlaHistory(cid);
                    const start = determineSlaStart(history);
                    const mins = Math.floor((Date.now() - start) / 60000);

                    let t = SLA_THR[cat];
                    if (cat === 'IB' && cqueue.includes('other-issues')) t = SLA_THR.IB_OTHER;

                    // FIXED LOGIC: Strict Slaris Matching
                    // Slaris "Live Alerts" ring counts ONLY 'Alert' (Yellow), NOT 'Breach' (Red).
                    let status = 'ok';
                    if (mins > t.alertHi) status = 'Breach';
                    else if (mins >= t.alertLo) status = 'Alert';

                    liveStats[cat + '_TOT']++;
                    if (status === 'Alert') liveStats[cat]++;

                    // DATA COLLECT FOR DASHBOARD
                    // FILTER: Only show ALERT cases in the dashboard list (User Request)
                    if (status === 'Alert') {
                        liveCases.push({
                            caseID: cid,
                            duration: mins,
                            queue: cat,
                            status: status,
                            url: `/hz/view-case?caseId=${cid}`
                        });
                    }
                }));
            }

            // Update UI
            updateSlaRing('Prilo', liveStats.PRILO, liveStats.PRILO_TOT);
            updateSlaRing('Ob', liveStats.OB, liveStats.OB_TOT);
            updateSlaRing('Ib', liveStats.IB, liveStats.IB_TOT);

            refs.slaStatus.innerText = "Live";
            refs.slaStatus.style.color = "#4ade80";

            // IF DASHBOARD IS OPEN, REFRESH IT
            if (dashRef && !dashRef.closed) {
                dashRef.postMessage({ type:'sla-snapshot', payload: { live: liveStats, cases: liveCases } }, '*');
            }
        }

        function updateSlaRing(type, alerts, total) {
            const alertEl = refs['alert' + type];
            const ringEl = refs['ring' + type];
            if (alertEl) alertEl.innerText = alerts;
            if (ringEl) {
                const pct = total > 0 ? (alerts / total) * 100 : 0;
                // Ring color: Yellow for Alerts, Green for Safe
                const color = alerts > 0 ? '#fcd34d' : '#4ade80';
                ringEl.style.background = `conic-gradient(${color} ${pct}%, #334155 ${pct}%)`;
            }
        }

        // Start SLA Loop
        setInterval(runSlaScan, SLA_REFRESH_INTERVAL);
        setTimeout(runSlaScan, 2000); // First run shortly after load

        // ───────── DOM MUTATION OBSERVER ─────────
        const getId = () => (location.search.match(/caseId=(\d+)/) || [])[1];
        const IGNORE_TRANSFER_MSG = "paragon_tam_cm_transferred_to_agent";

        const obs = new MutationObserver(() => {
            document.querySelectorAll("kat-alert[variant='success']").forEach(a => {
                const txt = (a.getAttribute("description") || "").toLowerCase();
                const header = (a.getAttribute("header") || "").toLowerCase();
                const key = header + txt;
                if (txt.includes(IGNORE_TRANSFER_MSG)) return;

                if (!data.seenAlerts.includes(key)) {
                    data.seenAlerts.push(key);
                    if (txt.includes("transferred")) {
                        data.transfers++;
                        save(); renderStats();
                    }
                }
            });

            if (location.href.includes("/hz/view-case")) {
                let statusText = "";
                try {
                    const xpath = "//kat-table-row[kat-table-cell[contains(.,'Status')]]/kat-table-cell[contains(@class,'value')]/span";
                    const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (node) statusText = node.textContent;
                } catch (e) {}

                if (!statusText) {
                    const statusEl = document.querySelector(
                        "span[data-test-id='case-status'], .case-status, kat-table-cell.value span, [data-cy='case-status-value'], div.case-status-field span"
                    );
                    if (statusEl) statusText = statusEl.innerText;
                }

                if (statusText) {
                    const s = statusText.toLowerCase();
                    const id = getId();
                    if (!id) return;

                    let grp = null;
                    if (s.includes("resolved")) grp = "resolved";
                    else if (s.includes("pending")) grp = "pending";

                    const prev = data.caseStates[id];
                    if (grp && (!prev || prev !== grp)) {
                        if (prev === "pending") data.pending--;
                        if (prev === "resolved") data.resolves--;
                        if (grp === "pending") data.pending++;
                        if (grp === "resolved") data.resolves++;
                        data.caseStates[id] = grp;
                        save(); renderStats();
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    const savedId = GM_getValue(STORAGE_KEY_LOGIN);
    if (savedId) initializeScoreboard(savedId);
    else showLoginPrompt();
})();
