// Bridge for page -> extension background script communication
window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    
    if (event.data && event.data.source === 'KICK_AUTO_CLAIM' && event.data.type === 'UPDATE_BADGE') {
        try {
            chrome.runtime.sendMessage({
                type: 'UPDATE_BADGE',
                status: event.data.status,
                val: event.data.val,
                text: event.data.text,
                color: event.data.color,
                tooltip: event.data.tooltip,
                rewardInfo: event.data.rewardInfo
            });
        } catch (e) {}
    }
});

const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);