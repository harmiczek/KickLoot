// Listens for messages from the content script to update the extension icon badge globally
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_BADGE') {
        chrome.action.setBadgeText({ text: message.text || '' });
        chrome.action.setBadgeBackgroundColor({ color: message.color || '#555555' });
        
        if (message.tooltip) {
            chrome.action.setTitle({ title: message.tooltip });
        }
        
        chrome.storage.local.set({
            kickLootState: {
                status: message.status,
                val: message.val,
                tooltip: message.tooltip,
                rewardInfo: message.rewardInfo
            }
        });
    }
});