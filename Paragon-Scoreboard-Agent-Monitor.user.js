// ==UserScript==
// @name         Paragon Scoreboard + Agent Monitor
// @namespace    https://github.com/sandeep030502/tampermonkey-scripts
// @version      22.1
// @description  Paragon Scoreboard + Agent Monitor (Auto Update Enabled)
// @author       Sandeep
// @match        https://paragon-na.amazon.com/hz/*
//
// @updateURL    https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Scoreboard-Agent-Monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/sandeep030502/tampermonkey-scripts/main/Paragon-Scoreboard-Agent-Monitor.user.js
//
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==


(function () {
    "use strict";

    /* ───────── CONFIGURATION ───────── */
    const STORAGE_KEY_LOGIN = 'scoreboard_login_v22';
    const STORAGE_KEY_DATA = 'scoreboard_data_v22';
    const REALTIME_URL = 'https://c2-na-prod.awsapps.com/connect/awas/api/v1/rtm-tables';
    const SEARCH_API_URL = '/hz/api/search';
    const PROFILE_ID = "7c680a87-92df-4c98-95e7-e182acfe5b4a";

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
                "searchAllTenants": false,
                "typeAhead": false
            };

            const response = await fetch(SEARCH_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'pgn-csrf-token': token
                },
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

    /* ───────── 2. DRAG & DROP UTILS ───────── */
    function makeDraggable(element, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handle.onmousedown = dragMouseDown;
        function dragMouseDown(e) { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; }
        function elementDrag(e) { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; element.style.top = (element.offsetTop - pos2) + "px"; element.style.left = (element.offsetLeft - pos1) + "px"; element.style.bottom = 'auto'; element.style.right = 'auto'; }
        function closeDragElement() { document.onmouseup = null; document.onmousemove = null; }
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
            if(val) { localStorage.setItem(STORAGE_KEY_LOGIN, val); location.reload(); }
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

        let data = JSON.parse(localStorage.getItem(STORAGE_KEY_DATA)) || defaults;

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
        const save = () => localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(data));
        save();

        const PHOTO_URL = `https://badgephotos.corp.amazon.com/?uid=${AGENT_NAME}`;

        // --- STYLES ---
        const style = document.createElement('style');
        style.textContent = `
            .sb-panel { font-family: "Amazon Ember", Arial, sans-serif; background: rgba(23, 31, 46, 0.98); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 8px 32px rgba(0,0,0,0.6); color: #fff; border-radius: 12px; z-index: 999999; overflow: hidden; }
            .sb-view { padding: 16px; transition: transform 0.3s ease; }
            .sb-btn-small { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; cursor: pointer; border-radius: 4px; padding: 2px 8px; font-size: 10px; transition: all 0.2s; font-weight:bold; }
            .sb-btn-small:hover { background: rgba(255,255,255,0.2); color: #fff; }
            .sb-timer-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-top: 4px; }
            .sb-timer-fill { height: 100%; width: 0%; transition: width 0.5s linear; }
            .sb-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
            .sb-label { color: #94a3b8; } .sb-val { font-weight: 700; color: #fff; }
            .sb-icon-min { position: fixed; bottom: 20px; left: 20px; width: 56px; height: 56px; border-radius: 50%; border: 3px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.5); cursor: pointer; z-index: 100000; display: none; overflow: hidden; }
            .sb-bucket { margin-bottom: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
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
        `;
        document.head.appendChild(style);

        const icon = document.createElement('div');
        icon.className = 'sb-icon-min'; icon.innerHTML = `<img src="${PHOTO_URL}" style="width:100%; height:100%; object-fit:cover;">`;
        document.body.appendChild(icon);
        makeDraggable(icon, icon);

        const container = document.createElement("div");
        container.className = "sb-panel";
        container.style.cssText = "position: fixed; bottom: 80px; left: 20px; width: 300px;";
        document.body.appendChild(container);

        const mainView = `
            <div id="sb-view-main" class="sb-view">
                <div id="sb-header" style="display:flex; gap:12px; align-items:center; padding-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.1); margin-bottom:12px; cursor: move;">
                    <img src="${PHOTO_URL}" style="width:42px; height:42px; border-radius:50%; object-fit:cover; border:2px solid rgba(255,255,255,0.1);" onerror="this.style.display='none'">
                    <div style="flex:1;">
                        <div style="font-weight:700; font-size:15px;">${AGENT_NAME}</div>
                        <div id="sb-status-txt" style="font-size:12px; color:#fbbf24;">Loading...</div>
                    </div>
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

                <div class="sb-bucket" style="margin-bottom:0;">
                    <div class="sb-bucket-title">Non-Productive</div>
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
        `;

        const settingsView = `
            <div id="sb-view-settings" class="sb-view" style="display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.1);">
                    <h3 style="margin:0; font-size:14px;">Settings</h3>
                    <button id="sb-close-settings" style="background:none; border:none; color:#fff; cursor:pointer;">✕</button>
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

        container.innerHTML = mainView + settingsView;
        makeDraggable(container, document.getElementById('sb-header'));

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
            adjBreak: document.getElementById('adj-break'), adjLunch: document.getElementById('adj-lunch'), adjPersonal: document.getElementById('adj-personal')
        };

        document.getElementById('sb-min-btn').onclick = () => { container.style.display = 'none'; icon.style.display = 'block'; };
        icon.onclick = () => { icon.style.display = 'none'; container.style.display = 'block'; };

        document.getElementById('sb-settings-btn').onclick = () => {
            refs.adjBreak.value = Math.floor(data.timers.break.acc / 60);
            refs.adjLunch.value = Math.floor(data.timers.lunch.acc / 60);
            refs.adjPersonal.value = Math.floor(data.timers.personal.acc / 60);
            refs.main.style.display = 'none'; refs.settings.style.display = 'block';
        };
        document.getElementById('sb-close-settings').onclick = () => { refs.settings.style.display = 'none'; refs.main.style.display = 'block'; };

        document.getElementById('sb-save-settings').onclick = () => {
            data.shiftStart = refs.setStart.value; data.shiftEnd = refs.setEnd.value; data.goal = parseInt(refs.setGoal.value);
            if(refs.adjBreak.value !== '') data.timers.break.acc = parseInt(refs.adjBreak.value) * 60;
            if(refs.adjLunch.value !== '') data.timers.lunch.acc = parseInt(refs.adjLunch.value) * 60;
            if(refs.adjPersonal.value !== '') data.timers.personal.acc = parseInt(refs.adjPersonal.value) * 60;
            save(); renderStats(); refs.settings.style.display = 'none'; refs.main.style.display = 'block';
        };
        document.getElementById('sb-logout').onclick = () => { if(confirm("Logout?")) { localStorage.removeItem(STORAGE_KEY_LOGIN); location.reload(); } };

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

        const getId = () => (location.search.match(/caseId=(\d+)/) || [])[1];
        const obs = new MutationObserver(() => {
            document.querySelectorAll("kat-alert[variant='success']").forEach(a => {
                const txt = (a.getAttribute("description") || "").toLowerCase();
                const key = (a.getAttribute("header") || "") + txt;
                if (!data.seenAlerts.includes(key)) {
                    data.seenAlerts.push(key);
                    if (txt.includes("transferred")) { data.transfers++; save(); renderStats(); }
                }
            });
            if (location.href.includes("/hz/view-case")) {
                const statusEl = document.querySelector("span[data-test-id='case-status'], .case-status, kat-table-cell.value span, [data-cy='case-status-value']");
                if (statusEl) {
                    const s = statusEl.innerText.toLowerCase();
                    const id = getId(); if (!id) return;
                    let grp = null;
                    if (s.includes("resolved")) grp = "resolved"; else if (s.includes("pending")) grp = "pending";
                    const prev = data.caseStates[id];
                    if (grp && (!prev || prev !== grp)) {
                        if (prev === "pending") data.pending--; if (prev === "resolved") data.resolves--;
                        if (grp === "pending") data.pending++; else if (grp === "resolved") data.resolves++;
                        data.caseStates[id] = grp; save(); renderStats();
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    const savedId = localStorage.getItem(STORAGE_KEY_LOGIN);
    if (savedId) initializeScoreboard(savedId);
    else showLoginPrompt();
})();
