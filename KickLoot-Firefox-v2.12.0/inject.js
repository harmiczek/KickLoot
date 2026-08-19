(function () {
    'use strict';

    const API = 'https://web.kick.com/api/v1';
    const EP_CHALLENGES  = API + '/gamification/challenges';
    const EP_CH_CLAIM    = (id) => `${API}/gamification/challenges/${encodeURIComponent(id)}/claim`;
    const EP_DROPS       = API + '/drops/progress';
    const EP_DROPS_CLAIM = API + '/drops/claim';

    const LOG = '[KickLoot]';
    const log = (...a) => console.log(LOG, ...a);
    const TAB_ID = Math.random().toString(36).slice(2);
    const EXT_NAME = 'KickLoot';

    function updateBadge(status, val = '', rewardInfo = {}) {
        let text = '';
        let color = '#555555'; 
        let tooltip = EXT_NAME;

        if (status === 'claimed') {
            text = '✔';
            color = '#53F700'; 
            tooltip = `${EXT_NAME}: Reward Claimed!`;
        } else if (status === 'progress') {
            text = val.toString(); 
            color = '#FF9900'; 
            tooltip = `${EXT_NAME}: ${val} minutes remaining`;
        } else if (status === 'ready') {
            text = 'R';
            color = '#53F700'; 
            tooltip = `${EXT_NAME}: Ready to claim!`;
        } else if (status === 'error') {
            text = 'ERR';
            color = '#FF0000';
            tooltip = `${EXT_NAME}: Error checking status`;
        } else if (status === 'loading') {
            text = '...';
            color = '#555555';
            tooltip = `${EXT_NAME}: Initializing...`;
        }

        window.postMessage({
            source: 'KICK_AUTO_CLAIM',
            type: 'UPDATE_BADGE',
            status: status,
            val: val,
            text: text,
            color: color,
            tooltip: tooltip,
            rewardInfo: rewardInfo
        }, '*');
    }

    function sessionToken() {
        const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }
    const loggedIn = () => /(?:^|;\s*)session_token=/.test(document.cookie);

    function apiHeaders(extra) {
        const h = Object.assign({ 'Accept': 'application/json', 'x-app-platform': 'web' }, extra || {});
        const tok = sessionToken();
        if (tok) h['Authorization'] = 'Bearer ' + tok;
        return h;
    }
    const apiGet  = (url) => fetch(url, { method: 'GET', credentials: 'include', headers: apiHeaders() });
    const apiPost = (url, body) => fetch(url, {
        method: 'POST', credentials: 'include',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: body ? JSON.stringify(body) : null,
    });

    const readState = (key) => {
        try { return JSON.parse(localStorage.getItem(key)) || {}; }
        catch (e) { return {}; }
    };
    const writeState = (key, patch) => {
        const next = Object.assign({}, readState(key), patch);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch (e) {}
        return next;
    };
    const inBackoff  = (key) => { const s = readState(key); return typeof s.backoffUntil === 'number' && Date.now() < s.backoffUntil; };
    const setBackoff = (key, ms) => writeState(key, { backoffUntil: Date.now() + ms });

    const LOCK_TTL_MS = 60_000;
    const readLock = (key) => { try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; } };
    const ownsLock = (key) => { const l = readLock(key); return !!l && l.tab === TAB_ID && Date.now() - l.ts < LOCK_TTL_MS; };
    function acquireLock(key) {
        const now = Date.now();
        const held = readLock(key);
        if (held && held.tab !== TAB_ID && now - held.ts < LOCK_TTL_MS) return false;
        try { localStorage.setItem(key, JSON.stringify({ ts: now, tab: TAB_ID })); } catch (e) { return false; }
        return ownsLock(key);
    }
    const refreshLock = (key) => { if (ownsLock(key)) { try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), tab: TAB_ID })); } catch (e) {} } };
    const releaseLock = (key) => { const l = readLock(key); if (l && l.tab === TAB_ID) { try { localStorage.removeItem(key); } catch (e) {} } };

    const timers = {};
    function scheduleNext(name, fn, ms, minMs, maxMs) {
        const delay = Math.max(minMs, Math.min(ms || maxMs, maxMs));
        if (timers[name]) clearTimeout(timers[name]);
        timers[name] = setTimeout(fn, delay);
    }

    function findKickQueryClient() {
        try {
            for (const el of document.querySelectorAll('body *')) {
                const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
                let f = k ? el[k] : null, d = 0;
                while (f && d < 80) {
                    const mp = f.memoizedProps;
                    if (mp && mp.client && typeof mp.client.getQueryCache === 'function' && typeof mp.client.invalidateQueries === 'function') return mp.client;
                    f = f.return; d++;
                }
            }
        } catch (e) {}
        return null;
    }
    function refreshRewardUI() {
        try {
            const qc = findKickQueryClient();
            if (qc) {
                const key = ['Gamification', 'getChallenges'];
                try { qc.invalidateQueries({ queryKey: key }); }
                catch (e) { try { qc.invalidateQueries(key); } catch (e2) {} } 
                return;
            }
        } catch (e) {}
        try {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        } catch (e) {}
    }

    const D_STATE = 'psKickDailyReward';
    const D_LOCK  = 'psKickDailyRewardLock';
    const D_POLL_IDLE_MS   = 60_000;
    const D_POLL_NEAR_MS   = 60_000;
    const D_CLAIM_JITTER_MS = 25_000;
    const D_ERROR_BACKOFF_MS = 30 * 60_000;
    const D_FALLBACK_RESET = { h: 0, m: 2 }; 
    let dailyRunning = false;
    let dailyStartupRetries = 15;

    const dailyClaimedNow = () => { const s = readState(D_STATE); return typeof s.claimedUntil === 'number' && Date.now() < s.claimedUntil; };
    const dailySchedule = (ms) => scheduleNext('daily', dailyCycle, ms, 1000, 6 * 60 * 60_000);

    function fallbackResetMs(from = Date.now()) {
        const d = new Date(from);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, D_FALLBACK_RESET.h, D_FALLBACK_RESET.m, 0, 0);
    }
    function dailyResetMs(ch) {
        const ends = ch && ch.window && ch.window.ends_at;
        const t = ends ? Date.parse(ends) : NaN;
        return Number.isFinite(t) ? t + 60_000 : fallbackResetMs();
    }

    function extractRewardInfo(obj) {
        if (!obj) return { image: null };
        let image = obj.card_url || obj.image_url || null;
        return { image: image };
    }

    function dailyRewardInfo(o) {
        try {
            const w = o && (o.winner || o.reward || (o.data && (o.data.winner || o.data.reward)));
            return extractRewardInfo(w);
        } catch (e) { return { image: null }; }
    }

    function getSavedRewardInfo() {
        const state = readState(D_STATE);
        return {
            image: state.lastRewardImage || null
        };
    }

    async function dailyCycle() {
        if (dailyRunning) return;
        
        if (dailyClaimedNow()) {
            updateBadge('claimed', '', getSavedRewardInfo());
            dailyStartupRetries = 0;
            return dailySchedule(readState(D_STATE).claimedUntil - Date.now());
        }
        
        if (inBackoff(D_STATE)) return dailySchedule(D_POLL_IDLE_MS);
        
        if (!loggedIn()) {
            if (dailyStartupRetries > 0) {
                dailyStartupRetries--;
                updateBadge('loading');
                return dailySchedule(1000);
            }
            updateBadge('error');
            return dailySchedule(D_POLL_IDLE_MS);
        }

        if (!acquireLock(D_LOCK)) return dailySchedule(D_POLL_NEAR_MS);

        dailyRunning = true;
        try {
            const r = await apiGet(EP_CHALLENGES);
            if (!r.ok) throw new Error('challenges HTTP ' + r.status);
            const j = await r.json();
            const list = Array.isArray(j) ? j : (j && (j.data || j.challenges)) || [];
            const ch = Array.isArray(list) ? list.find((c) => c && c.recurrence === 'daily') : null;

            if (!ch) { 
                if (dailyStartupRetries > 0) {
                    dailyStartupRetries--;
                    updateBadge('loading');
                    return dailySchedule(1000);
                }
                updateBadge('error');
                return dailySchedule(D_POLL_IDLE_MS); 
            }
            
            dailyStartupRetries = 0;
            const reset = dailyResetMs(ch);

            if (ch.status === 'claimed') {
                let info = dailyRewardInfo(ch);
                if (info.image) {
                    writeState(D_STATE, { claimedUntil: reset, lastRewardImage: info.image });
                } else {
                    writeState(D_STATE, { claimedUntil: reset });
                }
                updateBadge('claimed', '', getSavedRewardInfo());
                return dailySchedule(reset - Date.now());
            }

            if (ch.status === 'claimable') {
                updateBadge('ready');
                const jitter = Math.floor(Math.random() * D_CLAIM_JITTER_MS);
                refreshLock(D_LOCK);
                await new Promise((res) => setTimeout(res, jitter));
                
                if (dailyClaimedNow()) return dailySchedule(readState(D_STATE).claimedUntil - Date.now());
                if (!ownsLock(D_LOCK)) return dailySchedule(D_POLL_NEAR_MS);
                refreshLock(D_LOCK);
                try {
                    const cr = await apiPost(EP_CH_CLAIM(ch.id));
                    if (!cr.ok) throw new Error('claim HTTP ' + cr.status);
                    
                    let winnerInfo = { image: null };
                    try {
                        const r2 = await apiGet(EP_CHALLENGES);
                        if (r2.ok) {
                            const j2 = await r2.json();
                            const l2 = Array.isArray(j2) ? j2 : (j2 && (j2.data || j2.challenges)) || [];
                            const ch2 = Array.isArray(l2) ? l2.find((c) => c && c.recurrence === 'daily') : null;
                            winnerInfo = dailyRewardInfo(ch2);
                        }
                    } catch (e) {}
                    
                    if (!winnerInfo.image) {
                        winnerInfo = dailyRewardInfo(ch);
                    }
                    
                    writeState(D_STATE, { claimedUntil: reset, lastRewardImage: winnerInfo.image, lastClaimAt: Date.now(), backoffUntil: 0 });
                    
                    updateBadge('claimed', '', winnerInfo);
                    refreshRewardUI();
                    
                    return dailySchedule(reset - Date.now());
                } catch (e) {
                    updateBadge('error');
                    setBackoff(D_STATE, D_ERROR_BACKOFF_MS);
                    return dailySchedule(D_ERROR_BACKOFF_MS);
                }
            }
            
            const cond = ch.condition || {};
            const remaining = Math.max(0, (cond.threshold || 0) - (cond.progress || 0));
            updateBadge('progress', remaining);
            return dailySchedule(remaining > 0 && remaining <= 5 ? D_POLL_NEAR_MS : D_POLL_IDLE_MS);
        } catch (e) {
            if (dailyStartupRetries > 0) {
                dailyStartupRetries--;
                updateBadge('loading');
                return dailySchedule(1000);
            }
            updateBadge('error');
            setBackoff(D_STATE, D_ERROR_BACKOFF_MS);
            return dailySchedule(D_ERROR_BACKOFF_MS);
        } finally {
            dailyRunning = false;
            releaseLock(D_LOCK);
        }
    }

    const DR_STATE = 'psKickDrops';        
    const DR_LOCK  = 'psKickDropsLock';
    const DR_POLL_ACTIVE_MS = 60_000;   
    const DR_POLL_IDLE_MS   = 5 * 60_000;  
    const DR_ERROR_BACKOFF_MS = 30 * 60_000;
    let dropsRunning = false;

    const dropsSchedule = (ms) => scheduleNext('drops', dropsCycle, ms, 1000, 6 * 60 * 60_000);
    const isActiveCampaign = (c) => c && c.status !== 'expired' && c.status !== 'ended';
    const rewardEarned = (c, rw) =>
        rw && !rw.claimed &&
        ((typeof rw.required_units === 'number' && (c.progress_units || 0) >= rw.required_units) || rw.progress >= 1);

    async function dropsCycle() {
        if (dropsRunning) return;
        if (inBackoff(DR_STATE)) return dropsSchedule(DR_POLL_IDLE_MS);
        if (!loggedIn())         return dropsSchedule(DR_POLL_IDLE_MS);
        if (!acquireLock(DR_LOCK)) return dropsSchedule(DR_POLL_ACTIVE_MS);

        dropsRunning = true;
        try {
            const r = await apiGet(EP_DROPS);
            if (!r.ok) throw new Error('drops HTTP ' + r.status);
            const j = await r.json();
            const campaigns = (j && j.data) || [];
            const active = campaigns.filter(isActiveCampaign);

            let anyClaimed = false;

            for (const c of active) {
                for (const rw of (c.rewards || [])) {
                    if (rw.claimed) continue;
                    if (!rewardEarned(c, rw)) continue; 
                    refreshLock(DR_LOCK);
                    try {
                        const cr = await apiPost(EP_DROPS_CLAIM, { reward_id: rw.id, campaign_id: c.id });
                        if (cr.ok) { 
                            anyClaimed = true; 
                            log(`[drops] Claimed: "${rw.name}"`);
                        }
                    } catch (e) {}
                }
            }

            if (anyClaimed) writeState(DR_STATE, { backoffUntil: 0 });
            return dropsSchedule(active.length ? DR_POLL_ACTIVE_MS : DR_POLL_IDLE_MS);
        } catch (e) {
            setBackoff(DR_STATE, DR_ERROR_BACKOFF_MS);
            return dropsSchedule(DR_ERROR_BACKOFF_MS);
        } finally {
            dropsRunning = false;
            releaseLock(DR_LOCK);
        }
    }

    function start() {
        const s = readState(D_STATE);
        updateBadge('loading'); 
        
        if (s.claimedUntil && Date.now() < s.claimedUntil) {
            updateBadge('claimed', '', getSavedRewardInfo());
            dailySchedule(s.claimedUntil - Date.now());
        } else {
            dailySchedule(1000);
        }
        dropsSchedule(6000 + Math.floor(Math.random() * 4000));
    }

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();